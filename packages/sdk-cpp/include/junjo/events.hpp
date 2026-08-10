// Junjo.io SDK for C++
//
// Live event subscriptions over SSE (GET /v1/events/:groupId).
// Obtained via Client::events(); the returned value shares the
// client's internals, so it stays valid independently of the Client
// object it came from.
//
// Model: subscribe() opens the stream, blocks until the server accepts
// or rejects the connection (so 401 / 404 come back as the call's
// Error, mirroring the TS SDK), and on success returns a Subscription
// that owns ONE dedicated thread reading the stream. Every callback
// runs on that thread.
//
// There is NO auto-reconnect and the server keeps NO replay buffer:
// events that occur between a disconnect and a resubscribe are lost.
// When on_close or on_error fires, the subscription is already
// finished; resubscribe by calling subscribe() again and reconcile
// any state you must not miss by re-fetching it.
#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "junjo/cancellation.hpp"
#include "junjo/error.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"

namespace junjo {

namespace detail {
class RequestExecutor;
struct SubscriptionState;
}  // namespace detail

class Client;

// One event delivered by a subscription. The SDK hands over the raw
// JSON payload rather than a deserialized union: game servers usually
// switch on the type string and pick a handful of fields, and a raw
// payload never goes stale against a newer server.
struct SseEvent {
  // The frame's event name (the server sets it to the payload's type
  // string, e.g. "member.joined").
  std::string event_type;
  // The frame's event id (the server sets it to the event's unique
  // id). Useful for logging; there is no replay to feed it back into.
  std::string event_id;
  // The event as JSON text, exactly as sent. Guaranteed to parse as
  // JSON (a payload that does not is a stream error, see on_error)
  // with a type string the SDK knows; the schema of each type is
  // documented by the server contract (packages/shared).
  std::string payload_json;
};

// Options for EventsApi::subscribe. on_event is required; the rest
// default to "not interested".
//
// Callback threading: every callback runs on the subscription's
// dedicated stream thread, one at a time, never concurrently with
// itself or the others. Keep them quick; the stream is not read while
// a callback runs. Callbacks must not throw; a throwing on_event is
// caught and treated as a stream error (on_error, then termination)
// rather than being allowed to unwind through transport internals.
struct SubscribeOptions {
  // Called for every event. Frames whose payload carries an event
  // type this SDK version does not know are skipped silently (a newer
  // server must not break older clients; TS SDK parity), as are the
  // server's heartbeat comments.
  std::function<void(const SseEvent& event)> on_event;
  // Called at most once, when the stream dies after a successful
  // subscribe: a network drop, a malformed frame, an unparseable
  // payload, or frame-buffer overflow (ErrorCode::StreamOverflow).
  // The subscription is finished before this fires; resubscribe to
  // continue. Not called for close() or token cancellation.
  std::function<void(const Error& error)> on_error;
  // Called at most once, when the SERVER ends the stream cleanly (a
  // deploy, a proxy idle timeout). The subscription is finished
  // before this fires. Not called for close(), token cancellation, or
  // error terminations.
  std::function<void()> on_close;
  // Cancelling behaves like close() observed from the stream's next
  // progress poll: the stream ends silently (no on_close, no
  // on_error, matching the TS SDK's abort semantics). A token already
  // cancelled at subscribe() time fails the call with Cancelled
  // before anything is sent.
  CancellationToken token;
  // Per-subscription override of the client-level timeout, applied to
  // the connect phase only (the established stream is exempt from any
  // whole-request timeout). A value <= 0 disables the connect timeout
  // for this subscription.
  std::optional<std::chrono::milliseconds> timeout;
};

// Handle for one open event stream. Move-only; the destructor closes.
//
// close() is IDEMPOTENT and BLOCKING: it signals the stream to stop,
// then joins the stream thread, so when close() returns it is
// guaranteed that no callback is running and none will ever run
// again. That is the strongest guarantee that makes teardown safe:
// after close() you may destroy anything your callbacks capture.
//
// The one exception is calling close() from inside a callback (that
// is, from the stream thread itself): joining would self-deadlock, so
// close() detects it, signals the stop, and returns WITHOUT joining.
// The current callback is the last one (the stream unwinds as soon as
// it returns), but the thread is still finishing as close() returns,
// so the "nothing running after close()" guarantee is waived for that
// one call; any later close() or the destructor, run from another
// thread, joins (and thereby restores) it. State captured by the
// callbacks stays alive until the thread finishes regardless (the
// thread shares ownership), so a from-callback close is safe; just do
// not tear down callback captures from inside the callback itself.
// Destroying the handle on the stream thread (a callback that owns
// it) is also handled: the destructor detaches instead of joining.
// Move-assigning over an open handle closes its current stream first
// under the same rules before adopting the new one.
class JUNJO_API Subscription {
 public:
  Subscription(Subscription&& other) noexcept;
  Subscription& operator=(Subscription&& other) noexcept;
  Subscription(const Subscription&) = delete;
  Subscription& operator=(const Subscription&) = delete;

  // Equivalent to close().
  ~Subscription();

  // Ends the stream. Safe from any thread and from callbacks (see the
  // class comment for the exact guarantees); idempotent, and every
  // concurrent caller blocks until the stream thread is joined (or
  // returns immediately once it has been).
  void close();

 private:
  friend class EventsApi;
  explicit Subscription(std::shared_ptr<detail::SubscriptionState> state) noexcept;

  // Closes and drops the current state; see the definition for the
  // same-thread detach obligation it upholds.
  void release_state() noexcept;

  std::shared_ptr<detail::SubscriptionState> state_;
};

// Event-stream operations. Cheap to copy (shares the client's
// executor); thread-safe to the same degree as the Client it came
// from.
class JUNJO_API EventsApi {
 public:
  // Opens the group's live event stream. Blocks until the server
  // accepts (2xx) or rejects the connection: a rejection (invalid
  // key, unknown group), a connect failure, a pre-connect
  // cancellation, or a non-streaming transport (InvalidConfig) is
  // returned as this call's Error and no callback ever fires. On
  // success, events flow to options.on_event on a dedicated thread
  // until the subscription ends; see SubscribeOptions and
  // Subscription for the callback and teardown contracts.
  [[nodiscard]] Result<Subscription> subscribe(std::string_view group_id,
                                               SubscribeOptions options) const;

 private:
  friend class Client;
  explicit EventsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
