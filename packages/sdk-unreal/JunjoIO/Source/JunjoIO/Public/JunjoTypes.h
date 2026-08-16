// Junjo.io SDK for Unreal Engine
//
// Blueprint-facing mirrors of the native junjo:: value types, the
// parameter structs the async surface accepts, and the dynamic
// delegate types UJunjoSubsystem fires. Mirrors flow one way: the
// subsystem produces them from native results, game code reads them.
//
// Optional-field conventions, chosen per field and repeated on each
// UPROPERTY:
//   - Optional strings whose present value is always non-empty (ids,
//     cursors, request ids, hex colors) use the empty-string
//     convention: empty means absent. One pin to read, no bool to
//     forget.
//   - Optional fields where the empty value would be ambiguous (member
//     notes, where an empty note is a legal stored value) or that are
//     not strings (timestamps, HTTP status) carry a paired bool named
//     bHas<Field>.
//   - FJunjoError::RetryAfterSeconds uses the sentinel -1: a negative
//     retry delay cannot occur, so no flag is needed.
//
// Timestamps are FDateTime values in UTC, parsed from the server's
// ISO 8601 wire strings; any UTC offset in the wire string is applied
// during the parse.
#pragma once

#include "CoreMinimal.h"

#include "JunjoTypes.generated.h"

// Mirror of junjo::ErrorCode; enumerator names are kept aligned. The
// first block mirrors the server's error-envelope codes, the second is
// SDK-side (transport failures and client-side validation that never
// reached the server), the third is produced only by local webhook
// verification. A newer server can send codes this SDK version does
// not know; those arrive as Unknown with the wire string preserved in
// FJunjoError::RawCode, so switches on this enum need a default
// branch.
UENUM(BlueprintType)
enum class EJunjoErrorCode : uint8
{
	// Server envelope codes.
	BadRequest,
	InvalidApiKey,
	InvalidAdminToken,
	PermissionDenied,
	NotFound,
	AlreadyMember,
	RoleHasMembers,
	RoleNameTaken,
	RoleGroupMismatch,
	ParentCycle,
	Banned,
	PasscodeRequired,
	PasscodeInvalid,
	InvitationExpired,
	InvitationUsed,
	RestoreWindowExpired,
	RateLimitExceeded,
	Internal,

	// SDK-side codes.
	NetworkError,
	Timeout,
	Cancelled,
	InvalidWireData,
	InvalidConfig,
	StreamOverflow,

	// Webhook verification codes (local checks on inbound deliveries).
	WebhookSignatureMissing,
	WebhookTimestampMissing,
	WebhookInvalidSignature,
	WebhookTimestampInvalid,
	WebhookTimestampOutOfTolerance,
	WebhookInvalidBody,

	Unknown,
};

// Mirror of junjo::PermissionSource: where a permission-check decision
// came from. This wire contract is closed (exactly these four); an
// unrecognized value fails the call as InvalidWireData instead of
// arriving here.
UENUM(BlueprintType)
enum class EJunjoPermissionSource : uint8
{
	// Granted through a role the member holds; see
	// FJunjoPermissionCheck::ViaRoleId.
	Role,
	// A per-member override decided it, in either direction.
	Override,
	// No role or override mentioned the permission; the default (deny)
	// applied.
	Default,
	// The user is not an active member of the group, or does not
	// exist.
	None,
};

// Mirror of junjo::Error. Meaningful only when the delegate that
// carried it reported bSuccess false; on success it arrives default
// constructed.
USTRUCT(BlueprintType)
struct FJunjoError
{
	GENERATED_BODY()

	// Branch on this, not on Message.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	EJunjoErrorCode Code = EJunjoErrorCode::Unknown;

	// The wire code string exactly as the server sent it; empty when
	// the failure did not come from a server error envelope. Lets game
	// code react to a server code this SDK version maps to Unknown.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString RawCode;

	// Human-readable description. Worth logging, not worth branching
	// on.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Message;

	// True when an HTTP response was actually received; only then is
	// Status meaningful.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasStatus = false;

	// HTTP status code; see bHasStatus.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	int32 Status = 0;

	// Correlation id from the server's x-request-id header, worth
	// quoting in bug reports. Empty when absent; request ids are opaque
	// non-empty tokens, so the empty string is unambiguous.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString RequestId;

	// Seconds from a rate-limited response's Retry-After header; -1
	// when absent (a negative retry delay cannot occur). The SDK never
	// retries automatically; honor this in your own backoff.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	int32 RetryAfterSeconds = -1;
};

// Mirror of junjo::KeyInfo: identity of the API key the subsystem was
// configured with, from GET /v1/whoami.
USTRUCT(BlueprintType)
struct FJunjoKeyInfo
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString GameId;
};

// Mirror of junjo::PermissionCheckResult: the full decision from a
// permission check, including where it came from.
USTRUCT(BlueprintType)
struct FJunjoPermissionCheck
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bAllowed = false;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	EJunjoPermissionSource Source = EJunjoPermissionSource::None;

	// When Source is Role, the id of the granting role; empty
	// otherwise (role ids are non-empty, so empty means absent).
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString ViaRoleId;

	// The group the decision was read from. Populated only on an
	// inherited check that reached a decision; empty otherwise. It
	// equals the queried group when the decision was direct rather
	// than inherited.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString ViaGroupId;
};

// Mirror of junjo::PermissionCheckRequest: one entry of a batched
// permission check.
USTRUCT(BlueprintType)
struct FJunjoPermissionCheckRequest
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString UserId;

	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString GroupId;

	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Permission;
};

// Results of a batched permission check, positional: Results[i]
// answers the request at index i. Wrapped in a struct because a
// dynamic delegate cannot carry a bare TArray.
USTRUCT(BlueprintType)
struct FJunjoPermissionCheckBatch
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	TArray<FJunjoPermissionCheck> Results;
};

// Mirror of junjo::Group. What a group means is the game's choice; the
// SDK does not interpret the taxonomy.
USTRUCT(BlueprintType)
struct FJunjoGroup
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Id;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString GameId;

	// Open taxonomy string chosen by the game, stored verbatim by the
	// server.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Kind;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Name;

	// "public", "invite-only", or "secret". Kept as a string so a
	// newer server introducing a visibility does not become a
	// client-side parse failure.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Visibility;

	// The group's metadata object as raw JSON text, always a valid
	// JSON object serialization ("{}" when empty). Parse with the JSON
	// utilities of your choice.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString MetadataJson;

	// Empty when the group has no default role (role ids are
	// non-empty, so empty means absent).
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString DefaultRoleId;

	// Empty when this is a top-level group (group ids are non-empty,
	// so empty means absent).
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString ParentGroupId;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	int64 MemberCount = 0;

	// True when the group has a passcode set; prompt for one before
	// join. The plaintext passcode is never returned.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasPasscode = false;

	// UTC.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime CreatedAt;

	// UTC.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime UpdatedAt;

	// True when the group is soft-deleted and still inside its restore
	// window; only then is SoftDeletedAt meaningful. Paired bool
	// because a timestamp has no natural absent value.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasSoftDeletedAt = false;

	// UTC; see bHasSoftDeletedAt.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime SoftDeletedAt;
};

// Mirror of junjo::Member: one user's membership row in one group.
USTRUCT(BlueprintType)
struct FJunjoMember
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Id;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString GroupId;

	// The game's external user id, exactly as your auth provider
	// issues it (never a Junjo-internal id).
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString UserId;

	// One of "active", "invited", "left", "kicked", "banned". Kept as
	// a string for the same forward-compatibility reason as
	// FJunjoGroup::Visibility.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Status;

	// Ids of the roles this member holds.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	TArray<FString> Roles;

	// Raw JSON object text; see FJunjoGroup::MetadataJson.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString MetadataJson;

	// True when a public note is set. Paired bool because an empty
	// note is a legal stored value, so the empty string cannot mean
	// absent. Public notes are visible to other group members.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasNotesPublic = false;

	// See bHasNotesPublic.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString NotesPublic;

	// True when a private (officer-only) note is set; same pairing
	// rationale as bHasNotesPublic.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasNotesPrivate = false;

	// See bHasNotesPrivate.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString NotesPrivate;

	// UTC.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime JoinedAt;

	// Only meaningful when Status is "banned". False with that status
	// means a permanent ban; a BannedUntil in the past means the ban
	// has lapsed (lazy expiry). Paired bool because a timestamp has no
	// natural absent value.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasBannedUntil = false;

	// UTC; see bHasBannedUntil.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime BannedUntil;
};

// Mirror of junjo::Role: a role within a group.
USTRUCT(BlueprintType)
struct FJunjoRole
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Id;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString GroupId;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Name;

	// Higher number = more authority.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	int64 Priority = 0;

	// 7-char hex color ("#ff5050") when set; empty when the role has
	// no color (a set color is never empty, so empty means absent).
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString Color;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bIsDefault = false;

	// Permission keys granted by this role; game-defined open strings.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	TArray<FString> Permissions;

	// UTC.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FDateTime CreatedAt;
};

// One page of a cursor-paginated group listing. bHasMore true means
// another page exists; pass NextCursor as the next call's cursor.
USTRUCT(BlueprintType)
struct FJunjoGroupPage
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	TArray<FJunjoGroup> Items;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasMore = false;

	// Empty on the last page; only meaningful when bHasMore is true.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString NextCursor;
};

// One page of a cursor-paginated member listing; same cursor contract
// as FJunjoGroupPage.
USTRUCT(BlueprintType)
struct FJunjoMemberPage
{
	GENERATED_BODY()

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	TArray<FJunjoMember> Items;

	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	bool bHasMore = false;

	// Empty on the last page; only meaningful when bHasMore is true.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString NextCursor;
};

// Optional fields for UJunjoSubsystem::CreateGroup. Leave a field
// empty to omit it.
USTRUCT(BlueprintType)
struct FJunjoCreateGroupParams
{
	GENERATED_BODY()

	// "public", "invite-only", or "secret"; empty uses the server
	// default ("invite-only"). Pass "public" explicitly for groups
	// players should be able to join without an invitation.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Visibility;

	// External user id of the creating player; empty means omitted.
	// When set, the server atomically adds them as an active member in
	// the create transaction. With the server's invite-only default
	// visibility this creator seat is how the creating player gets
	// membership at all: join only works on "public" groups.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString CreatorUserId;

	// Id of the role new members receive by default; empty means
	// omitted (no default role).
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString DefaultRoleId;

	// Shared-secret join gate, 4 to 128 chars; empty means no
	// passcode (the server minimum is 4 chars, so empty is
	// unambiguous).
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Passcode;

	// The group's metadata, passed through as a JSON object string
	// (for example "{\"motto\":\"onward\"}"). Empty means none. A
	// non-empty value that does not parse as a JSON object fails the
	// call with InvalidConfig before any request is made.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString MetadataJson;
};

// Options for UJunjoSubsystem::ListGroups. Leave a field at its
// default to omit it.
USTRUCT(BlueprintType)
struct FJunjoListGroupsParams
{
	GENERATED_BODY()

	// Page size; zero or less uses the server default (50, capped
	// server-side).
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	int32 Limit = 0;

	// Cursor from the previous page's NextCursor; empty starts at the
	// first page.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Cursor;

	// External user id to scope visibility to: secret groups the
	// viewer is not an active member of are filtered out. Empty means
	// the server-side (admin) view that sees everything.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Viewer;

	// Return only groups of this kind, matched exactly. Empty means
	// every kind. Filtering server-side matters because a group's Name
	// is unique per game, not per kind, so matching on name alone can
	// confuse two groups of different kinds.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Kind;
};

// Options for UJunjoSubsystem::ListMembers. Leave a field at its
// default to omit it.
USTRUCT(BlueprintType)
struct FJunjoListMembersParams
{
	GENERATED_BODY()

	// Page size; zero or less uses the server default (50, capped
	// server-side).
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	int32 Limit = 0;

	// Cursor from the previous page's NextCursor; empty starts at the
	// first page.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Cursor;

	// Filter to one or more statuses ("active", "invited", "left",
	// "kicked", "banned"). Empty array means all statuses.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	TArray<FString> Status;
};

// Optional fields for UJunjoSubsystem::BanUser (game-wide ban). Leave
// a field empty to omit it.
USTRUCT(BlueprintType)
struct FJunjoBanParams
{
	GENERATED_BODY()

	// Recorded on the ban; capped at 500 chars server-side. Empty
	// means no reason recorded.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString Reason;

	// ISO 8601 timestamp ending the ban (for example
	// "2026-09-01T00:00:00Z"); empty means permanent. The value must
	// be valid ISO 8601; an already-past instant is accepted and
	// creates a ban that is already expired.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString ExpiresAtIso;

	// External user id of the acting moderator, recorded for audit
	// attribution. Empty means issued server-side with no acting user.
	UPROPERTY(BlueprintReadWrite, Category = "Junjo")
	FString ActorUserId;
};

// Delegate contract shared by the whole async surface: bSuccess first
// so Blueprint branching is a single Branch node, the result payload
// next, FJunjoError last. On success the error is default constructed;
// on failure the payload is default constructed. Bind a callback,
// pass it to the matching UJunjoSubsystem method, and it fires exactly
// once on the game thread.

// Fired by UJunjoSubsystem::KeyInfo.
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FOnJunjoKeyInfo, bool, bSuccess, const FJunjoKeyInfo&, KeyInfo, const FJunjoError&, Error);

// Fired by UJunjoSubsystem::CheckPermission.
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FOnJunjoPermissionCheck, bool, bSuccess, const FJunjoPermissionCheck&, Result, const FJunjoError&, Error);

// Fired once for a whole batch; Batch.Results is positional against
// the requests that were sent.
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FOnJunjoPermissionCheckBatch, bool, bSuccess, const FJunjoPermissionCheckBatch&, Batch, const FJunjoError&, Error);

// Fired by UJunjoSubsystem::GetGroup and CreateGroup. bFound
// distinguishes "the call worked and there is no such group"
// (bSuccess true, bFound false) from an actual failure; it lives here
// on the delegate rather than inside FJunjoGroup so the mirror struct
// stays a pure data mirror (a found flag inside FJunjoGroup would be
// meaningless everywhere groups appear in lists). CreateGroup always
// reports bFound true on success.
DECLARE_DYNAMIC_DELEGATE_FourParams(FOnJunjoGroup, bool, bSuccess, bool, bFound, const FJunjoGroup&, Group, const FJunjoError&, Error);

// Fired by UJunjoSubsystem::ListGroups.
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FOnJunjoGroupPage, bool, bSuccess, const FJunjoGroupPage&, Page, const FJunjoError&, Error);

// Fired by UJunjoSubsystem::ListMembers.
DECLARE_DYNAMIC_DELEGATE_ThreeParams(FOnJunjoMemberPage, bool, bSuccess, const FJunjoMemberPage&, Page, const FJunjoError&, Error);

// Fired by the mutation calls that report only success or failure
// (JoinGroup, LeaveGroup, KickMember, BanUser, UnbanUser).
DECLARE_DYNAMIC_DELEGATE_TwoParams(FOnJunjoCompleted, bool, bSuccess, const FJunjoError&, Error);
