// Junjo.io SDK for C++: internal RequestExecutor behaviors that the
// public surface of this slice cannot reach yet (204 No Content, JSON
// body posting). Includes internal headers from src/ on purpose.
#include <doctest/doctest.h>

#include <chrono>
#include <memory>
#include <optional>
#include <utility>

#include <junjo/cancellation.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>

#include "mock_transport.hpp"
#include "request_executor.hpp"

using junjo::CancellationToken;
using junjo::ErrorCode;
using junjo::HttpResponse;
using junjo::Result;
using junjo::detail::Json;
using junjo::detail::JsonBody;
using junjo::detail::RequestExecutor;
using junjo::test::MockTransport;

namespace {

struct ExecutorHarness {
  std::shared_ptr<MockTransport> transport = std::make_shared<MockTransport>();
  RequestExecutor executor{RequestExecutor::Config{
      .api_key = "jk_test.secret",
      .base_url = "https://api.junjo.io",
      .timeout = std::chrono::milliseconds(30000),
      .transport = transport,
  }};
};

}  // namespace

TEST_CASE("a 204 response is success with no body") {
  ExecutorHarness h;
  HttpResponse response;
  response.status = 204;
  h.transport->enqueue(std::move(response));

  const Result<JsonBody> result =
      h.executor.execute_json("DELETE", "/v1/groups/grp_1", std::nullopt, CancellationToken());
  REQUIRE(result.has_value());
  CHECK(result.value().status == 204);
  CHECK_FALSE(result.value().value.has_value());
}

TEST_CASE("a JSON body is serialized with a content-type header") {
  ExecutorHarness h;
  h.transport->enqueue_json(200, R"({"ok":true})");

  const Json body = {{"name", "Night Watch"}, {"kind", "guild"}};
  const Result<JsonBody> result =
      h.executor.execute_json("POST", "/v1/groups", body, CancellationToken());
  REQUIRE(result.has_value());

  const auto& request = h.transport->last_request();
  CHECK(request.method == "POST");
  REQUIRE(request.body.has_value());
  CHECK(Json::parse(*request.body) == body);
  REQUIRE(request.headers.size() == 2);
  CHECK(request.headers[1].first == "content-type");
  CHECK(request.headers[1].second == "application/json");
}

TEST_CASE("a 2xx status other than 200 still parses as success") {
  ExecutorHarness h;
  h.transport->enqueue_json(201, R"({"id":"grp_new"})");
  const Result<JsonBody> result =
      h.executor.execute_json("POST", "/v1/groups", std::nullopt, CancellationToken());
  REQUIRE(result.has_value());
  CHECK(result.value().status == 201);
  REQUIRE(result.value().value.has_value());
  CHECK((*result.value().value)["id"] == "grp_new");
}
