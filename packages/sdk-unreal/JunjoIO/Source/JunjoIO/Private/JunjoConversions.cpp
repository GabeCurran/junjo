// Junjo.io SDK for Unreal Engine

#include "JunjoConversions.h"

#include "JunjoSubsystem.h"

namespace JunjoConversions
{

// Both directions convert with explicit lengths rather than through
// the NUL-terminated convenience macros, so a string carrying an
// embedded NUL survives the round trip instead of truncating at the
// first NUL byte.
FString ToFString(const std::string& Utf8)
{
	FUTF8ToTCHAR Converted(Utf8.data(), static_cast<int32>(Utf8.size()));
	return FString(Converted.Length(), Converted.Get());
}

std::string ToUtf8(const FString& Value)
{
	FTCHARToUTF8 Converted(*Value, Value.Len());
	return std::string(Converted.Get(), static_cast<size_t>(Converted.Length()));
}

FString ToFStringOrEmpty(const std::optional<std::string>& Utf8)
{
	return Utf8.has_value() ? ToFString(*Utf8) : FString();
}

FDateTime ParseServerTimestamp(const std::string& Iso8601)
{
	FDateTime Parsed;
	const FString AsString = ToFString(Iso8601);
	if (FDateTime::ParseIso8601(*AsString, Parsed))
	{
		return Parsed;
	}
	// The return contract is unchanged (a failed parse still yields the
	// zero FDateTime), but a warning names the offending value so a wire
	// format edge surfaces in logs instead of silently becoming year 0001.
	UE_LOG(LogJunjo, Warning, TEXT("Failed to parse server timestamp '%s'; using zero FDateTime"), *AsString);
	return FDateTime();
}

EJunjoErrorCode Convert(junjo::ErrorCode Code)
{
	switch (Code)
	{
	case junjo::ErrorCode::BadRequest: return EJunjoErrorCode::BadRequest;
	case junjo::ErrorCode::InvalidApiKey: return EJunjoErrorCode::InvalidApiKey;
	case junjo::ErrorCode::InvalidAdminToken: return EJunjoErrorCode::InvalidAdminToken;
	case junjo::ErrorCode::PermissionDenied: return EJunjoErrorCode::PermissionDenied;
	case junjo::ErrorCode::NotFound: return EJunjoErrorCode::NotFound;
	case junjo::ErrorCode::AlreadyMember: return EJunjoErrorCode::AlreadyMember;
	case junjo::ErrorCode::RoleHasMembers: return EJunjoErrorCode::RoleHasMembers;
	case junjo::ErrorCode::RoleNameTaken: return EJunjoErrorCode::RoleNameTaken;
	case junjo::ErrorCode::RoleGroupMismatch: return EJunjoErrorCode::RoleGroupMismatch;
	case junjo::ErrorCode::ParentCycle: return EJunjoErrorCode::ParentCycle;
	case junjo::ErrorCode::Banned: return EJunjoErrorCode::Banned;
	case junjo::ErrorCode::PasscodeRequired: return EJunjoErrorCode::PasscodeRequired;
	case junjo::ErrorCode::PasscodeInvalid: return EJunjoErrorCode::PasscodeInvalid;
	case junjo::ErrorCode::InvitationExpired: return EJunjoErrorCode::InvitationExpired;
	case junjo::ErrorCode::InvitationUsed: return EJunjoErrorCode::InvitationUsed;
	case junjo::ErrorCode::RestoreWindowExpired: return EJunjoErrorCode::RestoreWindowExpired;
	case junjo::ErrorCode::RateLimitExceeded: return EJunjoErrorCode::RateLimitExceeded;
	case junjo::ErrorCode::Internal: return EJunjoErrorCode::Internal;
	case junjo::ErrorCode::NetworkError: return EJunjoErrorCode::NetworkError;
	case junjo::ErrorCode::Timeout: return EJunjoErrorCode::Timeout;
	case junjo::ErrorCode::Cancelled: return EJunjoErrorCode::Cancelled;
	case junjo::ErrorCode::InvalidWireData: return EJunjoErrorCode::InvalidWireData;
	case junjo::ErrorCode::InvalidConfig: return EJunjoErrorCode::InvalidConfig;
	case junjo::ErrorCode::StreamOverflow: return EJunjoErrorCode::StreamOverflow;
	case junjo::ErrorCode::WebhookSignatureMissing: return EJunjoErrorCode::WebhookSignatureMissing;
	case junjo::ErrorCode::WebhookTimestampMissing: return EJunjoErrorCode::WebhookTimestampMissing;
	case junjo::ErrorCode::WebhookInvalidSignature: return EJunjoErrorCode::WebhookInvalidSignature;
	case junjo::ErrorCode::WebhookTimestampInvalid: return EJunjoErrorCode::WebhookTimestampInvalid;
	case junjo::ErrorCode::WebhookTimestampOutOfTolerance: return EJunjoErrorCode::WebhookTimestampOutOfTolerance;
	case junjo::ErrorCode::WebhookInvalidBody: return EJunjoErrorCode::WebhookInvalidBody;
	case junjo::ErrorCode::Unknown: return EJunjoErrorCode::Unknown;
	// No default: the switch is exhaustive today, and the static_assert
	// below is the reminder to extend the mirror (a switch warning
	// cannot be relied on; UBT does not enable one for unhandled
	// enumerators). The fallthrough return covers the runtime side.
	}
	return EJunjoErrorCode::Unknown;
}

// Breaks the build on every compiler when junjo::ErrorCode grows. The
// native enum has no count sentinel, so this pins the value of its
// last enumerator (Unknown is documented as the catch-all and stays
// last); adding or reordering enumerators shifts it and fails here,
// pointing at the switch above and the EJunjoErrorCode mirror.
static_assert(static_cast<int>(junjo::ErrorCode::Unknown) == 30,
	"junjo::ErrorCode changed: extend the switch in Convert and the EJunjoErrorCode mirror");

FJunjoError Convert(const junjo::Error& Native)
{
	FJunjoError Out;
	Out.Code = Convert(Native.code);
	Out.RawCode = ToFString(Native.raw_code);
	Out.Message = ToFString(Native.message);
	Out.bHasStatus = Native.status.has_value();
	Out.Status = Native.status.value_or(0);
	Out.RequestId = ToFStringOrEmpty(Native.request_id);
	Out.RetryAfterSeconds = Native.retry_after_seconds.value_or(-1);
	return Out;
}

FJunjoKeyInfo Convert(const junjo::KeyInfo& Native)
{
	FJunjoKeyInfo Out;
	Out.GameId = ToFString(Native.game_id);
	return Out;
}

EJunjoPermissionSource Convert(junjo::PermissionSource Source)
{
	switch (Source)
	{
	case junjo::PermissionSource::Role: return EJunjoPermissionSource::Role;
	case junjo::PermissionSource::Override: return EJunjoPermissionSource::Override;
	case junjo::PermissionSource::Default: return EJunjoPermissionSource::Default;
	case junjo::PermissionSource::None: return EJunjoPermissionSource::None;
	}
	return EJunjoPermissionSource::None;
}

FJunjoPermissionCheck Convert(const junjo::PermissionCheckResult& Native)
{
	FJunjoPermissionCheck Out;
	Out.bAllowed = Native.allowed;
	Out.Source = Convert(Native.source);
	Out.ViaRoleId = ToFStringOrEmpty(Native.via_role_id);
	return Out;
}

FJunjoGroup Convert(const junjo::Group& Native)
{
	FJunjoGroup Out;
	Out.Id = ToFString(Native.id);
	Out.GameId = ToFString(Native.game_id);
	Out.Kind = ToFString(Native.kind);
	Out.Name = ToFString(Native.name);
	Out.Visibility = ToFString(Native.visibility);
	Out.MetadataJson = ToFString(Native.metadata_json);
	Out.DefaultRoleId = ToFStringOrEmpty(Native.default_role_id);
	Out.ParentGroupId = ToFStringOrEmpty(Native.parent_group_id);
	Out.MemberCount = Native.member_count;
	Out.bHasPasscode = Native.has_passcode;
	Out.CreatedAt = ParseServerTimestamp(Native.created_at);
	Out.UpdatedAt = ParseServerTimestamp(Native.updated_at);
	Out.bHasSoftDeletedAt = Native.soft_deleted_at.has_value();
	if (Native.soft_deleted_at.has_value())
	{
		Out.SoftDeletedAt = ParseServerTimestamp(*Native.soft_deleted_at);
	}
	return Out;
}

FJunjoMember Convert(const junjo::Member& Native)
{
	FJunjoMember Out;
	Out.Id = ToFString(Native.id);
	Out.GroupId = ToFString(Native.group_id);
	Out.UserId = ToFString(Native.user_id);
	Out.Status = ToFString(Native.status);
	Out.Roles.Reserve(static_cast<int32>(Native.roles.size()));
	for (const std::string& Role : Native.roles)
	{
		Out.Roles.Add(ToFString(Role));
	}
	Out.MetadataJson = ToFString(Native.metadata_json);
	Out.bHasNotesPublic = Native.notes_public.has_value();
	if (Native.notes_public.has_value())
	{
		Out.NotesPublic = ToFString(*Native.notes_public);
	}
	Out.bHasNotesPrivate = Native.notes_private.has_value();
	if (Native.notes_private.has_value())
	{
		Out.NotesPrivate = ToFString(*Native.notes_private);
	}
	Out.JoinedAt = ParseServerTimestamp(Native.joined_at);
	Out.bHasBannedUntil = Native.banned_until.has_value();
	if (Native.banned_until.has_value())
	{
		Out.BannedUntil = ParseServerTimestamp(*Native.banned_until);
	}
	return Out;
}

FJunjoRole Convert(const junjo::Role& Native)
{
	FJunjoRole Out;
	Out.Id = ToFString(Native.id);
	Out.GroupId = ToFString(Native.group_id);
	Out.Name = ToFString(Native.name);
	Out.Priority = Native.priority;
	Out.Color = ToFStringOrEmpty(Native.color);
	Out.bIsDefault = Native.is_default;
	Out.Permissions.Reserve(static_cast<int32>(Native.permissions.size()));
	for (const std::string& Permission : Native.permissions)
	{
		Out.Permissions.Add(ToFString(Permission));
	}
	Out.CreatedAt = ParseServerTimestamp(Native.created_at);
	return Out;
}

FJunjoGroupPage Convert(const junjo::Page<junjo::Group>& Native)
{
	FJunjoGroupPage Out;
	Out.Items.Reserve(static_cast<int32>(Native.items.size()));
	for (const junjo::Group& Group : Native.items)
	{
		Out.Items.Add(Convert(Group));
	}
	Out.bHasMore = Native.next_cursor.has_value();
	Out.NextCursor = ToFStringOrEmpty(Native.next_cursor);
	return Out;
}

FJunjoMemberPage Convert(const junjo::Page<junjo::Member>& Native)
{
	FJunjoMemberPage Out;
	Out.Items.Reserve(static_cast<int32>(Native.items.size()));
	for (const junjo::Member& Member : Native.items)
	{
		Out.Items.Add(Convert(Member));
	}
	Out.bHasMore = Native.next_cursor.has_value();
	Out.NextCursor = ToFStringOrEmpty(Native.next_cursor);
	return Out;
}

}
