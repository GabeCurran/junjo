// Junjo.io SDK for C++: error code mapping and Result semantics.
#include <doctest/doctest.h>

#include <stdexcept>
#include <string>

#include <junjo/error.hpp>
#include <junjo/result.hpp>

using junjo::Error;
using junjo::ErrorCode;
using junjo::Result;

TEST_CASE("error_code_from_wire maps every server envelope code") {
  CHECK(junjo::error_code_from_wire("bad_request") == ErrorCode::BadRequest);
  CHECK(junjo::error_code_from_wire("invalid_api_key") == ErrorCode::InvalidApiKey);
  CHECK(junjo::error_code_from_wire("invalid_admin_token") == ErrorCode::InvalidAdminToken);
  CHECK(junjo::error_code_from_wire("permission_denied") == ErrorCode::PermissionDenied);
  CHECK(junjo::error_code_from_wire("not_found") == ErrorCode::NotFound);
  CHECK(junjo::error_code_from_wire("already_member") == ErrorCode::AlreadyMember);
  CHECK(junjo::error_code_from_wire("role_has_members") == ErrorCode::RoleHasMembers);
  CHECK(junjo::error_code_from_wire("role_name_taken") == ErrorCode::RoleNameTaken);
  CHECK(junjo::error_code_from_wire("role_group_mismatch") == ErrorCode::RoleGroupMismatch);
  CHECK(junjo::error_code_from_wire("parent_cycle") == ErrorCode::ParentCycle);
  CHECK(junjo::error_code_from_wire("banned") == ErrorCode::Banned);
  CHECK(junjo::error_code_from_wire("passcode_required") == ErrorCode::PasscodeRequired);
  CHECK(junjo::error_code_from_wire("passcode_invalid") == ErrorCode::PasscodeInvalid);
  CHECK(junjo::error_code_from_wire("invitation_expired") == ErrorCode::InvitationExpired);
  CHECK(junjo::error_code_from_wire("invitation_used") == ErrorCode::InvitationUsed);
  CHECK(junjo::error_code_from_wire("restore_window_expired") == ErrorCode::RestoreWindowExpired);
  CHECK(junjo::error_code_from_wire("rate_limit_exceeded") == ErrorCode::RateLimitExceeded);
  CHECK(junjo::error_code_from_wire("internal") == ErrorCode::Internal);
}

TEST_CASE("error_code_from_wire maps unknown strings to Unknown") {
  CHECK(junjo::error_code_from_wire("brand_new_code") == ErrorCode::Unknown);
  CHECK(junjo::error_code_from_wire("") == ErrorCode::Unknown);
  // Case matters: the wire contract is lowercase.
  CHECK(junjo::error_code_from_wire("NOT_FOUND") == ErrorCode::Unknown);
}

TEST_CASE("to_string round-trips server codes and names SDK codes") {
  CHECK(junjo::to_string(ErrorCode::NotFound) == "not_found");
  CHECK(junjo::to_string(ErrorCode::RateLimitExceeded) == "rate_limit_exceeded");
  CHECK(junjo::to_string(ErrorCode::NetworkError) == "network_error");
  CHECK(junjo::to_string(ErrorCode::Timeout) == "timeout");
  CHECK(junjo::to_string(ErrorCode::Cancelled) == "cancelled");
  CHECK(junjo::to_string(ErrorCode::InvalidWireData) == "invalid_wire_data");
  CHECK(junjo::to_string(ErrorCode::InvalidConfig) == "invalid_config");
  CHECK(junjo::to_string(ErrorCode::Unknown) == "unknown");
  // Full round trip across the server block.
  for (const char* wire :
       {"bad_request", "invalid_api_key", "invalid_admin_token", "permission_denied", "not_found",
        "already_member", "role_has_members", "role_name_taken", "role_group_mismatch",
        "parent_cycle", "banned", "passcode_required", "passcode_invalid", "invitation_expired",
        "invitation_used", "restore_window_expired", "rate_limit_exceeded", "internal"}) {
    CHECK(junjo::to_string(junjo::error_code_from_wire(wire)) == wire);
  }
}

TEST_CASE("Result carries values and errors") {
  Result<int> ok = 42;
  REQUIRE(ok.has_value());
  CHECK(static_cast<bool>(ok));
  CHECK(ok.value() == 42);
  CHECK(ok.value_or(-1) == 42);

  Result<int> failed = Error{.code = ErrorCode::Timeout, .message = "request timed out"};
  REQUIRE_FALSE(failed.has_value());
  CHECK(failed.error().code == ErrorCode::Timeout);
  CHECK(failed.value_or(-1) == -1);
}

TEST_CASE("Result precondition violations throw logic_error") {
  Result<int> ok = 1;
  CHECK_THROWS_AS((void)ok.error(), std::logic_error);
  Result<int> failed = Error{.code = ErrorCode::Unknown};
  CHECK_THROWS_AS((void)failed.value(), std::logic_error);
}

TEST_CASE("Result map and and_then propagate correctly") {
  Result<int> ok = 21;
  const Result<std::string> mapped = ok.map([](int v) { return std::to_string(v * 2); });
  REQUIRE(mapped.has_value());
  CHECK(mapped.value() == "42");

  Result<int> failed = Error{.code = ErrorCode::NotFound, .message = "nope"};
  const Result<std::string> mapped_err =
      failed.map([](int v) { return std::to_string(v); });
  REQUIRE_FALSE(mapped_err.has_value());
  CHECK(mapped_err.error().code == ErrorCode::NotFound);

  const Result<int> chained = ok.and_then([](int v) -> Result<int> {
    if (v > 100) return Error{.code = ErrorCode::BadRequest};
    return v + 1;
  });
  REQUIRE(chained.has_value());
  CHECK(chained.value() == 22);

  const Result<int> chained_to_err =
      ok.and_then([](int) -> Result<int> { return Error{.code = ErrorCode::Banned}; });
  REQUIRE_FALSE(chained_to_err.has_value());
  CHECK(chained_to_err.error().code == ErrorCode::Banned);
}

TEST_CASE("Result<void> defaults to success and carries errors") {
  const Result<void> ok = Result<void>::ok();
  CHECK(ok.has_value());
  CHECK_THROWS_AS((void)ok.error(), std::logic_error);

  const Result<void> failed = Error{.code = ErrorCode::Internal};
  CHECK_FALSE(failed.has_value());
  CHECK(failed.error().code == ErrorCode::Internal);
}
