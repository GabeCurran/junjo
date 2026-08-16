// Junjo.io SDK for Unreal Engine
//
// UJunjoSubsystem: the game-facing entry point. One instance per game
// instance; fetch it with
// GetGameInstance()->GetSubsystem<UJunjoSubsystem>() (C++) or the Get
// JunjoSubsystem node (Blueprint).
//
// Activation: on Initialize the subsystem reads the JUNJO_API_KEY
// environment variable. When it is set, the native junjo::Client is
// constructed against UJunjoSettings (base URL, timeout) with the
// engine HTTP transport, and the subsystem is active. When it is not
// set, the subsystem stays inactive; this is the expected state on
// player clients, which must never hold the key. Only your dedicated
// game servers set JUNJO_API_KEY.
//
// Threading: every BlueprintCallable method here must be called on the
// game thread. The blocking SDK call runs on a small worker pool owned
// by the subsystem, and the callback delegate always fires on the game
// thread, exactly once per call. Callbacks never outlive the
// subsystem's client: Deinitialize drains the worker pool before the
// client is dropped.
//
// Scope, stated honestly: this delegate surface binds the
// representative gameplay path (identity, permission checks, group
// CRUD subset, membership moves, game-wide bans) plus live SSE event
// streams via SubscribeToGroupEvents, not the whole SDK. The full
// surface (friends, roles admin, invitations, audit, webhooks) is
// reachable today through GetNativeClient() and the junjo:: API in
// JunjoNativeApi.h; later slices bind more of it to delegates and
// Blueprint.
#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"

#include "JunjoNativeApi.h"
#include "JunjoTypes.h"

#include "JunjoSubsystem.generated.h"

DECLARE_LOG_CATEGORY_EXTERN(LogJunjo, Log, All);

class UJunjoEventStream;

UCLASS()
class JUNJOIO_API UJunjoSubsystem : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;

	// True when JUNJO_API_KEY was present at startup and the native
	// client was constructed. When false, every async method fails its
	// callback immediately (on the calling thread) with InvalidConfig.
	UFUNCTION(BlueprintPure, Category = "Junjo")
	bool IsActive() const;

	// The native junjo::Client for C++ gameplay code that needs the
	// full SDK surface. Returns nullptr when inactive. The pointed-to
	// client is owned by this subsystem and stays valid until
	// Deinitialize; copy it (junjo::Client is a cheap shared handle)
	// if you need a lifetime beyond a single call stack. A copied
	// client used from game-owned threads must not have calls in
	// flight during engine shutdown: the HTTP manager unbinds
	// delegates at shutdown, and a call with no token and no timeout
	// would then wait forever for a completion that cannot arrive.
	// Pass a junjo::CancellationToken you cancel at your own teardown
	// into every call made from such threads. Include JunjoNativeApi.h,
	// never raw junjo headers, and see that header for the check()
	// macro caveat at call sites.
	[[nodiscard]] junjo::Client* GetNativeClient();

	// GET /v1/whoami: resolves the key to its game. Cheap connectivity
	// and credential check; wire a callback and call it once at server
	// boot to verify the key.
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void KeyInfo(FOnJunjoKeyInfo Callback);

	// Does UserId hold Permission in GroupId? The callback carries the
	// full decision including its source. Wraps junjo::Client::check;
	// permission keys are game-defined open strings.
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void CheckPermission(const FString& GroupId, const FString& UserId, const FString& Permission, bool bInherit, FOnJunjoPermissionCheck Callback);

	// Resolves many checks in one round-trip. Results are positional
	// against Checks. An empty input completes immediately with an
	// empty result set and no request. bInherit applies to every
	// entry. Inputs longer than the server cap are split across
	// sequential requests by the native client.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Checks"))
	void CheckPermissionBatch(const TArray<FJunjoPermissionCheckRequest>& Checks, bool bInherit, FOnJunjoPermissionCheckBatch Callback);

	// Fetches a group by id. Not-found is not an error: the callback
	// reports bSuccess true with bFound false, mirroring the native
	// Result<optional> contract. Viewer, when non-empty, is the
	// requesting player's external user id and scopes visibility:
	// secret groups the viewer is not an active member of come back
	// not-found, matching the server's visibility scoping. Empty means
	// the server-side (admin) view that sees everything.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Viewer"))
	void GetGroup(const FString& GroupId, const FString& Viewer, FOnJunjoGroup Callback);

	// Creates a group of the given kind and name; optional fields ride
	// in Params. The callback's bFound is always true on success.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Params"))
	void CreateGroup(const FString& Kind, const FString& Name, const FJunjoCreateGroupParams& Params, FOnJunjoGroup Callback);

	// Cursor-paginated group listing. Feed the page's NextCursor back
	// through Params.Cursor for the next page.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Params"))
	void ListGroups(const FJunjoListGroupsParams& Params, FOnJunjoGroupPage Callback);

	// Cursor-paginated member listing for one group, optionally
	// filtered by status via Params.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Params"))
	void ListMembers(const FString& GroupId, const FJunjoListMembersParams& Params, FOnJunjoMemberPage Callback);

	// Open join. The group must be "public", and Passcode is required
	// when the group has one set (FJunjoGroup::bHasPasscode); leave it
	// empty otherwise.
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void JoinGroup(const FString& GroupId, const FString& UserId, const FString& Passcode, FOnJunjoCompleted Callback);

	// Adds a user to a group directly, the server-to-server
	// counterpart to JoinGroup. Ignores the group's visibility, so
	// provisioning does not have to make internal authorization groups
	// publicly joinable; bans are still enforced. Idempotent. Leave
	// RoleId empty to add with no role.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "RoleId,ActorUserId"))
	void AddMember(const FString& GroupId, const FString& UserId, const FString& RoleId, const FString& ActorUserId, FOnJunjoCompleted Callback);

	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void LeaveGroup(const FString& GroupId, const FString& UserId, FOnJunjoCompleted Callback);

	// Kicks a member; unlike a ban, a kicked user may rejoin. Reason
	// is recorded in the audit trail when non-empty (capped at 500
	// chars server-side).
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void KickMember(const FString& GroupId, const FString& UserId, const FString& Reason, FOnJunjoCompleted Callback);

	// Game-wide ban: the user cannot join or accept invitations into
	// any group in the game while it is active. Per-group bans are a
	// separate surface, reachable through the native client.
	UFUNCTION(BlueprintCallable, Category = "Junjo", meta = (AutoCreateRefTerm = "Params"))
	void BanUser(const FString& UserId, const FJunjoBanParams& Params, FOnJunjoCompleted Callback);

	// Lifts a game-wide ban. ActorUserId, when non-empty, is recorded
	// for audit attribution.
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	void UnbanUser(const FString& UserId, const FString& ActorUserId, FOnJunjoCompleted Callback);

	// Opens the group's live event stream (SSE, GET /v1/events/:id)
	// and returns the stream object immediately in the Connecting
	// state, or nullptr when the subsystem is inactive. The native
	// subscribe blocks until the server accepts or rejects, so it runs
	// on the worker pool, never on the game thread; bind the returned
	// stream's delegates right after this call, which is always in
	// time because nothing can fire before the current game-thread
	// task completes. See UJunjoEventStream for the state machine,
	// threading, and the no-auto-reconnect contract.
	UFUNCTION(BlueprintCallable, Category = "Junjo")
	UJunjoEventStream* SubscribeToGroupEvents(const FString& GroupId);

private:
	friend class UJunjoEventStream;

	// Streams call this on any terminal transition (Close, server
	// close, stream error, connect failure) to drop the subsystem's
	// keep-alive reference.
	void NotifyStreamFinished(UJunjoEventStream* Stream);

	// Live (Connecting or Open) event streams. Referenced here so a
	// stream keeps delivering even when the Blueprint that requested
	// it dropped its own reference; Deinitialize closes every entry.
	UPROPERTY()
	TArray<TObjectPtr<UJunjoEventStream>> ActiveStreams;

	// Declared before Executor so that even implicit member
	// destruction (reverse declaration order) tears the executor down
	// first; Deinitialize does the same explicitly and documents why.
	TOptional<junjo::Client> NativeClient;

	// Worker pool for the async surface, 2 threads. Its destructor
	// drains every queued task, so no posted task, and therefore no
	// in-flight SDK call, ever outlives this subsystem.
	TUniquePtr<junjo::ThreadPoolExecutor> Executor;

	// Cancelled first thing in Deinitialize. Every buffered call posted
	// through RunJunjoCall carries this source's token, so teardown
	// never has to wait out a slow request: a queued task fails fast
	// and an in-flight one stops at the transport's next token poll,
	// keeping the executor drain bounded.
	junjo::CancellationSource ShutdownSource;

	// The client-level request timeout configured at Initialize, in
	// milliseconds; zero or less means disabled. Kept so
	// SubscribeToGroupEvents can decide whether the subscribe's connect
	// phase needs the floor timeout (see the definition).
	int64 ConfiguredTimeoutMs = 0;
};
