// Junjo.io SDK for Unreal Engine
//
// Async action implementations. One shape, five times: the factory
// captures the request arguments and registers with the game
// instance, Activate resolves the subsystem and hands it a dynamic
// delegate bound to the action's UFUNCTION handler (dynamic single
// cast delegates bind reflected functions, not lambdas), and the
// handler broadcasts the matching pin exactly once on the game thread
// before releasing the action.

#include "JunjoAsyncActions.h"

#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"

#include "JunjoSubsystem.h"

void UJunjoAsyncAction::Cancel()
{
	// The subsystem callback for an in-flight call still arrives
	// (there is no recall); the handlers check this flag and drop it.
	bCancelled = true;
	Super::Cancel();
}

UJunjoSubsystem* UJunjoAsyncAction::ResolveSubsystem() const
{
	const UWorld* World = GEngine ? GEngine->GetWorldFromContextObject(ContextObject.Get(), EGetWorldErrorMode::LogAndReturnNull) : nullptr;
	UGameInstance* GameInstance = World ? World->GetGameInstance() : nullptr;
	return GameInstance ? GameInstance->GetSubsystem<UJunjoSubsystem>() : nullptr;
}

FJunjoError UJunjoAsyncAction::NoSubsystemError()
{
	FJunjoError Error;
	Error.Code = EJunjoErrorCode::InvalidConfig;
	Error.Message = TEXT("No Junjo subsystem: the world context does not resolve to a game instance");
	return Error;
}

UJunjoCheckPermissionAction* UJunjoCheckPermissionAction::CheckPermissionAsync(UObject* WorldContextObject, const FString& GroupId, const FString& UserId, const FString& Permission, bool bInherit)
{
	UJunjoCheckPermissionAction* Action = NewObject<UJunjoCheckPermissionAction>();
	Action->ContextObject = WorldContextObject;
	Action->RequestGroupId = GroupId;
	Action->RequestUserId = UserId;
	Action->RequestPermission = Permission;
	Action->bRequestInherit = bInherit;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void UJunjoCheckPermissionAction::Activate()
{
	UJunjoSubsystem* Subsystem = ResolveSubsystem();
	if (Subsystem == nullptr)
	{
		if (!bCancelled)
		{
			OnFailure.Broadcast(FJunjoPermissionCheck(), NoSubsystemError());
		}
		SetReadyToDestroy();
		return;
	}
	FOnJunjoPermissionCheck Callback;
	Callback.BindDynamic(this, &UJunjoCheckPermissionAction::HandleResult);
	// An inactive subsystem fires this callback synchronously with its
	// InvalidConfig error; the K2 node binds the pins before Activate,
	// so the immediate OnFailure broadcast is delivered. Same for the
	// other four actions.
	Subsystem->CheckPermission(RequestGroupId, RequestUserId, RequestPermission, bRequestInherit, Callback);
}

void UJunjoCheckPermissionAction::HandleResult(bool bSuccess, const FJunjoPermissionCheck& Result, const FJunjoError& Error)
{
	if (!bCancelled)
	{
		(bSuccess ? OnSuccess : OnFailure).Broadcast(Result, Error);
	}
	SetReadyToDestroy();
}

UJunjoGetGroupAction* UJunjoGetGroupAction::GetGroupAsync(UObject* WorldContextObject, const FString& GroupId, const FString& Viewer)
{
	UJunjoGetGroupAction* Action = NewObject<UJunjoGetGroupAction>();
	Action->ContextObject = WorldContextObject;
	Action->RequestGroupId = GroupId;
	Action->RequestViewer = Viewer;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void UJunjoGetGroupAction::Activate()
{
	UJunjoSubsystem* Subsystem = ResolveSubsystem();
	if (Subsystem == nullptr)
	{
		if (!bCancelled)
		{
			OnFailure.Broadcast(false, FJunjoGroup(), NoSubsystemError());
		}
		SetReadyToDestroy();
		return;
	}
	FOnJunjoGroup Callback;
	Callback.BindDynamic(this, &UJunjoGetGroupAction::HandleResult);
	Subsystem->GetGroup(RequestGroupId, RequestViewer, Callback);
}

void UJunjoGetGroupAction::HandleResult(bool bSuccess, bool bFound, const FJunjoGroup& Group, const FJunjoError& Error)
{
	if (!bCancelled)
	{
		// Three-way routing: OnSuccess means found, OnNotFound means
		// the call worked and the group is absent, OnFailure carries
		// the error. All three pins share one signature, so the data
		// pins are populated whichever fires.
		(bSuccess ? (bFound ? OnSuccess : OnNotFound) : OnFailure).Broadcast(bFound, Group, Error);
	}
	SetReadyToDestroy();
}

UJunjoCreateGroupAction* UJunjoCreateGroupAction::CreateGroupAsync(UObject* WorldContextObject, const FString& Kind, const FString& Name, const FJunjoCreateGroupParams& Params)
{
	UJunjoCreateGroupAction* Action = NewObject<UJunjoCreateGroupAction>();
	Action->ContextObject = WorldContextObject;
	Action->RequestKind = Kind;
	Action->RequestName = Name;
	Action->RequestParams = Params;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void UJunjoCreateGroupAction::Activate()
{
	UJunjoSubsystem* Subsystem = ResolveSubsystem();
	if (Subsystem == nullptr)
	{
		if (!bCancelled)
		{
			OnFailure.Broadcast(false, FJunjoGroup(), NoSubsystemError());
		}
		SetReadyToDestroy();
		return;
	}
	FOnJunjoGroup Callback;
	Callback.BindDynamic(this, &UJunjoCreateGroupAction::HandleResult);
	Subsystem->CreateGroup(RequestKind, RequestName, RequestParams, Callback);
}

void UJunjoCreateGroupAction::HandleResult(bool bSuccess, bool bFound, const FJunjoGroup& Group, const FJunjoError& Error)
{
	if (!bCancelled)
	{
		(bSuccess ? OnSuccess : OnFailure).Broadcast(bFound, Group, Error);
	}
	SetReadyToDestroy();
}

UJunjoListGroupsAction* UJunjoListGroupsAction::ListGroupsAsync(UObject* WorldContextObject, const FJunjoListGroupsParams& Params)
{
	UJunjoListGroupsAction* Action = NewObject<UJunjoListGroupsAction>();
	Action->ContextObject = WorldContextObject;
	Action->RequestParams = Params;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void UJunjoListGroupsAction::Activate()
{
	UJunjoSubsystem* Subsystem = ResolveSubsystem();
	if (Subsystem == nullptr)
	{
		if (!bCancelled)
		{
			OnFailure.Broadcast(FJunjoGroupPage(), NoSubsystemError());
		}
		SetReadyToDestroy();
		return;
	}
	FOnJunjoGroupPage Callback;
	Callback.BindDynamic(this, &UJunjoListGroupsAction::HandleResult);
	Subsystem->ListGroups(RequestParams, Callback);
}

void UJunjoListGroupsAction::HandleResult(bool bSuccess, const FJunjoGroupPage& Page, const FJunjoError& Error)
{
	if (!bCancelled)
	{
		(bSuccess ? OnSuccess : OnFailure).Broadcast(Page, Error);
	}
	SetReadyToDestroy();
}

UJunjoJoinGroupAction* UJunjoJoinGroupAction::JoinGroupAsync(UObject* WorldContextObject, const FString& GroupId, const FString& UserId, const FString& Passcode)
{
	UJunjoJoinGroupAction* Action = NewObject<UJunjoJoinGroupAction>();
	Action->ContextObject = WorldContextObject;
	Action->RequestGroupId = GroupId;
	Action->RequestUserId = UserId;
	Action->RequestPasscode = Passcode;
	Action->RegisterWithGameInstance(WorldContextObject);
	return Action;
}

void UJunjoJoinGroupAction::Activate()
{
	UJunjoSubsystem* Subsystem = ResolveSubsystem();
	if (Subsystem == nullptr)
	{
		if (!bCancelled)
		{
			OnFailure.Broadcast(NoSubsystemError());
		}
		SetReadyToDestroy();
		return;
	}
	FOnJunjoCompleted Callback;
	Callback.BindDynamic(this, &UJunjoJoinGroupAction::HandleResult);
	Subsystem->JoinGroup(RequestGroupId, RequestUserId, RequestPasscode, Callback);
}

void UJunjoJoinGroupAction::HandleResult(bool bSuccess, const FJunjoError& Error)
{
	if (!bCancelled)
	{
		(bSuccess ? OnSuccess : OnFailure).Broadcast(Error);
	}
	SetReadyToDestroy();
}
