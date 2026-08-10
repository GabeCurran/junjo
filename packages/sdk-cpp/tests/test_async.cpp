// Junjo.io SDK for C++: the async facade: executor semantics, the
// *_async variants, and the future-outlives-Client guarantee.
#include <doctest/doctest.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <junjo/cancellation.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/executor.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "mock_transport.hpp"
#include "test_support.hpp"

using junjo::CancellationSource;
using junjo::Client;
using junjo::Group;
using junjo::InlineExecutor;
using junjo::KeyInfo;
using junjo::Member;
using junjo::Page;
using junjo::PermissionCheckResult;
using junjo::Result;
using junjo::ThreadPoolExecutor;
using junjo::test::Harness;

namespace {

// A gate a test opens to release a transport call blocked in flight.
struct Gate {
  std::mutex mutex;
  std::condition_variable cv;
  bool open = false;

  void release() {
    {
      const std::lock_guard<std::mutex> lock(mutex);
      open = true;
    }
    cv.notify_all();
  }
  void wait() {
    std::unique_lock<std::mutex> lock(mutex);
    cv.wait(lock, [this] { return open; });
  }
};

}  // namespace

TEST_CASE("InlineExecutor runs the task before post returns") {
  InlineExecutor executor;
  const std::thread::id caller = std::this_thread::get_id();
  bool ran = false;
  std::thread::id ran_on{};
  executor.post([&] {
    ran = true;
    ran_on = std::this_thread::get_id();
  });
  CHECK(ran);
  CHECK(ran_on == caller);
}

TEST_CASE("key_info_async through an InlineExecutor is ready on return") {
  Harness h;
  h.transport->enqueue_json(200, R"({"gameId":"game_1"})");
  InlineExecutor executor;

  std::future<Result<KeyInfo>> future = h.client.key_info_async(executor);
  REQUIRE(future.wait_for(std::chrono::seconds(0)) == std::future_status::ready);
  Result<KeyInfo> result = future.get();
  REQUIRE(result.has_value());
  CHECK(result.value().game_id == "game_1");
}

TEST_CASE("ThreadPoolExecutor runs async calls off the calling thread") {
  Harness h;
  h.transport->enqueue_json(200, std::string("{\"items\":[") + junjo::test::kGroupJson +
                                     "],\"nextCursor\":null}");
  std::atomic<std::thread::id> transport_thread{};
  h.transport->on_execute = [&transport_thread](const junjo::HttpRequest&) {
    transport_thread.store(std::this_thread::get_id());
  };

  ThreadPoolExecutor executor(2);
  std::future<Result<Page<Group>>> future = h.client.groups().list_async(executor);
  Result<Page<Group>> result = future.get();
  REQUIRE(result.has_value());
  CHECK(result.value().items.size() == 1);
  CHECK(transport_thread.load() != std::this_thread::get_id());
}

TEST_CASE("the async variants issue the same requests as their sync twins") {
  Harness h;
  InlineExecutor executor;

  h.transport->enqueue_json(200, junjo::test::kGroupJson);
  Result<std::optional<Group>> got = h.client.groups().get_async(executor, "grp_1").get();
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->id == "grp_1");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1");

  h.transport->enqueue_json(201, junjo::test::kGroupJson);
  Result<Group> created =
      h.client.groups()
          .create_async(executor, {.kind = "guild", .name = "Night Watch"})
          .get();
  REQUIRE(created.has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups");

  h.transport->enqueue_json(200, std::string("{\"items\":[") + junjo::test::kMemberJson +
                                     "],\"nextCursor\":null}");
  Result<Page<Member>> members = h.client.members().list_async(executor, "grp_1").get();
  REQUIRE(members.has_value());
  CHECK(members.value().items.size() == 1);
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/members");

  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaRoleId":"role_1"})");
  Result<PermissionCheckResult> check =
      h.client.check_async(executor, "user_1", "grp_1", "kick_member").get();
  REQUIRE(check.has_value());
  CHECK(check.value().allowed);
}

TEST_CASE("async argument strings are copied at call time") {
  Harness h;
  h.transport->enqueue_json(200, junjo::test::kGroupJson);
  ThreadPoolExecutor executor(1);

  Gate gate;
  h.transport->on_execute = [&gate](const junjo::HttpRequest&) { gate.wait(); };
  std::future<Result<std::optional<Group>>> future;
  {
    // The source string dies before the task can run; the request
    // must still carry its value.
    std::string id = "grp_1";
    future = h.client.groups().get_async(executor, id);
    id.assign("clobbered");
  }
  gate.release();
  Result<std::optional<Group>> result = future.get();
  REQUIRE(result.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1");
}

TEST_CASE("the future stays valid and completes after the Client dies") {
  auto transport = std::make_shared<junjo::test::MockTransport>();
  transport->enqueue_json(200, R"({"gameId":"game_1"})");
  Gate gate;
  std::atomic<bool> in_flight{false};
  transport->on_execute = [&](const junjo::HttpRequest&) {
    in_flight.store(true);
    gate.wait();
  };

  ThreadPoolExecutor executor(1);
  std::future<Result<KeyInfo>> future;
  {
    Result<Client> created = Client::create(
        {.api_key = junjo::test::kTestKey, .transport = transport});
    REQUIRE(created.has_value());
    future = created.value().key_info_async(executor);
    // Wait until the call is genuinely in flight, then destroy every
    // user-held handle (Client included) while it still is.
    while (!in_flight.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  gate.release();

  Result<KeyInfo> result = future.get();
  REQUIRE(result.has_value());
  CHECK(result.value().game_id == "game_1");
}

TEST_CASE("cancellation tokens work identically through the async path") {
  Harness h;
  InlineExecutor executor;
  CancellationSource source;
  source.request_cancellation();

  Result<std::optional<Group>> result =
      h.client.groups().get_async(executor, "grp_1", {}, source.token()).get();
  REQUIRE_FALSE(result.has_value());
  CHECK(result.error().code == junjo::ErrorCode::Cancelled);
  // Pre-flight cancellation: the transport was never called.
  CHECK(h.transport->request_count() == 0);
}

TEST_CASE("ThreadPoolExecutor destruction drains every queued task") {
  std::atomic<int> ran{0};
  {
    ThreadPoolExecutor executor(2);
    for (int i = 0; i < 200; ++i) {
      executor.post([&ran] { ran.fetch_add(1); });
    }
    // Destructor: every already-posted task must run before join.
  }
  CHECK(ran.load() == 200);
}

TEST_CASE("tasks posted from inside a draining task still run") {
  std::atomic<int> ran{0};
  {
    ThreadPoolExecutor executor(1);
    executor.post([&] {
      ran.fetch_add(1);
      executor.post([&ran] { ran.fetch_add(1); });
    });
  }
  CHECK(ran.load() == 2);
}

TEST_CASE("a zero thread count is clamped to one") {
  std::atomic<bool> ran{false};
  {
    ThreadPoolExecutor executor(0);
    executor.post([&ran] { ran.store(true); });
  }
  CHECK(ran.load());
}
