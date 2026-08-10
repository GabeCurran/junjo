// Junjo.io SDK for C++
//
// SSE subscription machinery: the dedicated stream thread, the open
// handshake, and the teardown rules documented in junjo/events.hpp.
// The frame parsing itself lives in sse_parser.{hpp,cpp}.

#include "junjo/events.hpp"

#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "junjo/transport.hpp"

#include "json.hpp"
#include "request_executor.hpp"
#include "sse_parser.hpp"
#include "url.hpp"

namespace junjo {

namespace detail {

namespace {

// Event types this SDK version knows, matching the TS SDK's wire
// event union (packages/sdk/src/events.ts). Frames whose payload
// carries any other type string are skipped silently so a newer
// server cannot break older clients (TS parity: deserializeEvent's
// unknown_event_type path).
constexpr std::array<std::string_view, 22> kKnownEventTypes{
    "member.joined",
    "member.left",
    "member.invited",
    "member.banned",
    "member.unbanned",
    "role.created",
    "role.changed",
    "role.deleted",
    "permission.granted",
    "permission.revoked",
    "group.updated",
    "group.deleted",
    "group.relationship.changed",
    "friend.request.sent",
    "friend.request.accepted",
    "friend.request.declined",
    "friend.request.cancelled",
    "friend.removed",
    "friend.blocked",
    "friend.unblocked",
    "game.user.banned",
    "game.user.unbanned",
};

[[nodiscard]] bool is_known_event_type(std::string_view type) noexcept {
  for (const std::string_view known : kKnownEventTypes) {
    if (known == type) return true;
  }
  return false;
}

// Cap on a buffered rejection body (the error envelope of a non-2xx
// response). Envelopes are tiny; anything near this is not one.
constexpr std::size_t kMaxRejectBodyBytes = 64 * 1024;

}  // namespace

// Shared between the Subscription handle, the stream thread (which
// co-owns it, so a detached self-close cannot leave the thread with a
// dangling state), and subscribe() during the open handshake.
struct SubscriptionState {
  // User callbacks and token; immutable after subscribe().
  SubscribeOptions options;
  std::shared_ptr<Transport> transport;
  HttpRequest request;

  // close() cancels this; the stream watches the merged token.
  CancellationSource close_source;
  CancellationToken stream_token;

  // Set by close() (and observed together with options.token) before
  // any join/detach, so the stream thread suppresses further
  // callbacks the moment a user-initiated stop begins.
  std::atomic<bool> closed{false};

  // The stream thread's id, stored by the thread itself before any
  // callback can run; lets close() detect a call from a callback.
  std::atomic<std::thread::id> thread_id{};

  // Guards `thread` against concurrent join/detach.
  std::mutex thread_mutex;
  std::thread thread;

  // Open handshake: subscribe() blocks until open_done; open_error
  // carries the rejection when the connection was not accepted.
  std::mutex open_mutex;
  std::condition_variable open_cv;
  bool open_done = false;
  std::optional<Error> open_error;
};

namespace {

// The StreamHandler driving one subscription. Lives on the stream
// thread's stack; every method runs on that thread.
class SubscriptionStreamHandler final : public StreamHandler {
 public:
  explicit SubscriptionStreamHandler(SubscriptionState& state) : state_(state) {}

  [[nodiscard]] bool on_open(const HttpResponse& head) override {
    if (head.status >= 200 && head.status < 300) {
      accepted_ = true;
      {
        const std::lock_guard<std::mutex> lock(state_.open_mutex);
        state_.open_done = true;
      }
      state_.open_cv.notify_all();
      return true;
    }
    // Rejected: keep reading so the error envelope body arrives, then
    // build the Error once the (content-length bounded) response ends.
    reject_ = head;
    return true;
  }

  [[nodiscard]] bool on_data(std::string_view chunk) override {
    if (!accepted_) {
      // Collecting a rejection body. Cap it: an "error envelope" that
      // large is not one, and what is already buffered still yields
      // the right status-derived Error.
      if (reject_->body.size() >= kMaxRejectBodyBytes) return false;
      reject_->body.append(chunk.substr(0, kMaxRejectBodyBytes - reject_->body.size()));
      return true;
    }
    if (state_.closed.load(std::memory_order_acquire)) return false;

    std::vector<SseFrame> frames;
    if (parser_.feed(chunk, frames) == SseParser::FeedStatus::Overflow) {
      terminal_error_ = Error{
          .code = ErrorCode::StreamOverflow,
          .message = "SSE frame exceeded 1 MiB without a delimiter"};
      return false;
    }
    for (SseFrame& frame : frames) {
      if (state_.closed.load(std::memory_order_acquire)) return false;
      // Frames without data carry nothing to dispatch (TS parity).
      if (!frame.data.has_value()) continue;
      const std::optional<Json> payload = parse_json(*frame.data);
      if (!payload.has_value()) {
        terminal_error_ = Error{.code = ErrorCode::InvalidWireData,
                                .message = "SSE event payload was not valid JSON"};
        return false;
      }
      // The payload's own type string decides dispatch, exactly as in
      // the TS SDK (the frame's event: line is informational). A
      // missing or unknown type skips the frame silently.
      const auto type_it = payload->find("type");
      if (!payload->is_object() || type_it == payload->end() || !type_it->is_string()) {
        continue;
      }
      if (!is_known_event_type(type_it->get_ref<const std::string&>())) continue;

      SseEvent event;
      event.event_type = frame.event.has_value() ? std::move(*frame.event) : std::string();
      event.event_id = frame.id.has_value() ? std::move(*frame.id) : std::string();
      event.payload_json = std::move(*frame.data);
      try {
        state_.options.on_event(event);
      } catch (...) {
        // A throwing callback must not unwind through the transport's
        // C callback frames; treat it as a stream error (TS parity:
        // a throwing handler tears the subscription down).
        terminal_error_ = Error{.code = ErrorCode::Unknown,
                                .message = "on_event callback threw; subscription closed"};
        return false;
      }
    }
    return true;
  }

  void on_complete(const Result<void>&) override {
    // Terminal dispatch happens after execute_stream returns (in
    // run_subscription), where the transport result and the handler
    // outcome combine.
  }

  [[nodiscard]] bool accepted() const noexcept { return accepted_; }
  [[nodiscard]] const std::optional<HttpResponse>& rejection() const noexcept { return reject_; }
  [[nodiscard]] const std::optional<Error>& terminal_error() const noexcept {
    return terminal_error_;
  }

 private:
  SubscriptionState& state_;
  SseParser parser_;
  bool accepted_ = false;
  std::optional<HttpResponse> reject_;
  std::optional<Error> terminal_error_;
};

// Invokes a user callback, swallowing anything it throws: by this
// point the subscription is finished either way, and an exception
// escaping a thread function would terminate the process.
template <typename Fn>
void invoke_guarded(const Fn& fn) noexcept {
  try {
    fn();
  } catch (...) {
  }
}

// The stream thread. Owns a share of the state so a detached
// self-close keeps everything alive until this returns.
void run_subscription(const std::shared_ptr<SubscriptionState>& state) {
  state->thread_id.store(std::this_thread::get_id(), std::memory_order_release);

  SubscriptionStreamHandler handler(*state);
  const Result<void> result =
      state->transport->execute_stream(state->request, handler, state->stream_token);

  if (!handler.accepted()) {
    // The connection was never accepted; subscribe() is blocked
    // waiting for the verdict. No user callback fires on this path.
    Error err;
    if (handler.rejection().has_value()) {
      err = envelope_error(*handler.rejection());
    } else if (!result.has_value()) {
      err = result.error();
    } else {
      err = Error{.code = ErrorCode::NetworkError,
                  .message = "stream ended before a response arrived"};
    }
    {
      const std::lock_guard<std::mutex> lock(state->open_mutex);
      state->open_error = std::move(err);
      state->open_done = true;
    }
    state->open_cv.notify_all();
    return;
  }

  // Post-open termination. User-initiated stops (close() or the
  // caller's token) end silently: the consumer initiated them, so
  // there is nothing to notify (TS parity with abort semantics).
  const bool user_closed =
      state->closed.load(std::memory_order_acquire) || state->options.token.is_cancelled();
  if (user_closed) return;

  if (handler.terminal_error().has_value()) {
    if (state->options.on_error) {
      invoke_guarded([&] { state->options.on_error(*handler.terminal_error()); });
    }
    return;
  }
  if (result.has_value()) {
    // The SERVER ended the stream cleanly.
    if (state->options.on_close) {
      invoke_guarded([&] { state->options.on_close(); });
    }
    return;
  }
  if (result.error().code == ErrorCode::Cancelled) {
    // The merged token fired without closed/token observed above:
    // a teardown race; stay silent like any user-initiated stop.
    return;
  }
  if (state->options.on_error) {
    invoke_guarded([&] { state->options.on_error(result.error()); });
  }
}

}  // namespace

}  // namespace detail

Subscription::Subscription(std::shared_ptr<detail::SubscriptionState> state) noexcept
    : state_(std::move(state)) {}

Subscription::Subscription(Subscription&& other) noexcept : state_(std::move(other.state_)) {}

Subscription& Subscription::operator=(Subscription&& other) noexcept {
  if (this != &other) {
    release_state();
    state_ = std::move(other.state_);
  }
  return *this;
}

Subscription::~Subscription() { release_state(); }

// Ends the current stream and drops this handle's share of its state.
// When the handle is released ON the stream thread (a callback owned
// or reassigned it), close() above could not join; detach so the
// still-joinable std::thread member cannot terminate the process when
// the thread (which co-owns the state) later destroys it. Releasing
// the handle concurrently with other calls on it is a user error on
// any C++ object, so no closer can be inside the mutex-guarded join
// here. Shared by the destructor and move assignment; both must give
// up state_ through this path, never by plain overwrite.
void Subscription::release_state() noexcept {
  if (state_ == nullptr) return;
  close();
  if (std::this_thread::get_id() == state_->thread_id.load(std::memory_order_acquire)) {
    const std::lock_guard<std::mutex> lock(state_->thread_mutex);
    if (state_->thread.joinable()) state_->thread.detach();
  }
  state_.reset();
}

void Subscription::close() {
  if (state_ == nullptr) return;
  // Keep the state alive across the whole call even if this handle is
  // being destroyed concurrently with a callback-side close.
  const std::shared_ptr<detail::SubscriptionState> state = state_;

  // Order matters: the closed flag first (suppresses further
  // callbacks the moment the stream observes it), then the token (the
  // transport's poll unblocks the stream).
  state->closed.store(true, std::memory_order_release);
  state->close_source.request_cancellation();

  if (std::this_thread::get_id() == state->thread_id.load(std::memory_order_acquire)) {
    // close() from inside a callback: joining would self-deadlock, and
    // even TOUCHING thread_mutex here could deadlock against a
    // concurrent closer that holds it across join() below (the join
    // would wait for this thread while this thread waits for the
    // mutex). So the callback path only signals: the stream unwinds as
    // soon as the current callback returns (closed is checked on this
    // same thread before every dispatch), and the thread is reaped by
    // any later or concurrent close()/destructor on another thread.
    // See the header for the waived blocking guarantee.
    return;
  }

  // Joining under the mutex is what makes concurrent close() calls all
  // block until the thread is really gone (the losers wait on the
  // mutex while the winner joins), which is the guarantee the header
  // promises.
  const std::lock_guard<std::mutex> lock(state->thread_mutex);
  if (state->thread.joinable()) state->thread.join();
}

EventsApi::EventsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Subscription> EventsApi::subscribe(std::string_view group_id,
                                          SubscribeOptions options) const {
  if (!options.on_event) {
    return Error{.code = ErrorCode::InvalidConfig,
                 .message = "SubscribeOptions.on_event is required"};
  }
  // A token already cancelled means the caller gave up before the
  // connection attempt; refuse to open one at all (TS parity).
  if (options.token.is_cancelled()) {
    return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
  }

  const detail::RequestExecutor::Config& config = executor_->config();
  auto state = std::make_shared<detail::SubscriptionState>();
  state->options = std::move(options);
  state->transport = config.transport;
  state->request.method = "GET";
  state->request.url = config.base_url + "/v1/events/" + detail::percent_encode(group_id);
  state->request.headers.emplace_back("authorization", "Bearer " + config.api_key);
  state->request.headers.emplace_back("accept", "text/event-stream");
  // Streams are exempt from the whole-request timeout; the transport
  // applies this to the connect phase only (see execute_stream). The
  // per-subscription override, when set, replaces the client default
  // (<= 0 disables it), matching every buffered call's timeout field.
  const std::chrono::milliseconds effective_timeout =
      state->options.timeout.has_value() ? *state->options.timeout : config.timeout;
  if (effective_timeout.count() > 0) {
    state->request.timeout = effective_timeout;
  }
  state->stream_token =
      CancellationToken::any_of(state->options.token, state->close_source.token());

  {
    const std::lock_guard<std::mutex> lock(state->thread_mutex);
    state->thread = std::thread(detail::run_subscription, state);
  }

  // Block until the server accepts or rejects the connection, so 401
  // and 404 come back from THIS call and no callback ever fires for a
  // subscription that never existed.
  std::unique_lock<std::mutex> lock(state->open_mutex);
  state->open_cv.wait(lock, [&state] { return state->open_done; });
  const std::optional<Error> open_error = state->open_error;
  lock.unlock();

  if (open_error.has_value()) {
    // The stream thread is finishing (it signals failure as its last
    // act); join it so no thread outlives this call on the error path.
    {
      const std::lock_guard<std::mutex> thread_lock(state->thread_mutex);
      if (state->thread.joinable()) state->thread.join();
    }
    return *open_error;
  }
  return Subscription(std::move(state));
}

}  // namespace junjo
