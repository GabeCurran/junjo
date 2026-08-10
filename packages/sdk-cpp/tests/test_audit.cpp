// Junjo.io SDK for C++: AuditApi domain surface against
// MockTransport: URL and query encoding (repeated actions parameters,
// the before boundary in both its forms) and entry deserialization.
#include <doctest/doctest.h>

#include <optional>
#include <string>

#include <junjo/audit.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "test_support.hpp"

using junjo::AuditEntry;
using junjo::ErrorCode;
using junjo::ListAuditOptions;
using junjo::Page;
using junjo::Result;
using junjo::test::Harness;
using junjo::test::kAuditEntryJson;

TEST_CASE("audit.list without options hits the bare group audit URL") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kAuditEntryJson + R"(],"nextCursor":null})";
  h.transport->enqueue_json(200, body);
  const Result<Page<AuditEntry>> page = h.client.audit().list("grp_1");
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/audit");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  REQUIRE(page.value().items.size() == 1);
  const AuditEntry& entry = page.value().items[0];
  CHECK(entry.id == "aud_1");
  CHECK(entry.group_id == "grp_1");
  REQUIRE(entry.actor_user_id.has_value());
  CHECK(*entry.actor_user_id == "user_mod");
  CHECK(entry.action == "member.kicked");
  REQUIRE(entry.target_id.has_value());
  CHECK(*entry.target_id == "user_1");
  CHECK(entry.payload_json == R"({"reason":"afk"})");
  CHECK(entry.created_at == "2026-06-06T00:00:00.000Z");
}

TEST_CASE("audit.list encodes limit, before, and repeated actions parameters") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListAuditOptions options{.limit = 20,
                                 .before = std::string("aud_0"),
                                 .actions = {"member.kicked", "member.banned"}};
  REQUIRE(h.client.audit().list("grp_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/audit"
        "?limit=20&before=aud_0&actions=member.kicked&actions=member.banned");
}

TEST_CASE("audit.list passes an ISO timestamp before-boundary through verbatim") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListAuditOptions options{.before = std::string("2026-06-01T00:00:00.000Z")};
  REQUIRE(h.client.audit().list("grp_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/audit"
        "?before=2026-06-01T00%3A00%3A00.000Z");
}

TEST_CASE("audit.list feeds nextCursor back as the next page's before") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":"aud_42"})");
  const Result<Page<AuditEntry>> first = h.client.audit().list("grp_1");
  REQUIRE(first.has_value());
  REQUIRE(first.value().next_cursor.has_value());

  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListAuditOptions next_page{.before = first.value().next_cursor};
  REQUIRE(h.client.audit().list("grp_1", next_page).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/audit?before=aud_42");
}

TEST_CASE("audit entries tolerate a system actor and empty payload") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "items": [{
      "id": "aud_2",
      "groupId": "grp_1",
      "actorUserId": null,
      "action": "group.updated",
      "targetId": null,
      "payload": {},
      "createdAt": "2026-06-07T00:00:00.000Z"
    }],
    "nextCursor": null
  })");
  const Result<Page<AuditEntry>> page = h.client.audit().list("grp_1");
  REQUIRE(page.has_value());
  REQUIRE(page.value().items.size() == 1);
  CHECK_FALSE(page.value().items[0].actor_user_id.has_value());
  CHECK_FALSE(page.value().items[0].target_id.has_value());
  CHECK(page.value().items[0].payload_json == "{}");
}

TEST_CASE("an audit entry missing its action maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(
      200, R"({"items":[{"id":"aud_3","groupId":"grp_1"}],"nextCursor":null})");
  const Result<Page<AuditEntry>> page = h.client.audit().list("grp_1");
  REQUIRE_FALSE(page.has_value());
  CHECK(page.error().code == ErrorCode::InvalidWireData);
}
