// Junjo.io SDK for C++

#include "junjo/error.hpp"

#include <array>
#include <utility>

namespace junjo {

namespace {

// Wire string <-> enum table for the server envelope codes. One table
// drives both directions so they cannot drift apart.
constexpr std::array<std::pair<std::string_view, ErrorCode>, 18> kServerCodes{{
    {"bad_request", ErrorCode::BadRequest},
    {"invalid_api_key", ErrorCode::InvalidApiKey},
    {"invalid_admin_token", ErrorCode::InvalidAdminToken},
    {"permission_denied", ErrorCode::PermissionDenied},
    {"not_found", ErrorCode::NotFound},
    {"already_member", ErrorCode::AlreadyMember},
    {"role_has_members", ErrorCode::RoleHasMembers},
    {"role_name_taken", ErrorCode::RoleNameTaken},
    {"role_group_mismatch", ErrorCode::RoleGroupMismatch},
    {"parent_cycle", ErrorCode::ParentCycle},
    {"banned", ErrorCode::Banned},
    {"passcode_required", ErrorCode::PasscodeRequired},
    {"passcode_invalid", ErrorCode::PasscodeInvalid},
    {"invitation_expired", ErrorCode::InvitationExpired},
    {"invitation_used", ErrorCode::InvitationUsed},
    {"restore_window_expired", ErrorCode::RestoreWindowExpired},
    {"rate_limit_exceeded", ErrorCode::RateLimitExceeded},
    {"internal", ErrorCode::Internal},
}};

}  // namespace

std::string_view to_string(ErrorCode code) noexcept {
  for (const auto& [wire, mapped] : kServerCodes) {
    if (mapped == code) return wire;
  }
  switch (code) {
    case ErrorCode::NetworkError:
      return "network_error";
    case ErrorCode::Timeout:
      return "timeout";
    case ErrorCode::Cancelled:
      return "cancelled";
    case ErrorCode::InvalidWireData:
      return "invalid_wire_data";
    case ErrorCode::InvalidConfig:
      return "invalid_config";
    case ErrorCode::StreamOverflow:
      return "stream_overflow";
    case ErrorCode::WebhookSignatureMissing:
      return "webhook_signature_missing";
    case ErrorCode::WebhookTimestampMissing:
      return "webhook_timestamp_missing";
    case ErrorCode::WebhookInvalidSignature:
      return "webhook_invalid_signature";
    case ErrorCode::WebhookTimestampInvalid:
      return "webhook_timestamp_invalid";
    case ErrorCode::WebhookTimestampOutOfTolerance:
      return "webhook_timestamp_out_of_tolerance";
    case ErrorCode::WebhookInvalidBody:
      return "webhook_invalid_body";
    default:
      return "unknown";
  }
}

ErrorCode error_code_from_wire(std::string_view wire) noexcept {
  for (const auto& [name, code] : kServerCodes) {
    if (name == wire) return code;
  }
  return ErrorCode::Unknown;
}

}  // namespace junjo
