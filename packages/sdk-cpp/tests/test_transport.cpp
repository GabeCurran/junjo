// Junjo.io SDK for C++: HttpResponse header lookup and cancellation
// primitives.
#include <doctest/doctest.h>

#include <thread>

#include <junjo/cancellation.hpp>
#include <junjo/transport.hpp>

using junjo::CancellationSource;
using junjo::CancellationToken;
using junjo::HttpResponse;

TEST_CASE("HttpResponse::header is case-insensitive and returns the first match") {
  HttpResponse response;
  response.headers = {
      {"Content-Type", "application/json"},
      {"X-Request-Id", "req_123"},
      {"Set-Cookie", "first"},
      {"set-cookie", "second"},
  };

  REQUIRE(response.header("content-type").has_value());
  CHECK(*response.header("content-type") == "application/json");
  CHECK(*response.header("CONTENT-TYPE") == "application/json");
  CHECK(*response.header("x-request-id") == "req_123");
  CHECK(*response.header("Set-Cookie") == "first");
  CHECK_FALSE(response.header("retry-after").has_value());
  CHECK_FALSE(response.header("").has_value());
}

TEST_CASE("default CancellationToken is never cancelled") {
  const CancellationToken token;
  CHECK_FALSE(token.is_cancelled());
  CHECK_FALSE(CancellationToken::none().is_cancelled());
}

TEST_CASE("CancellationSource cancellation is observed by its tokens and is sticky") {
  CancellationSource source;
  const CancellationToken token = source.token();
  CHECK_FALSE(token.is_cancelled());
  CHECK_FALSE(source.cancellation_requested());

  source.request_cancellation();
  CHECK(token.is_cancelled());
  CHECK(source.cancellation_requested());

  // Idempotent, and tokens minted after the fact see it too.
  source.request_cancellation();
  CHECK(source.token().is_cancelled());
}

TEST_CASE("tokens stay valid after the source is destroyed") {
  CancellationToken cancelled;
  CancellationToken untouched;
  {
    CancellationSource source;
    cancelled = source.token();
    source.request_cancellation();

    CancellationSource other;
    untouched = other.token();
  }
  CHECK(cancelled.is_cancelled());
  CHECK_FALSE(untouched.is_cancelled());
}

TEST_CASE("cancellation is visible across threads") {
  CancellationSource source;
  const CancellationToken token = source.token();

  std::thread canceller([&source] { source.request_cancellation(); });
  canceller.join();
  // join() synchronizes-with the store; the poll must observe it.
  CHECK(token.is_cancelled());
}
