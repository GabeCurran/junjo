// Junjo.io SDK for C++: WebhookEndpointsApi domain surface against
// MockTransport: create (secret surfaced exactly once), list paging,
// PATCH updates including the disabled flag, and removal. Signature
// verification is covered separately in test_webhook_verify.cpp.
#include <doctest/doctest.h>

#include <optional>
#include <string>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>
#include <junjo/webhooks.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::CreateWebhookEndpointInput;
using junjo::ErrorCode;
using junjo::ListWebhookEndpointsOptions;
using junjo::Page;
using junjo::Result;
using junjo::UpdateWebhookEndpointInput;
using junjo::WebhookEndpoint;
using junjo::WebhookEndpointWithSecret;
using junjo::WebhookFormat;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kNotFoundJson;
using junjo::test::kWebhookEndpointJson;

namespace {

[[nodiscard]] std::string with_secret_json() {
  std::string json(kWebhookEndpointJson);
  json.insert(json.rfind('}'), R"(,
  "secret": "generated-secret")");
  return json;
}

}  // namespace

TEST_CASE("webhooks.endpoints.create POSTs the minimal body and surfaces the secret") {
  Harness h;
  h.transport->enqueue_json(201, with_secret_json());
  const CreateWebhookEndpointInput input{.url = "https://dev.example.com/hook"};
  const Result<WebhookEndpointWithSecret> created =
      h.client.webhooks().endpoints().create(input);
  REQUIRE(created.has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/webhooks");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"url":"https://dev.example.com/hook"})"));

  CHECK(created.value().id == "whe_1");
  CHECK(created.value().game_id == "game_1");
  CHECK(created.value().url == "https://dev.example.com/hook");
  CHECK(created.value().events == std::vector<std::string>{"member.joined"});
  CHECK(created.value().format == WebhookFormat::Junjo);
  CHECK(created.value().created_at == "2026-04-28T05:00:00.000Z");
  CHECK_FALSE(created.value().disabled_at.has_value());
  CHECK(created.value().secret == "generated-secret");
}

TEST_CASE("webhooks.endpoints.create forwards events, secret, and format") {
  Harness h;
  h.transport->enqueue_json(201, with_secret_json());
  const CreateWebhookEndpointInput input{
      .url = "https://discord.com/api/webhooks/1/abc",
      .events = {"group.deleted", "group.updated"},
      .secret = std::string("supplied-secret-1234"),
      .format = WebhookFormat::Discord,
  };
  REQUIRE(h.client.webhooks().endpoints().create(input).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({
    "url": "https://discord.com/api/webhooks/1/abc",
    "events": ["group.deleted", "group.updated"],
    "secret": "supplied-secret-1234",
    "format": "discord"
  })"));
}

TEST_CASE("webhooks.endpoints.create rejects WebhookFormat::Unknown client-side") {
  Harness h;
  const CreateWebhookEndpointInput input{.url = "https://dev.example.com/hook",
                                         .format = WebhookFormat::Unknown};
  const Result<WebhookEndpointWithSecret> rejected =
      h.client.webhooks().endpoints().create(input);
  REQUIRE_FALSE(rejected.has_value());
  CHECK(rejected.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 0);
}

TEST_CASE("webhooks.endpoints.create response missing the secret is InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(201, kWebhookEndpointJson);
  const CreateWebhookEndpointInput input{.url = "https://dev.example.com/hook"};
  const Result<WebhookEndpointWithSecret> created =
      h.client.webhooks().endpoints().create(input);
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("webhooks.endpoints.list hits the collection URL and never carries a secret") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kWebhookEndpointJson + R"(],"nextCursor":null})";
  h.transport->enqueue_json(200, body);
  const Result<Page<WebhookEndpoint>> page = h.client.webhooks().endpoints().list();
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/webhooks");
  REQUIRE(page.value().items.size() == 1);
  CHECK(page.value().items[0].id == "whe_1");
  CHECK_FALSE(page.value().next_cursor.has_value());
}

TEST_CASE("webhooks.endpoints.list encodes limit and cursor and passes nextCursor through") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kWebhookEndpointJson + R"(],"nextCursor":"whe_1"})";
  h.transport->enqueue_json(200, body);
  const ListWebhookEndpointsOptions options{.limit = 2, .cursor = std::string("whe_0")};
  const Result<Page<WebhookEndpoint>> page = h.client.webhooks().endpoints().list(options);
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/webhooks?limit=2&cursor=whe_0");
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "whe_1");
}

TEST_CASE("webhooks.endpoints.list maps an unknown format to Unknown instead of failing") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "items": [{
      "id": "whe_2",
      "gameId": "game_1",
      "url": "https://dev.example.com/hook2",
      "events": [],
      "format": "teams",
      "createdAt": "2026-04-28T05:00:00.000Z",
      "disabledAt": "2026-04-28T06:00:00.000Z"
    }],
    "nextCursor": null
  })");
  const Result<Page<WebhookEndpoint>> page = h.client.webhooks().endpoints().list();
  REQUIRE(page.has_value());
  REQUIRE(page.value().items.size() == 1);
  CHECK(page.value().items[0].format == WebhookFormat::Unknown);
  CHECK(page.value().items[0].events.empty());
  REQUIRE(page.value().items[0].disabled_at.has_value());
  CHECK(*page.value().items[0].disabled_at == "2026-04-28T06:00:00.000Z");
}

TEST_CASE("webhooks.endpoints.update PATCHes only the supplied fields") {
  Harness h;
  h.transport->enqueue_json(200, kWebhookEndpointJson);
  const UpdateWebhookEndpointInput input{
      .url = std::string("https://renamed.example.com/hook"),
      .events = std::vector<std::string>{"group.deleted"},
      .disabled = true,
  };
  REQUIRE(h.client.webhooks().endpoints().update("whe_1", input).has_value());
  CHECK(h.transport->last_request().method == "PATCH");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/webhooks/whe_1");
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({
    "url": "https://renamed.example.com/hook",
    "events": ["group.deleted"],
    "disabled": true
  })"));
}

TEST_CASE("webhooks.endpoints.update distinguishes empty events (match all) from omitted") {
  Harness h;
  h.transport->enqueue_json(200, kWebhookEndpointJson);
  const UpdateWebhookEndpointInput clear_events{.events = std::vector<std::string>{}};
  REQUIRE(h.client.webhooks().endpoints().update("whe_1", clear_events).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"events":[]})"));

  h.transport->enqueue_json(200, kWebhookEndpointJson);
  const UpdateWebhookEndpointInput sole_flag{.disabled = false};
  REQUIRE(h.client.webhooks().endpoints().update("whe_1", sole_flag).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"disabled":false})"));
}

TEST_CASE("webhooks.endpoints.update forwards a sole format change and rejects Unknown") {
  Harness h;
  h.transport->enqueue_json(200, kWebhookEndpointJson);
  const UpdateWebhookEndpointInput reformat{.format = WebhookFormat::Slack};
  REQUIRE(h.client.webhooks().endpoints().update("whe_1", reformat).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"format":"slack"})"));

  const UpdateWebhookEndpointInput bad{.format = WebhookFormat::Unknown};
  const Result<WebhookEndpoint> rejected = h.client.webhooks().endpoints().update("whe_1", bad);
  REQUIRE_FALSE(rejected.has_value());
  CHECK(rejected.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 1);
}

TEST_CASE("webhooks.endpoints.remove DELETEs the encoded id and propagates not_found") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.webhooks().endpoints().remove("whe/with slash").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/webhooks/whe%2Fwith%20slash");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<void> missing = h.client.webhooks().endpoints().remove("whe_missing");
  REQUIRE_FALSE(missing.has_value());
  CHECK(missing.error().code == ErrorCode::NotFound);
}
