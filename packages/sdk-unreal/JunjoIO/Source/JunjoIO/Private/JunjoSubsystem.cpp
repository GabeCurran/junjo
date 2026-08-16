// Junjo.io SDK for Unreal Engine
//
// UJunjoSubsystem implementation. Async shape, identical for every
// call: copy the native client handle and the already-converted
// arguments into a task, post it to the subsystem's worker pool where
// the blocking SDK call runs, then marshal the junjo::Result to the
// game thread and fire the caller's delegate there. Nothing on the
// worker thread touches subsystem members; everything a task needs
// travels inside it by value.

#include "JunjoSubsystem.h"

#include <chrono>
#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "Async/Async.h"
#include "HAL/PlatformMisc.h"
#include "HttpModule.h"
#include "Math/UnrealMathUtility.h"
#include "UObject/WeakObjectPtrTemplates.h"

#include "JunjoConversions.h"
#include "JunjoEventStream.h"
#include "JunjoSettings.h"
#include "JunjoUnrealTransport.h"

DEFINE_LOG_CATEGORY(LogJunjo);

namespace
{

using JunjoConversions::Convert;
using JunjoConversions::ToFString;
using JunjoConversions::ToUtf8;

// The error every async method reports while the subsystem is
// inactive. InvalidConfig matches the native SDK's "client was never
// viable" classification.
FJunjoError InactiveError()
{
	FJunjoError Error;
	Error.Code = EJunjoErrorCode::InvalidConfig;
	Error.Message = TEXT("Junjo subsystem is inactive: JUNJO_API_KEY was not set or client creation failed at startup (see the LogJunjo startup message)");
	return Error;
}

// Shared plumbing for every async method. Call(Token) runs on a
// worker thread and returns a junjo::Result; Fire(Result) runs on the
// game thread and fires the caller's delegate. Both functors own
// copies of everything they touch. Token is the subsystem's shutdown
// token; every call site threads it into its native call so
// Deinitialize can cancel queued and in-flight work.
template <typename CallType, typename FireType>
void RunJunjoCall(junjo::Executor& Executor, UJunjoSubsystem* Subsystem,
	junjo::CancellationToken Token, CallType Call, FireType Fire)
{
	TWeakObjectPtr<UJunjoSubsystem> WeakThis(Subsystem);
	Executor.post([WeakThis, Token = MoveTemp(Token), Call = MoveTemp(Call), Fire = MoveTemp(Fire)]() mutable
	{
		auto CallResult = Call(Token);
		AsyncTask(ENamedThreads::GameThread,
			[WeakThis, Fire = MoveTemp(Fire), CallResult = MoveTemp(CallResult)]() mutable
			{
				// WeakThis gates subsystem member access only, and no
				// continuation in this slice touches subsystem state,
				// so it is deliberately unread. The delegate fires
				// whether or not the subsystem survived: a dynamic
				// delegate whose target object died is a safe unbound
				// no-op. Call() itself can never race Deinitialize,
				// because Deinitialize drains the executor (running
				// every queued task to completion) before the client
				// is dropped; only this game-thread hop can land
				// after teardown.
				(void)WeakThis;
				Fire(MoveTemp(CallResult));
			});
	});
}

// Completion-only firing, shared by the calls whose payload the
// delegate surface does not carry (join, leave, kick, ban, unban).
template <typename ResultType>
void FireCompleted(const FOnJunjoCompleted& Callback, const ResultType& CallResult)
{
	if (CallResult)
	{
		Callback.ExecuteIfBound(true, FJunjoError());
	}
	else
	{
		Callback.ExecuteIfBound(false, Convert(CallResult.error()));
	}
}

}

void UJunjoSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);

	// FJunjoUnrealTransport's precondition: FHttpModule must be
	// touched once from the game thread before any transport call runs
	// on a worker thread, because module loading is game-thread only.
	// Subsystem Initialize runs on the game thread, so this satisfies
	// it for every worker-thread request that follows.
	FHttpModule::Get();

	// The API key comes from the environment on purpose; see
	// JunjoSettings.h for why it must never live in config. Absence is
	// the normal state everywhere except your game servers.
	const FString ApiKey = FPlatformMisc::GetEnvironmentVariable(TEXT("JUNJO_API_KEY"));
	if (ApiKey.IsEmpty())
	{
		UE_LOG(LogJunjo, Log,
			TEXT("JUNJO_API_KEY is not set; the Junjo subsystem stays inactive. This is expected on player clients. Game servers must set JUNJO_API_KEY in the server environment."));
		return;
	}

	const UJunjoSettings* Settings = GetDefault<UJunjoSettings>();

	// JUNJO_BASE_URL overrides the configured base URL when set, so a
	// containerized server can be pointed at an environment (staging,
	// self-hosted, local) purely through its environment, the same way
	// the key arrives, without re-cooking config into the build.
	const FString EnvBaseUrl = FPlatformMisc::GetEnvironmentVariable(TEXT("JUNJO_BASE_URL"));

	junjo::ClientConfig Config;
	Config.api_key = ToUtf8(ApiKey);
	Config.base_url = ToUtf8(EnvBaseUrl.IsEmpty() ? Settings->BaseUrl : EnvBaseUrl);
	// Seconds to milliseconds; a configured value of zero or less
	// stays zero or less, which the native client treats as "timeout
	// disabled", matching the setting's contract.
	Config.timeout = std::chrono::milliseconds(
		FMath::RoundToInt64(static_cast<double>(Settings->RequestTimeoutSeconds) * 1000.0));
	ConfiguredTimeoutMs = Config.timeout.count();
	Config.transport = std::make_shared<FJunjoUnrealTransport>();

	junjo::Result<junjo::Client> Created = junjo::Client::create(std::move(Config));
	if (!Created)
	{
		UE_LOG(LogJunjo, Warning,
			TEXT("Junjo client creation failed (%s); the Junjo subsystem stays inactive. Player clients are not expected to reach this path: only game servers should set JUNJO_API_KEY."),
			*ToFString(Created.error().message));
		return;
	}

	NativeClient.Emplace(MoveTemp(Created).value());
	Executor = MakeUnique<junjo::ThreadPoolExecutor>(2);
}

void UJunjoSubsystem::Deinitialize()
{
	// Teardown order matters; cancellation strictly first, then event
	// streams, then the executor, then the client:
	//   1. The shutdown source is cancelled before anything else, so
	//      every buffered call still queued fails fast at its first
	//      token check and every in-flight one stops at the
	//      transport's next poll; nothing below waits out a slow
	//      request.
	//   2. Closing an Open stream joins its dedicated callback thread,
	//      so once this loop finishes no SSE callback is running or
	//      will ever run; closing a Connecting stream flips its state
	//      so the connect continuation discards the subscription it
	//      produces. Streams closed after the client was dropped would
	//      instead race their reads against its teardown.
	//   3. The executor's destructor drains every queued task and
	//      joins its threads, so no worker can still be using the
	//      client. An in-flight subscribe drains quickly: closing its
	//      Connecting stream above cancelled the subscribe's token,
	//      which the transport observes at its next poll.
	//   4. The client goes last, now provably unreferenced.
	// Close() unlinks each stream from ActiveStreams, so iterate a
	// copy.
	ShutdownSource.request_cancellation();

	TArray<TObjectPtr<UJunjoEventStream>> Streams = ActiveStreams;
	for (UJunjoEventStream* Stream : Streams)
	{
		if (Stream != nullptr)
		{
			Stream->Close();
		}
	}
	ActiveStreams.Empty();

	Executor.Reset();
	NativeClient.Reset();

	Super::Deinitialize();
}

bool UJunjoSubsystem::IsActive() const
{
	return NativeClient.IsSet();
}

junjo::Client* UJunjoSubsystem::GetNativeClient()
{
	return NativeClient.GetPtrOrNull();
}

void UJunjoSubsystem::KeyInfo(FOnJunjoKeyInfo Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, FJunjoKeyInfo(), InactiveError());
		return;
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue()](const junjo::CancellationToken& Token)
		{
			return Client.key_info(Token);
		},
		[Callback](junjo::Result<junjo::KeyInfo> CallResult)
		{
			if (CallResult)
			{
				Callback.ExecuteIfBound(true, Convert(CallResult.value()), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, FJunjoKeyInfo(), Convert(CallResult.error()));
			}
		});
}

// The engine's function-like check() macro would rewrite the
// Client::check member call below at the call site (macro expansion
// does not care what precedes the identifier), so it is suspended for
// this one definition. JunjoNativeApi.h documents the collision and
// this exact pattern for game code that calls check() natively.
#pragma push_macro("check")
#undef check
void UJunjoSubsystem::CheckPermission(const FString& GroupId, const FString& UserId, const FString& Permission, bool bInherit, FOnJunjoPermissionCheck Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, FJunjoPermissionCheck(), InactiveError());
		return;
	}
	junjo::CheckOptions Options;
	Options.inherit = bInherit;
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		// Native argument order is (user, group, permission).
		[Client = NativeClient.GetValue(), User = ToUtf8(UserId), Group = ToUtf8(GroupId), Perm = ToUtf8(Permission), Options](const junjo::CancellationToken& Token)
		{
			return Client.check(User, Group, Perm, Options, Token);
		},
		[Callback](junjo::Result<junjo::PermissionCheckResult> CallResult)
		{
			if (CallResult)
			{
				Callback.ExecuteIfBound(true, Convert(CallResult.value()), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, FJunjoPermissionCheck(), Convert(CallResult.error()));
			}
		});
}

void UJunjoSubsystem::CheckPermissionBatch(const TArray<FJunjoPermissionCheckRequest>& Checks, bool bInherit, FOnJunjoPermissionCheckBatch Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, FJunjoPermissionCheckBatch(), InactiveError());
		return;
	}
	// An empty batch is a no-op the native client would answer without
	// a request; short-circuiting here keeps the callback synchronous
	// for the caller rather than round-tripping the executor.
	if (Checks.Num() == 0)
	{
		Callback.ExecuteIfBound(true, FJunjoPermissionCheckBatch(), FJunjoError());
		return;
	}

	std::vector<junjo::PermissionCheckRequest> Native;
	Native.reserve(static_cast<std::size_t>(Checks.Num()));
	for (const FJunjoPermissionCheckRequest& Entry : Checks)
	{
		Native.push_back(junjo::PermissionCheckRequest{
			.user_id = ToUtf8(Entry.UserId),
			.group_id = ToUtf8(Entry.GroupId),
			.permission = ToUtf8(Entry.Permission),
		});
	}
	junjo::CheckOptions Options;
	Options.inherit = bInherit;

	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Native = MoveTemp(Native), Options](const junjo::CancellationToken& Token)
		{
			return Client.check_batch(Native, Options, Token);
		},
		[Callback](junjo::Result<std::vector<junjo::PermissionCheckResult>> CallResult)
		{
			if (CallResult)
			{
				FJunjoPermissionCheckBatch Batch;
				Batch.Results.Reserve(static_cast<int32>(CallResult.value().size()));
				for (const junjo::PermissionCheckResult& Entry : CallResult.value())
				{
					Batch.Results.Add(Convert(Entry));
				}
				Callback.ExecuteIfBound(true, Batch, FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, FJunjoPermissionCheckBatch(), Convert(CallResult.error()));
			}
		});
}
#pragma pop_macro("check")

void UJunjoSubsystem::GetGroup(const FString& GroupId, const FString& Viewer, FOnJunjoGroup Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, false, FJunjoGroup(), InactiveError());
		return;
	}
	junjo::GetGroupOptions Options;
	if (!Viewer.IsEmpty())
	{
		// Scopes visibility to the requesting player: secret groups the
		// viewer is not an active member of come back not-found.
		Options.viewer = ToUtf8(Viewer);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Id = ToUtf8(GroupId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.groups().get(Id, Options, Token);
		},
		[Callback](junjo::Result<std::optional<junjo::Group>> CallResult)
		{
			if (!CallResult)
			{
				Callback.ExecuteIfBound(false, false, FJunjoGroup(), Convert(CallResult.error()));
			}
			else if (!CallResult.value().has_value())
			{
				// Not found is a successful answer, not an error;
				// mirrors the native Result<optional> contract.
				Callback.ExecuteIfBound(true, false, FJunjoGroup(), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(true, true, Convert(*CallResult.value()), FJunjoError());
			}
		});
}

void UJunjoSubsystem::CreateGroup(const FString& Kind, const FString& Name, const FJunjoCreateGroupParams& Params, FOnJunjoGroup Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, false, FJunjoGroup(), InactiveError());
		return;
	}
	junjo::CreateGroupInput Input;
	Input.kind = ToUtf8(Kind);
	Input.name = ToUtf8(Name);
	if (!Params.Visibility.IsEmpty())
	{
		Input.visibility = ToUtf8(Params.Visibility);
	}
	if (!Params.MetadataJson.IsEmpty())
	{
		Input.metadata_json = ToUtf8(Params.MetadataJson);
	}
	if (!Params.Passcode.IsEmpty())
	{
		Input.passcode = ToUtf8(Params.Passcode);
	}
	if (!Params.CreatorUserId.IsEmpty())
	{
		Input.creator_user_id = ToUtf8(Params.CreatorUserId);
	}
	if (!Params.DefaultRoleId.IsEmpty())
	{
		Input.default_role_id = ToUtf8(Params.DefaultRoleId);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Input = MoveTemp(Input)](const junjo::CancellationToken& Token)
		{
			return Client.groups().create(Input, {}, Token);
		},
		[Callback](junjo::Result<junjo::Group> CallResult)
		{
			if (CallResult)
			{
				Callback.ExecuteIfBound(true, true, Convert(CallResult.value()), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, false, FJunjoGroup(), Convert(CallResult.error()));
			}
		});
}

void UJunjoSubsystem::ListGroups(const FJunjoListGroupsParams& Params, FOnJunjoGroupPage Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, FJunjoGroupPage(), InactiveError());
		return;
	}
	junjo::ListGroupsOptions Options;
	if (Params.Limit > 0)
	{
		Options.limit = Params.Limit;
	}
	if (!Params.Cursor.IsEmpty())
	{
		Options.cursor = ToUtf8(Params.Cursor);
	}
	if (!Params.Viewer.IsEmpty())
	{
		Options.viewer = ToUtf8(Params.Viewer);
	}
	if (!Params.Kind.IsEmpty())
	{
		Options.kind = ToUtf8(Params.Kind);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.groups().list(Options, Token);
		},
		[Callback](junjo::Result<junjo::Page<junjo::Group>> CallResult)
		{
			if (CallResult)
			{
				Callback.ExecuteIfBound(true, Convert(CallResult.value()), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, FJunjoGroupPage(), Convert(CallResult.error()));
			}
		});
}

void UJunjoSubsystem::ListMembers(const FString& GroupId, const FJunjoListMembersParams& Params, FOnJunjoMemberPage Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, FJunjoMemberPage(), InactiveError());
		return;
	}
	junjo::ListMembersOptions Options;
	if (Params.Limit > 0)
	{
		Options.limit = Params.Limit;
	}
	if (!Params.Cursor.IsEmpty())
	{
		Options.cursor = ToUtf8(Params.Cursor);
	}
	Options.status.reserve(static_cast<size_t>(Params.Status.Num()));
	for (const FString& Status : Params.Status)
	{
		Options.status.push_back(ToUtf8(Status));
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Id = ToUtf8(GroupId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.members().list(Id, Options, Token);
		},
		[Callback](junjo::Result<junjo::Page<junjo::Member>> CallResult)
		{
			if (CallResult)
			{
				Callback.ExecuteIfBound(true, Convert(CallResult.value()), FJunjoError());
			}
			else
			{
				Callback.ExecuteIfBound(false, FJunjoMemberPage(), Convert(CallResult.error()));
			}
		});
}

void UJunjoSubsystem::JoinGroup(const FString& GroupId, const FString& UserId, const FString& Passcode, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	junjo::JoinGroupOptions Options;
	if (!Passcode.IsEmpty())
	{
		// Passcodes are 4 chars minimum server-side, so empty
		// unambiguously means "no passcode supplied".
		Options.passcode = ToUtf8(Passcode);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Group = ToUtf8(GroupId), User = ToUtf8(UserId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.groups().join(Group, User, Options, Token);
		},
		[Callback](junjo::Result<junjo::Member> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

void UJunjoSubsystem::AddMember(const FString& GroupId, const FString& UserId, const FString& RoleId, const FString& ActorUserId, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	junjo::AddMemberOptions Options;
	if (!RoleId.IsEmpty())
	{
		Options.role_id = ToUtf8(RoleId);
	}
	if (!ActorUserId.IsEmpty())
	{
		Options.actor_user_id = ToUtf8(ActorUserId);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Group = ToUtf8(GroupId), User = ToUtf8(UserId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.members().add(Group, User, Options, Token);
		},
		[Callback](junjo::Result<junjo::Member> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

void UJunjoSubsystem::LeaveGroup(const FString& GroupId, const FString& UserId, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Group = ToUtf8(GroupId), User = ToUtf8(UserId)](const junjo::CancellationToken& Token)
		{
			return Client.groups().leave(Group, User, {}, Token);
		},
		[Callback](junjo::Result<junjo::Member> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

void UJunjoSubsystem::KickMember(const FString& GroupId, const FString& UserId, const FString& Reason, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	junjo::KickMemberOptions Options;
	if (!Reason.IsEmpty())
	{
		Options.reason = ToUtf8(Reason);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), Group = ToUtf8(GroupId), User = ToUtf8(UserId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.groups().kick(Group, User, Options, Token);
		},
		[Callback](junjo::Result<junjo::Member> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

void UJunjoSubsystem::BanUser(const FString& UserId, const FJunjoBanParams& Params, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	junjo::AddBanOptions Options;
	if (!Params.Reason.IsEmpty())
	{
		Options.reason = ToUtf8(Params.Reason);
	}
	if (!Params.ExpiresAtIso.IsEmpty())
	{
		Options.expires_at = ToUtf8(Params.ExpiresAtIso);
	}
	if (!Params.ActorUserId.IsEmpty())
	{
		Options.actor_user_id = ToUtf8(Params.ActorUserId);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), User = ToUtf8(UserId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.bans().add(User, Options, Token);
		},
		[Callback](junjo::Result<junjo::Ban> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

void UJunjoSubsystem::UnbanUser(const FString& UserId, const FString& ActorUserId, FOnJunjoCompleted Callback)
{
	if (!NativeClient.IsSet())
	{
		Callback.ExecuteIfBound(false, InactiveError());
		return;
	}
	junjo::RemoveBanOptions Options;
	if (!ActorUserId.IsEmpty())
	{
		Options.actor_user_id = ToUtf8(ActorUserId);
	}
	RunJunjoCall(*Executor, this, ShutdownSource.token(),
		[Client = NativeClient.GetValue(), User = ToUtf8(UserId), Options = MoveTemp(Options)](const junjo::CancellationToken& Token)
		{
			return Client.bans().remove(User, Options, Token);
		},
		[Callback](junjo::Result<void> CallResult)
		{
			FireCompleted(Callback, CallResult);
		});
}

UJunjoEventStream* UJunjoSubsystem::SubscribeToGroupEvents(const FString& GroupId)
{
	if (!NativeClient.IsSet())
	{
		// The delegate-based methods report inactivity through their
		// callback; a factory has no callback yet, so nullptr is the
		// inactive signal here.
		UE_LOG(LogJunjo, Warning,
			TEXT("SubscribeToGroupEvents: the Junjo subsystem is inactive (see the LogJunjo startup message); returning null."));
		return nullptr;
	}
	// When the configured timeout is disabled (zero or less), the
	// subscribe's connect phase would be unbounded, and an abandoned
	// Connecting stream would pin one of the two pool workers forever;
	// a 30 second floor bounds the connect phase only. The established
	// stream stays exempt from timeouts as before (a stream's timeout
	// never applies past connect).
	std::optional<std::chrono::milliseconds> ConnectTimeout;
	if (ConfiguredTimeoutMs <= 0)
	{
		ConnectTimeout = std::chrono::milliseconds(30000);
	}
	UJunjoEventStream* Stream = NewObject<UJunjoEventStream>(this);
	ActiveStreams.Add(Stream);
	Stream->BeginConnect(this, NativeClient.GetValue(), *Executor, GroupId, ConnectTimeout);
	return Stream;
}

void UJunjoSubsystem::NotifyStreamFinished(UJunjoEventStream* Stream)
{
	ActiveStreams.Remove(Stream);
}
