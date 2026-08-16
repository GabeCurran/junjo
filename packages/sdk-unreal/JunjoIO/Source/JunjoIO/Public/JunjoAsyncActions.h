// Junjo.io SDK for Unreal Engine
//
// Blueprint async action nodes for the representative operations:
// Check Permission, Get Group, Create Group, List Groups, Join Group.
// Each node wraps the matching UJunjoSubsystem method as a latent
// Blueprint node with OnSuccess and OnFailure exec pins (Get Group
// Async adds a third, OnNotFound); the callback delegates on the
// subsystem remain the surface for C++ and for Blueprint code that
// prefers explicit binding.
//
// Subsystem resolution: the factories take a WorldContextObject and
// resolve the game instance's UJunjoSubsystem themselves, rather than
// taking a subsystem pin. A game instance subsystem is unambiguous
// from any world context, the WorldContext meta fills the pin
// invisibly in actor graphs, and the action must register with that
// same game instance anyway to survive garbage collection, so a
// subsystem input would only add nodes to every call site without
// adding information.
//
// Pin signatures: within one action, every exec pin (OnSuccess,
// OnFailure, and Get Group Async's OnNotFound) shares an identical
// delegate signature on purpose. The async node builds its data pins
// from its first delegate property and later delegates fill pins by
// name, so identical signatures keep every data pin populated on
// every path (Error is default constructed on success, the payload on
// failure).
//
// Lifetime: the factory registers the action with the game instance,
// so it outlives the calling graph until its one callback lands; the
// handler broadcasts once on the game thread, then SetReadyToDestroy
// releases it. Cancel (on the node's AsyncAction pin) guarantees no
// pin ever fires afterwards; the pending subsystem callback cannot be
// recalled, so the handler simply drops it.
#pragma once

#include "CoreMinimal.h"
#include "Engine/CancellableAsyncAction.h"

#include "JunjoTypes.h"

#include "JunjoAsyncActions.generated.h"

class UJunjoSubsystem;

// Async-node pin signatures. One per payload shape, used for both the
// success and failure pin of the owning action (see the header
// comment for why the shapes match). The bSuccess flag of the
// subsystem delegates has no counterpart here: the fired exec pin
// already carries that bit.
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnJunjoPermissionCheckPin, const FJunjoPermissionCheck&, Result, const FJunjoError&, Error);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_ThreeParams(FOnJunjoGroupPin, bool, bFound, const FJunjoGroup&, Group, const FJunjoError&, Error);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(FOnJunjoGroupPagePin, const FJunjoGroupPage&, Page, const FJunjoError&, Error);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnJunjoCompletedPin, const FJunjoError&, Error);

// Machinery shared by every Junjo async node: the captured world
// context, subsystem resolution, and the cancellation flag the
// handlers consult before broadcasting.
UCLASS(Abstract)
class JUNJOIO_API UJunjoAsyncAction : public UCancellableAsyncAction
{
	GENERATED_BODY()

public:
	// After Cancel returns, no pin of this action ever fires.
	virtual void Cancel() override;

protected:
	// The game instance subsystem for the world context captured at
	// spawn; nullptr when the context is dead or has no game instance.
	UJunjoSubsystem* ResolveSubsystem() const;

	// Failure payload for an unresolvable subsystem. InvalidConfig,
	// matching the error the subsystem itself reports while inactive;
	// the inactive case proper flows through the subsystem's callback
	// and arrives on OnFailure with the subsystem's own message.
	static FJunjoError NoSubsystemError();

	// Captured by the factory; weak so a latent action never keeps a
	// dying world alive.
	TWeakObjectPtr<UObject> ContextObject;

	// Set by Cancel, checked by every handler before broadcasting.
	bool bCancelled = false;
};

// Check Permission Async: does UserId hold Permission in GroupId?
// Wraps UJunjoSubsystem::CheckPermission.
UCLASS()
class JUNJOIO_API UJunjoCheckPermissionAction final : public UJunjoAsyncAction
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Junjo|Async", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"))
	static UJunjoCheckPermissionAction* CheckPermissionAsync(UObject* WorldContextObject, const FString& GroupId, const FString& UserId, const FString& Permission, bool bInherit);

	UPROPERTY(BlueprintAssignable)
	FOnJunjoPermissionCheckPin OnSuccess;

	UPROPERTY(BlueprintAssignable)
	FOnJunjoPermissionCheckPin OnFailure;

	virtual void Activate() override;

private:
	UFUNCTION()
	void HandleResult(bool bSuccess, const FJunjoPermissionCheck& Result, const FJunjoError& Error);

	FString RequestGroupId;
	FString RequestUserId;
	FString RequestPermission;
	bool bRequestInherit = false;
};

// Get Group Async: fetch a group by id. Three exec pins: OnSuccess
// means the group was found, OnNotFound means the call worked and no
// such group is visible (bFound false, the other data pins default
// constructed), OnFailure carries the error. All three share the same
// pin signature so every data pin stays populated on every path; the
// bFound data pin is kept for parity with the subsystem delegate.
// Viewer, when non-empty, scopes visibility to that external user id:
// secret groups the viewer is not an active member of land on
// OnNotFound, matching the server's visibility scoping.
UCLASS()
class JUNJOIO_API UJunjoGetGroupAction final : public UJunjoAsyncAction
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Junjo|Async", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject", AutoCreateRefTerm = "Viewer"))
	static UJunjoGetGroupAction* GetGroupAsync(UObject* WorldContextObject, const FString& GroupId, const FString& Viewer);

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPin OnSuccess;

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPin OnFailure;

	// The call succeeded and the group is absent (or invisible to
	// Viewer). Same signature as OnSuccess by design; see the header
	// comment on pin signatures.
	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPin OnNotFound;

	virtual void Activate() override;

private:
	UFUNCTION()
	void HandleResult(bool bSuccess, bool bFound, const FJunjoGroup& Group, const FJunjoError& Error);

	FString RequestGroupId;
	FString RequestViewer;
};

// Create Group Async: create a group of the given kind and name;
// optional fields ride in Params. bFound is always true on success.
UCLASS()
class JUNJOIO_API UJunjoCreateGroupAction final : public UJunjoAsyncAction
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Junjo|Async", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject", AutoCreateRefTerm = "Params"))
	static UJunjoCreateGroupAction* CreateGroupAsync(UObject* WorldContextObject, const FString& Kind, const FString& Name, const FJunjoCreateGroupParams& Params);

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPin OnSuccess;

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPin OnFailure;

	virtual void Activate() override;

private:
	UFUNCTION()
	void HandleResult(bool bSuccess, bool bFound, const FJunjoGroup& Group, const FJunjoError& Error);

	FString RequestKind;
	FString RequestName;
	FJunjoCreateGroupParams RequestParams;
};

// List Groups Async: one page of the cursor-paginated group listing.
// Feed the page's NextCursor back through Params.Cursor for the next
// page.
UCLASS()
class JUNJOIO_API UJunjoListGroupsAction final : public UJunjoAsyncAction
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Junjo|Async", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject", AutoCreateRefTerm = "Params"))
	static UJunjoListGroupsAction* ListGroupsAsync(UObject* WorldContextObject, const FJunjoListGroupsParams& Params);

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPagePin OnSuccess;

	UPROPERTY(BlueprintAssignable)
	FOnJunjoGroupPagePin OnFailure;

	virtual void Activate() override;

private:
	UFUNCTION()
	void HandleResult(bool bSuccess, const FJunjoGroupPage& Page, const FJunjoError& Error);

	FJunjoListGroupsParams RequestParams;
};

// Join Group Async: open join of a public group. Passcode is required
// when the group has one set (FJunjoGroup::bHasPasscode); leave it
// empty otherwise.
UCLASS()
class JUNJOIO_API UJunjoJoinGroupAction final : public UJunjoAsyncAction
{
	GENERATED_BODY()

public:
	UFUNCTION(BlueprintCallable, Category = "Junjo|Async", meta = (BlueprintInternalUseOnly = "true", WorldContext = "WorldContextObject"))
	static UJunjoJoinGroupAction* JoinGroupAsync(UObject* WorldContextObject, const FString& GroupId, const FString& UserId, const FString& Passcode);

	UPROPERTY(BlueprintAssignable)
	FOnJunjoCompletedPin OnSuccess;

	UPROPERTY(BlueprintAssignable)
	FOnJunjoCompletedPin OnFailure;

	virtual void Activate() override;

private:
	UFUNCTION()
	void HandleResult(bool bSuccess, const FJunjoError& Error);

	FString RequestGroupId;
	FString RequestUserId;
	FString RequestPasscode;
};
