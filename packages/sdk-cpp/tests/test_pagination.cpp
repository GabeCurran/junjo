// Junjo.io SDK for C++: junjo::paginate: multi-page walks, cursor
// threading, early stop, error short-circuit, and cancellation, both
// against synthetic fetchers and end-to-end through groups().list.
#include <doctest/doctest.h>

#include <cstddef>
#include <optional>
#include <string>
#include <vector>

#include <junjo/cancellation.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/groups.hpp>
#include <junjo/pagination.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "test_support.hpp"

using junjo::CancellationSource;
using junjo::Error;
using junjo::ErrorCode;
using junjo::Group;
using junjo::ListGroupsOptions;
using junjo::Page;
using junjo::Result;
using junjo::test::Harness;

namespace {

// Builds a synthetic three-page fetcher over the ints 1..6, recording
// the cursors it was handed.
struct SyntheticPages {
  std::vector<std::optional<std::string>> seen_cursors;

  Result<Page<int>> fetch(const std::optional<std::string>& cursor) {
    seen_cursors.push_back(cursor);
    if (!cursor.has_value()) {
      return Page<int>{.items = {1, 2}, .next_cursor = std::string("c2")};
    }
    if (*cursor == "c2") {
      return Page<int>{.items = {3, 4}, .next_cursor = std::string("c3")};
    }
    return Page<int>{.items = {5, 6}, .next_cursor = std::nullopt};
  }
};

[[nodiscard]] std::string group_page_json(const char* group_id, const char* next_cursor) {
  std::string body = std::string(R"({"items":[{)") +
                     R"("id":")" + group_id + R"(",)" +
                     R"("gameId":"game_1","kind":"guild","name":"Page Group",)" +
                     R"("visibility":"public","metadata":{},"defaultRoleId":null,)" +
                     R"("parentGroupId":null,"memberCount":1,"hasPasscode":false,)" +
                     R"("createdAt":"2026-01-01T00:00:00.000Z",)" +
                     R"("updatedAt":"2026-01-01T00:00:00.000Z","softDeletedAt":null}],)";
  if (next_cursor == nullptr) {
    body += R"("nextCursor":null})";
  } else {
    body += std::string(R"("nextCursor":")") + next_cursor + R"("})";
  }
  return body;
}

}  // namespace

TEST_CASE("paginate walks every page in order, threading cursors") {
  SyntheticPages pages;
  std::vector<int> seen;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) { return pages.fetch(cursor); },
      [&](int&& value) { seen.push_back(value); });

  REQUIRE(walked.has_value());
  CHECK(seen == std::vector<int>{1, 2, 3, 4, 5, 6});
  REQUIRE(pages.seen_cursors.size() == 3);
  CHECK_FALSE(pages.seen_cursors[0].has_value());
  REQUIRE(pages.seen_cursors[1].has_value());
  CHECK(*pages.seen_cursors[1] == "c2");
  REQUIRE(pages.seen_cursors[2].has_value());
  CHECK(*pages.seen_cursors[2] == "c3");
}

TEST_CASE("paginate stops early when per_item returns false, still a success") {
  SyntheticPages pages;
  std::vector<int> seen;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) { return pages.fetch(cursor); },
      [&](int&& value) {
        seen.push_back(value);
        return value < 3;  // stop after seeing 3
      });

  REQUIRE(walked.has_value());
  CHECK(seen == std::vector<int>{1, 2, 3});
  // The walk never asked for the third page.
  CHECK(pages.seen_cursors.size() == 2);
}

TEST_CASE("paginate short-circuits on a fetch error without touching later pages") {
  int fetches = 0;
  std::vector<int> seen;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) -> Result<Page<int>> {
        ++fetches;
        if (!cursor.has_value()) {
          return Page<int>{.items = {1, 2}, .next_cursor = std::string("c2")};
        }
        return Error{.code = ErrorCode::RateLimitExceeded, .message = "slow down"};
      },
      [&](int&& value) { seen.push_back(value); });

  REQUIRE_FALSE(walked.has_value());
  CHECK(walked.error().code == ErrorCode::RateLimitExceeded);
  // Items before the failing page were delivered; nothing after.
  CHECK(seen == std::vector<int>{1, 2});
  CHECK(fetches == 2);
}

TEST_CASE("paginate drains groups().list end to end, passing cursors as query params") {
  Harness h;
  h.transport->enqueue_json(200, group_page_json("grp_a", "cursor_b"));
  h.transport->enqueue_json(200, group_page_json("grp_b", nullptr));

  std::vector<std::string> ids;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) {
        ListGroupsOptions options;
        options.limit = 1;
        options.cursor = cursor;
        return h.client.groups().list(options);
      },
      [&](Group&& group) { ids.push_back(group.id); });

  REQUIRE(walked.has_value());
  CHECK(ids == std::vector<std::string>{"grp_a", "grp_b"});
  REQUIRE(h.transport->request_count() == 2);
  CHECK(h.transport->recorded()[0].request.url == "https://api.junjo.io/v1/groups?limit=1");
  CHECK(h.transport->recorded()[1].request.url ==
        "https://api.junjo.io/v1/groups?limit=1&cursor=cursor_b");
}

TEST_CASE("paginate surfaces mid-walk cancellation as Cancelled and stops fetching") {
  Harness h;
  CancellationSource source;
  h.transport->enqueue_json(200, group_page_json("grp_a", "cursor_b"));
  h.transport->enqueue_json(200, group_page_json("grp_b", nullptr));
  // Cancel while the SECOND request is in flight; the first page
  // arrives intact.
  h.transport->on_execute = [&](const junjo::HttpRequest& request) {
    if (request.url.find("cursor_b") != std::string::npos) {
      source.request_cancellation();
    }
  };

  std::vector<std::string> ids;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) {
        ListGroupsOptions options;
        options.cursor = cursor;
        return h.client.groups().list(options, source.token());
      },
      [&](Group&& group) { ids.push_back(group.id); });

  REQUIRE_FALSE(walked.has_value());
  CHECK(walked.error().code == ErrorCode::Cancelled);
  CHECK(ids == std::vector<std::string>{"grp_a"});
  CHECK(h.transport->request_count() == 2);
}

TEST_CASE("paginate treats a single page without a cursor as a complete walk") {
  Harness h;
  h.transport->enqueue_json(200, group_page_json("grp_only", nullptr));
  std::size_t count = 0;
  const Result<void> walked = junjo::paginate(
      [&](const std::optional<std::string>& cursor) {
        ListGroupsOptions options;
        options.cursor = cursor;
        return h.client.groups().list(options);
      },
      [&](Group&&) { ++count; });
  REQUIRE(walked.has_value());
  CHECK(count == 1);
  CHECK(h.transport->request_count() == 1);
}
