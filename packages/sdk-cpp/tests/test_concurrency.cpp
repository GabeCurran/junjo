// Junjo.io SDK for C++: concurrency hardening: destruction during
// in-flight work, callback/close races, close() from a callback, and
// executor stress. These tests use real threads; every wait is
// bounded so a regression fails instead of hanging CI.
#include <doctest/doctest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <junjo/cancellation.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/events.hpp>
#include <junjo/executor.hpp>
#include <junjo/groups.hpp>
#include <junjo/result.hpp>
#include <junjo/transport.hpp>

#include "mock_stream_transport.hpp"
#include "mock_transport.hpp"
#include "sse_parser.hpp"
#include "test_support.hpp"

using junjo::CancellationSource;
using junjo::Client;
using junjo::Group;
using junjo::GroupsApi;
using junjo::Result;
using junjo::SseEvent;
using junjo::SubscribeOptions;
using junjo::Subscription;
using junjo::ThreadPoolExecutor;
using junjo::test::kTestKey;
using junjo::test::MockStreamTransport;
using junjo::test::MockTransport;

namespace {

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

[[nodiscard]] std::string member_joined_frame(int n) {
  const std::string id = "evt_" + std::to_string(n);
  return "event: member.joined\nid: " + id +
         "\ndata: {\"type\":\"member.joined\",\"id\":\"" + id + "\"}\n\n";
}

[[nodiscard]] Client make_client(std::shared_ptr<junjo::Transport> transport) {
  Result<Client> created = Client::create({.api_key = kTestKey, .transport = std::move(transport)});
  REQUIRE(created.has_value());
  return std::move(created).value();
}

}  // namespace

TEST_CASE("surface handles stay valid after the Client is destroyed") {
  auto transport = std::make_shared<MockTransport>();
  transport->enqueue_json(200, junjo::test::kGroupJson);

  std::optional<GroupsApi> groups;
  {
    const Client client = make_client(transport);
    groups = client.groups();
  }
  // The Client is gone; the surface still shares the executor.
  Result<std::optional<Group>> result = groups->get("grp_1");
  REQUIRE(result.has_value());
  REQUIRE(result.value().has_value());
  CHECK(result.value()->id == "grp_1");
}

TEST_CASE("destroying the Client during an in-flight sync call on another thread is safe") {
  auto transport = std::make_shared<MockTransport>();
  transport->enqueue_json(200, junjo::test::kGroupJson);

  std::mutex gate_mutex;
  std::condition_variable gate_cv;
  bool gate_open = false;
  std::atomic<bool> in_flight{false};
  transport->on_execute = [&](const junjo::HttpRequest&) {
    in_flight.store(true);
    std::unique_lock<std::mutex> lock(gate_mutex);
    gate_cv.wait(lock, [&] { return gate_open; });
  };

  auto client = std::make_unique<Client>(make_client(transport));
  // The worker calls through its own copied surface handle, exactly
  // the sharing model games use.
  const GroupsApi groups = client->groups();
  std::thread worker([&groups] {
    const Result<std::optional<Group>> result = groups.get("grp_1");
    REQUIRE(result.has_value());
  });

  REQUIRE(wait_until([&] { return in_flight.load(); }));
  client.reset();  // Destroy the Client while the request is blocked in the transport.
  {
    const std::lock_guard<std::mutex> lock(gate_mutex);
    gate_open = true;
  }
  gate_cv.notify_all();
  worker.join();
}

TEST_CASE("no on_event lands after a mid-storm close() returns") {
  auto transport = std::make_shared<MockStreamTransport>();
  constexpr int kEventCount = 400;
  for (int i = 0; i < kEventCount; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  // Pace delivery a little so close() lands mid-storm rather than
  // after everything already drained.
  transport->before_chunk = [](std::size_t) { std::this_thread::yield(); };

  const Client client = make_client(transport);
  std::atomic<int> delivered{0};
  std::atomic<bool> in_callback{false};
  SubscribeOptions opts;
  opts.on_event = [&](const SseEvent&) {
    in_callback.store(true);
    delivered.fetch_add(1);
    in_callback.store(false);
  };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return delivered.load() >= 3; }));

  sub.value().close();
  // close() joined the stream thread: no callback is running and the
  // count is frozen forever.
  CHECK_FALSE(in_callback.load());
  const int at_close = delivered.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(delivered.load() == at_close);
  CHECK(transport->active_streams() == 0);
}

TEST_CASE("close() from inside a callback stops the stream without deadlocking") {
  auto transport = std::make_shared<MockStreamTransport>();
  for (int i = 0; i < 10; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  // Hold the first chunk until the test has stored the Subscription
  // the callback needs to reach.
  std::atomic<bool> subscription_stored{false};
  transport->before_chunk = [&subscription_stored](std::size_t index) {
    if (index == 0) {
      while (!subscription_stored.load()) std::this_thread::yield();
    }
  };

  const Client client = make_client(transport);
  std::optional<Subscription> subscription;
  std::atomic<int> delivered{0};
  std::atomic<int> close_count{0};
  SubscribeOptions opts;
  opts.on_event = [&](const SseEvent&) {
    if (delivered.fetch_add(1) + 1 == 3) {
      // The documented from-callback path: close() detects it is on
      // the stream thread and returns without joining itself.
      subscription->close();
    }
  };
  opts.on_close = [&close_count] { close_count.fetch_add(1); };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  subscription.emplace(std::move(sub).value());
  subscription_stored.store(true);

  REQUIRE(wait_until([&] { return transport->active_streams() == 0; }));
  // The closing callback was the last one; the rest of the storm was
  // suppressed, and a user-initiated close never fires on_close.
  CHECK(delivered.load() == 3);
  CHECK(close_count.load() == 0);
  // A later close() from the main thread is a no-op, and destruction
  // (via the optional) is safe after the self-close.
  subscription->close();
  subscription.reset();
}

TEST_CASE("destroying the handle from inside its own callback detaches safely") {
  // The destructor runs ON the stream thread here, where close()
  // cannot join; it must detach the still-joinable thread so the
  // thread's own last state reference cannot destroy a joinable
  // std::thread (which would terminate the process, in any config).
  auto transport = std::make_shared<MockStreamTransport>();
  for (int i = 0; i < 10; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  std::atomic<bool> subscription_stored{false};
  transport->before_chunk = [&subscription_stored](std::size_t index) {
    if (index == 0) {
      while (!subscription_stored.load()) std::this_thread::yield();
    }
  };

  const Client client = make_client(transport);
  std::optional<Subscription> subscription;
  std::atomic<int> delivered{0};
  SubscribeOptions opts;
  opts.on_event = [&](const SseEvent&) {
    if (delivered.fetch_add(1) + 1 == 3) {
      subscription.reset();  // ~Subscription on the stream thread.
    }
  };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  subscription.emplace(std::move(sub).value());
  subscription_stored.store(true);

  // Bounded wait (the watchdog): a regression that hangs the stream
  // fails here instead of wedging the suite; one that terminates
  // kills the binary and fails the run outright.
  REQUIRE(wait_until([&] { return transport->active_streams() == 0; }));
  // Give the detached thread time to release its final state share,
  // the moment a regression would terminate on.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(delivered.load() == 3);
  CHECK_FALSE(subscription.has_value());
}

TEST_CASE("move-assigning over the handle from inside its own callback is safe") {
  // operator= releases the old state ON the stream thread, where
  // close() cannot join; like the destructor it must detach the
  // still-joinable thread before dropping its state share, or the
  // thread's own copy becomes the last owner and ~SubscriptionState
  // destroys a joinable std::thread (process termination, any config).
  auto transport = std::make_shared<MockStreamTransport>();
  for (int i = 0; i < 10; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  std::atomic<bool> subscription_stored{false};
  transport->before_chunk = [&subscription_stored](std::size_t index) {
    if (index == 0) {
      while (!subscription_stored.load()) std::this_thread::yield();
    }
  };

  // The replacement stream idles on its own transport until closed.
  auto replacement_transport = std::make_shared<MockStreamTransport>();
  replacement_transport->hold_open_until_cancelled = true;

  const Client client = make_client(transport);
  const Client replacement_client = make_client(replacement_transport);

  SubscribeOptions replacement_opts;
  replacement_opts.on_event = [](const SseEvent&) {};
  Result<Subscription> replacement =
      replacement_client.events().subscribe("grp_2", std::move(replacement_opts));
  REQUIRE(replacement.has_value());

  std::optional<Subscription> handle;
  std::atomic<int> delivered{0};
  SubscribeOptions opts;
  opts.on_event = [&](const SseEvent&) {
    if (delivered.fetch_add(1) + 1 == 3) {
      // Move-assign the parked replacement into this stream's own
      // handle, from this stream's thread.
      *handle = std::move(replacement.value());
    }
  };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  handle.emplace(std::move(sub).value());
  subscription_stored.store(true);

  // Bounded wait (the watchdog): a hang fails here, a terminate kills
  // the binary; either way a regression cannot pass.
  REQUIRE(wait_until([&] { return transport->active_streams() == 0; }));
  // Give the detached thread time to release its final state share,
  // the moment a regression would terminate on.
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  CHECK(delivered.load() == 3);

  // The handle now owns the replacement stream, still open and
  // closable like any other subscription.
  CHECK(replacement_transport->active_streams() == 1);
  handle->close();
  CHECK(replacement_transport->active_streams() == 0);
  handle.reset();
}

TEST_CASE("a callback close racing an outside close cannot deadlock") {
  // The trap: an outside closer joins the stream thread while a
  // callback on that thread calls close() too. The callback path must
  // not block on anything the joiner holds.
  auto transport = std::make_shared<MockStreamTransport>();
  for (int i = 0; i < 50; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  std::atomic<bool> subscription_stored{false};
  transport->before_chunk = [&subscription_stored](std::size_t index) {
    if (index == 0) {
      while (!subscription_stored.load()) std::this_thread::yield();
    }
    std::this_thread::yield();
  };

  const Client client = make_client(transport);
  std::optional<Subscription> subscription;
  std::atomic<int> delivered{0};
  SubscribeOptions opts;
  opts.on_event = [&](const SseEvent&) {
    if (delivered.fetch_add(1) + 1 == 2) {
      subscription->close();  // From the stream thread.
    }
  };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  subscription.emplace(std::move(sub).value());
  subscription_stored.store(true);

  // Outside closer, racing the callback's close.
  std::future<void> outside_close =
      std::async(std::launch::async, [&subscription] { subscription->close(); });
  REQUIRE(outside_close.wait_for(std::chrono::seconds(10)) == std::future_status::ready);
  outside_close.get();
  REQUIRE(wait_until([&] { return transport->active_streams() == 0; }));
  subscription->close();
  subscription.reset();
}

TEST_CASE("closing from one thread while another closes too is safe") {
  auto transport = std::make_shared<MockStreamTransport>();
  transport->chunks = {member_joined_frame(1)};
  transport->hold_open_until_cancelled = true;

  const Client client = make_client(transport);
  std::atomic<int> delivered{0};
  SubscribeOptions opts;
  opts.on_event = [&delivered](const SseEvent&) { delivered.fetch_add(1); };

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return delivered.load() == 1; }));

  Subscription& handle = sub.value();
  std::thread closer_a([&handle] { handle.close(); });
  std::thread closer_b([&handle] { handle.close(); });
  closer_a.join();
  closer_b.join();
  CHECK(transport->active_streams() == 0);
}

TEST_CASE("cancelling the token during a callback storm ends the stream") {
  auto transport = std::make_shared<MockStreamTransport>();
  for (int i = 0; i < 400; ++i) {
    transport->chunks.push_back(member_joined_frame(i));
  }
  transport->before_chunk = [](std::size_t) { std::this_thread::yield(); };
  transport->hold_open_until_cancelled = true;

  const Client client = make_client(transport);
  CancellationSource source;
  std::atomic<int> delivered{0};
  std::atomic<int> terminations{0};
  SubscribeOptions opts;
  opts.on_event = [&delivered](const SseEvent&) { delivered.fetch_add(1); };
  opts.on_error = [&terminations](const junjo::Error&) { terminations.fetch_add(1); };
  opts.on_close = [&terminations] { terminations.fetch_add(1); };
  opts.token = source.token();

  Result<Subscription> sub = client.events().subscribe("grp_1", std::move(opts));
  REQUIRE(sub.has_value());
  REQUIRE(wait_until([&] { return delivered.load() >= 3; }));

  source.request_cancellation();
  REQUIRE(wait_until([&] { return transport->active_streams() == 0; }));
  const int at_cancel = delivered.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(delivered.load() == at_cancel);
  // Token cancellation is user-initiated: silent, like close().
  CHECK(terminations.load() == 0);
  sub.value().close();
}

TEST_CASE("the parser survives randomized chunk boundaries") {
  // Deterministic LCG-driven splits over a mixed-line-ending stream;
  // every split pattern must yield the identical frame sequence.
  std::string input;
  constexpr int kFrames = 64;
  for (int i = 0; i < kFrames; ++i) {
    const std::string n = std::to_string(i);
    input += "event: member.joined\r\nid: evt_" + n + "\ndata: {\"n\":" + n + "}\r\n\n";
    if (i % 7 == 0) input += ":heartbeat\n\n";
  }

  for (std::uint32_t seed = 1; seed <= 8; ++seed) {
    std::uint32_t lcg = seed;
    const auto next_len = [&lcg]() {
      lcg = lcg * 1664525u + 1013904223u;
      return static_cast<std::size_t>(lcg % 13) + 1;
    };
    junjo::detail::SseParser parser;
    std::vector<junjo::detail::SseFrame> frames;
    std::size_t pos = 0;
    while (pos < input.size()) {
      const std::size_t len = next_len();
      REQUIRE(parser.feed(std::string_view(input).substr(pos, len), frames) ==
              junjo::detail::SseParser::FeedStatus::Ok);
      pos += len;
    }
    REQUIRE(frames.size() == kFrames);
    for (int i = 0; i < kFrames; ++i) {
      CHECK(frames[static_cast<std::size_t>(i)].id == "evt_" + std::to_string(i));
      CHECK(frames[static_cast<std::size_t>(i)].data == "{\"n\":" + std::to_string(i) + "}");
    }
  }
}

TEST_CASE("ThreadPoolExecutor survives many posters and drains under fire") {
  std::atomic<int> ran{0};
  constexpr int kPosters = 8;
  constexpr int kTasksPerPoster = 250;
  {
    ThreadPoolExecutor executor(4);
    std::vector<std::thread> posters;
    posters.reserve(kPosters);
    for (int p = 0; p < kPosters; ++p) {
      posters.emplace_back([&executor, &ran] {
        for (int i = 0; i < kTasksPerPoster; ++i) {
          executor.post([&ran] { ran.fetch_add(1); });
        }
      });
    }
    for (std::thread& poster : posters) poster.join();
    // Destructor drains whatever is still queued.
  }
  CHECK(ran.load() == kPosters * kTasksPerPoster);
}
