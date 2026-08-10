// Junjo.io SDK for C++: SSE subscriptions over a scripted streaming
// transport: the subscribe handshake, event dispatch, TS-parity skip
// rules, and the termination callbacks.
#include <doctest/doctest.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <junjo/cancellation.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/events.hpp>
#include <junjo/result.hpp>

#include "mock_stream_transport.hpp"
#include "mock_transport.hpp"
#include "sse_parser.hpp"
#include "test_support.hpp"

using junjo::CancellationSource;
using junjo::Client;
using junjo::ClientConfig;
using junjo::Error;
using junjo::ErrorCode;
using junjo::Result;
using junjo::SseEvent;
using junjo::SubscribeOptions;
using junjo::Subscription;
using junjo::test::kTestKey;
using junjo::test::MockStreamTransport;
using junjo::test::MockTransport;

namespace {

// Spin-waits (with sleeps) for `pred` to become true; false on
// timeout. The stream thread is real, so tests observe it
// asynchronously.
template <typename Pred>
[[nodiscard]] bool wait_until(Pred pred,
                              std::chrono::milliseconds limit = std::chrono::seconds(5)) {
  const auto deadline = std::chrono::steady_clock::now() + limit;
  while (!pred()) {
    if (std::chrono::steady_clock::now() > deadline) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return true;
}

// One SSE frame the way the server writes it (hono streamSSE: event,
// id, then data, LF line endings).
[[nodiscard]] std::string frame(const std::string& type, const std::string& id,
                                const std::string& payload) {
  return "event: " + type + "\nid: " + id + "\ndata: " + payload + "\n\n";
}

[[nodiscard]] std::string member_joined(int n) {
  const std::string id = "evt_" + std::to_string(n);
  return frame("member.joined", id, R"({"type":"member.joined","id":")" + id + R"("})");
}

// A Client over a MockStreamTransport plus thread-safe callback
// recording.
struct StreamHarness {
  std::shared_ptr<MockStreamTransport> transport = std::make_shared<MockStreamTransport>();
  Client client;

  std::mutex mutex;
  std::vector<SseEvent> events;
  std::vector<Error> errors;
  std::atomic<int> close_count{0};

  StreamHarness()
      : client([this] {
          Result<Client> created =
              Client::create({.api_key = kTestKey, .transport = transport});
          REQUIRE(created.has_value());
          return std::move(created).value();
        }()) {}

  [[nodiscard]] SubscribeOptions options() {
    SubscribeOptions opts;
    opts.on_event = [this](const SseEvent& event) {
      const std::lock_guard<std::mutex> lock(mutex);
      events.push_back(event);
    };
    opts.on_error = [this](const Error& error) {
      const std::lock_guard<std::mutex> lock(mutex);
      errors.push_back(error);
    };
    opts.on_close = [this] { close_count.fetch_add(1); };
    return opts;
  }

  [[nodiscard]] std::size_t event_count() {
    const std::lock_guard<std::mutex> lock(mutex);
    return events.size();
  }
  [[nodiscard]] std::size_t error_count() {
    const std::lock_guard<std::mutex> lock(mutex);
    return errors.size();
  }
};

}  // namespace

TEST_CASE("subscribe delivers events and a clean server end fires on_close") {
  StreamHarness h;
  h.transport->chunks = {":heartbeat\n\n", member_joined(1), member_joined(2)};

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.close_count.load() == 1; }));
  sub.value().close();

  REQUIRE(h.event_count() == 2);
  const std::lock_guard<std::mutex> lock(h.mutex);
  CHECK(h.events[0].event_type == "member.joined");
  CHECK(h.events[0].event_id == "evt_1");
  CHECK(h.events[0].payload_json == R"({"type":"member.joined","id":"evt_1"})");
  CHECK(h.events[1].event_id == "evt_2");
  CHECK(h.errors.empty());
  CHECK(h.close_count.load() == 1);
}

TEST_CASE("the subscribe request carries auth, accept, and the encoded group id") {
  StreamHarness h;
  h.transport->chunks = {};

  Result<Subscription> sub = h.client.events().subscribe("grp 1/x", h.options());
  REQUIRE(sub.has_value());
  sub.value().close();

  const auto& recorded = h.transport->recorded();
  REQUIRE(recorded.size() == 1);
  CHECK(recorded[0].method == "GET");
  CHECK(recorded[0].url == "https://api.junjo.io/v1/events/grp%201%2Fx");
  REQUIRE(recorded[0].headers.size() == 2);
  CHECK(recorded[0].headers[0].first == "authorization");
  CHECK(recorded[0].headers[1] ==
        std::pair<std::string, std::string>("accept", "text/event-stream"));
  // The client timeout rides along for the transport's CONNECT phase
  // only; the body is exempt by contract.
  REQUIRE(recorded[0].timeout.has_value());
  CHECK(recorded[0].timeout->count() == 30000);
}

TEST_CASE("a non-2xx response surfaces as the subscribe error, not a callback") {
  StreamHarness h;
  h.transport->status = 404;
  h.transport->response_headers = {{"x-request-id", "req_9"}};
  h.transport->chunks = {junjo::test::kNotFoundJson};

  Result<Subscription> sub = h.client.events().subscribe("grp_missing", h.options());
  REQUIRE_FALSE(sub.has_value());
  CHECK(sub.error().code == ErrorCode::NotFound);
  CHECK(sub.error().status == 404);
  CHECK(sub.error().message == "no such thing");
  // The rejection never reaches the callbacks, and no stream thread
  // survives the failed call.
  CHECK(h.event_count() == 0);
  CHECK(h.error_count() == 0);
  CHECK(h.close_count.load() == 0);
  CHECK(h.transport->active_streams() == 0);
}

TEST_CASE("unknown payload event types are skipped silently") {
  StreamHarness h;
  h.transport->chunks = {
      frame("member.promoted", "evt_new",
            R"({"type":"member.promoted","fancy":true})"),
      frame("member.joined", "evt_untyped", R"({"noType":1})"),
      frame("member.joined", "evt_scalar", "42"),
      member_joined(1),
  };

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.close_count.load() == 1; }));
  sub.value().close();

  // Only the known-type frame arrived; the newer-server frame, the
  // type-less object, and the non-object payload were all skipped
  // without killing the stream (TS parity).
  REQUIRE(h.event_count() == 1);
  const std::lock_guard<std::mutex> lock(h.mutex);
  CHECK(h.events[0].event_id == "evt_1");
  CHECK(h.errors.empty());
}

TEST_CASE("frames without data are skipped") {
  StreamHarness h;
  h.transport->chunks = {"event: member.joined\nid: evt_nodata\n\n", member_joined(1)};

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.close_count.load() == 1; }));
  sub.value().close();
  CHECK(h.event_count() == 1);
}

TEST_CASE("a payload that is not JSON is a stream error") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1),
                         frame("member.joined", "evt_bad", "{not json"),
                         member_joined(2)};

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.error_count() == 1; }));
  sub.value().close();

  const std::lock_guard<std::mutex> lock(h.mutex);
  CHECK(h.errors[0].code == ErrorCode::InvalidWireData);
  // The stream died at the malformed frame: the earlier event
  // arrived, the later one did not, and there is no on_close.
  CHECK(h.events.size() == 1);
  CHECK(h.close_count.load() == 0);
}

TEST_CASE("frame-buffer overflow reports StreamOverflow") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1),
                         std::string(junjo::detail::SseParser::kMaxBufferBytes + 1, 'x')};

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.error_count() == 1; }));
  sub.value().close();

  const std::lock_guard<std::mutex> lock(h.mutex);
  CHECK(h.errors[0].code == ErrorCode::StreamOverflow);
  CHECK(junjo::to_string(h.errors[0].code) == "stream_overflow");
  CHECK(h.events.size() == 1);
  CHECK(h.close_count.load() == 0);
}

TEST_CASE("a mid-stream network drop reports on_error") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  h.transport->terminal = Error{.code = ErrorCode::NetworkError, .message = "connection reset"};

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.error_count() == 1; }));
  sub.value().close();

  const std::lock_guard<std::mutex> lock(h.mutex);
  CHECK(h.errors[0].code == ErrorCode::NetworkError);
  CHECK(h.events.size() == 1);
  CHECK(h.close_count.load() == 0);
}

TEST_CASE("close() ends an open stream silently and is idempotent") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  h.transport->hold_open_until_cancelled = true;

  Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.event_count() == 1; }));

  sub.value().close();
  // BLOCKING close: the stream thread is gone when close() returns.
  CHECK(h.transport->active_streams() == 0);
  sub.value().close();

  // User-initiated end: neither on_close nor on_error.
  CHECK(h.close_count.load() == 0);
  CHECK(h.error_count() == 0);
}

TEST_CASE("the destructor closes like close()") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  h.transport->hold_open_until_cancelled = true;
  {
    Result<Subscription> sub = h.client.events().subscribe("grp_1", h.options());
    REQUIRE(sub.has_value());
    REQUIRE(wait_until([&] { return h.event_count() == 1; }));
  }
  CHECK(h.transport->active_streams() == 0);
  CHECK(h.close_count.load() == 0);
  CHECK(h.error_count() == 0);
}

TEST_CASE("a token already cancelled rejects subscribe before any request") {
  StreamHarness h;
  CancellationSource source;
  source.request_cancellation();
  SubscribeOptions opts = h.options();
  opts.token = source.token();

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE_FALSE(sub.has_value());
  CHECK(sub.error().code == ErrorCode::Cancelled);
  CHECK(h.transport->recorded().empty());
}

TEST_CASE("cancelling the caller token mid-stream ends the stream silently") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  h.transport->hold_open_until_cancelled = true;
  CancellationSource source;
  SubscribeOptions opts = h.options();
  opts.token = source.token();

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.event_count() == 1; }));

  source.request_cancellation();
  REQUIRE(wait_until([&] { return h.transport->active_streams() == 0; }));

  // TS abort parity: user-initiated, so no on_close and no on_error.
  CHECK(h.close_count.load() == 0);
  CHECK(h.error_count() == 0);
  sub.value().close();
}

TEST_CASE("subscribe without on_event fails with InvalidConfig") {
  StreamHarness h;
  SubscribeOptions opts;
  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE_FALSE(sub.has_value());
  CHECK(sub.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->recorded().empty());
}

TEST_CASE("a transport without streaming support fails subscribe with InvalidConfig") {
  // MockTransport predates streaming and does not override
  // execute_stream, so it exercises the source-compatibility default.
  junjo::test::Harness h;
  std::atomic<int> event_count{0};
  SubscribeOptions opts;
  opts.on_event = [&event_count](const SseEvent&) { event_count.fetch_add(1); };

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE_FALSE(sub.has_value());
  CHECK(sub.error().code == ErrorCode::InvalidConfig);
  CHECK(event_count.load() == 0);
}

TEST_CASE("a throwing on_event tears the stream down as an error") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1), member_joined(2)};
  SubscribeOptions opts = h.options();
  opts.on_event = [&h](const SseEvent& event) {
    {
      const std::lock_guard<std::mutex> lock(h.mutex);
      h.events.push_back(event);
    }
    throw std::runtime_error("consumer bug");
  };

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.error_count() == 1; }));
  sub.value().close();

  // The throw stopped the stream after the first event.
  CHECK(h.event_count() == 1);
  CHECK(h.close_count.load() == 0);
}

TEST_CASE("a throwing on_error is swallowed") {
  // Terminal callbacks run on the stream thread; anything they throw
  // must be absorbed there or it would terminate the process.
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  h.transport->terminal = Error{.code = ErrorCode::NetworkError, .message = "connection reset"};
  SubscribeOptions opts = h.options();
  opts.on_error = [&h](const Error& error) {
    {
      const std::lock_guard<std::mutex> lock(h.mutex);
      h.errors.push_back(error);
    }
    throw std::runtime_error("consumer bug");
  };

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.error_count() == 1; }));
  sub.value().close();

  CHECK(h.transport->active_streams() == 0);
  CHECK(h.event_count() == 1);
  CHECK(h.close_count.load() == 0);
}

TEST_CASE("a throwing on_close is swallowed") {
  StreamHarness h;
  h.transport->chunks = {member_joined(1)};
  SubscribeOptions opts = h.options();
  opts.on_close = [&h] {
    h.close_count.fetch_add(1);
    throw std::runtime_error("consumer bug");
  };

  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return h.close_count.load() == 1; }));
  sub.value().close();

  CHECK(h.transport->active_streams() == 0);
  CHECK(h.event_count() == 1);
  CHECK(h.error_count() == 0);
}

TEST_CASE("a per-subscription timeout overrides the client default for the connect phase") {
  StreamHarness h;
  h.transport->chunks = {};

  SubscribeOptions opts = h.options();
  opts.timeout = std::chrono::milliseconds(5000);
  Result<Subscription> sub = h.client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  sub.value().close();

  // A <= 0 override disables the connect timeout entirely.
  SubscribeOptions disabled = h.options();
  disabled.timeout = std::chrono::milliseconds(0);
  Result<Subscription> sub2 = h.client.events().subscribe("grp_1", std::move(disabled));
  REQUIRE(sub2.has_value());
  sub2.value().close();

  const auto& recorded = h.transport->recorded();
  REQUIRE(recorded.size() == 2);
  REQUIRE(recorded[0].timeout.has_value());
  CHECK(recorded[0].timeout->count() == 5000);
  CHECK_FALSE(recorded[1].timeout.has_value());
}
