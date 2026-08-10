// Junjo.io SDK for Unreal Engine
//
// UJunjoEventStream: one live SSE subscription to a group's event
// stream (GET /v1/events/:groupId), created and owned by
// UJunjoSubsystem::SubscribeToGroupEvents. The subsystem keeps every
// live stream referenced until it reaches a terminal state, so a
// stream keeps delivering even when the Blueprint that requested it
// drops its own reference.
//
// State machine (GetState; every transition happens on the game
// thread):
//
//   Connecting  initial. The blocking native subscribe is running on
//               the subsystem's worker pool.
//   Open        the server accepted; OnConnected has fired and events
//               are delivering through OnEvent.
//   Closed      terminal. Either Close() was called (silent, no
//               delegate) or the server ended the stream cleanly
//               (OnStreamClosed fired).
//   Failed      terminal. The connect was rejected, or the open
//               stream died (network drop, malformed frame);
//               OnStreamError fired with the reason.
//
// Threading: the native SDK runs one dedicated thread per
// subscription and invokes its callbacks there. This wrapper never
// touches the UObject from that thread; every callback converts its
// payload to engine types and hops to the game thread behind a weak
// pointer, so all four delegates fire on the game thread and a
// destroyed stream object simply drops late deliveries. That
// marshaling also means no delegate handler ever runs on the stream
// thread, so calling Close() from inside OnEvent (or any other
// handler) can never hit the close-from-a-callback caveat that
// junjo/events.hpp documents for the native Subscription.
//
// There is NO auto-reconnect and the server keeps no replay buffer,
// matching the native SDK contract: when OnStreamClosed or
// OnStreamError fires, this stream is finished. Resubscribe from the
// handler with SubscribeToGroupEvents and re-fetch any state you must
// not miss; events between the drop and the resubscribe are lost.
#pragma once

#include <chrono>
#include <optional>

#include "CoreMinimal.h"
#include "UObject/Object.h"

#include "JunjoNativeApi.h"
#include "JunjoTypes.h"

#include "JunjoEventStream.generated.h"

class UJunjoSubsystem;

// See the state machine in the file header.
UENUM(BlueprintType)
enum class EJunjoStreamState : uint8
{
	Connecting,
	Open,
	Closed,
	Failed,
};

// Mirror of junjo::SseEvent: one event delivered by the stream. The
// payload stays raw JSON text on purpose: game servers switch on the
// type string and pick a handful of fields. Frames whose payload type
// this SDK version does not know are skipped before delivery, never
// delivered as raw payloads, so a newer server never breaks an older
// client; resubscribing and re-fetching state is the recovery for
// anything missed, exactly as on a dropped stream.
USTRUCT(BlueprintType)
struct FJunjoStreamEvent
{
	GENERATED_BODY()

	// The frame's event name; the server sets it to the payload's type
	// string (for example "member.joined").
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString EventType;

	// The event's unique id. Useful for logging; there is no replay to
	// feed it back into.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString EventId;

	// The event as JSON text, exactly as sent. Guaranteed to parse as
	// JSON; parse with the JSON utilities of your choice.
	UPROPERTY(BlueprintReadOnly, Category = "Junjo")
	FString PayloadJson;
};

DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnJunjoStreamConnected);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnJunjoStreamEvent, const FJunjoStreamEvent&, Event);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnJunjoStreamError, const FJunjoError&, Error);
DECLARE_DYNAMIC_MULTICAST_DELEGATE(FOnJunjoStreamClosed);

UCLASS(BlueprintType)
class JUNJOIO_API UJunjoEventStream : public UObject
{
	GENERATED_BODY()

public:
	// Connecting -> Open. Bind delegates right after
	// SubscribeToGroupEvents returns; nothing can fire before the
	// current game-thread task completes.
	UPROPERTY(BlueprintAssignable, Category = "Junjo|Events")
	FOnJunjoStreamConnected OnConnected;

	// One broadcast per event, in stream order, on the game thread.
	UPROPERTY(BlueprintAssignable, Category = "Junjo|Events")
	FOnJunjoStreamEvent OnEvent;

	// Terminal: the connect was rejected or the open stream died. The
	// stream is already finished when this fires; resubscribe and
	// re-fetch missed state.
	UPROPERTY(BlueprintAssignable, Category = "Junjo|Events")
	FOnJunjoStreamError OnStreamError;

	// Terminal: the server ended the stream cleanly (a deploy, a proxy
	// idle timeout). Same resubscribe guidance as OnStreamError. Not
	// fired for Close(), which is silent.
	UPROPERTY(BlueprintAssignable, Category = "Junjo|Events")
	FOnJunjoStreamClosed OnStreamClosed;

	UFUNCTION(BlueprintPure, Category = "Junjo|Events")
	EJunjoStreamState GetState() const;

	// The group this stream was subscribed to; handy when a terminal
	// handler resubscribes.
	UFUNCTION(BlueprintPure, Category = "Junjo|Events")
	FString GetGroupId() const;

	// Ends the stream without firing any delegate. Idempotent, game
	// thread only (like every method here). For an Open stream this
	// calls the native Subscription::close(), which blocks until the
	// stream thread has been joined; the stream notices the stop at
	// its next progress poll, so the wait is bounded and short. For a
	// still-Connecting stream the native handle does not exist yet;
	// the state flips, the subscribe's cancellation token is
	// triggered so a queued or in-flight connect stops early, and the
	// connect continuation discards whatever it produced.
	UFUNCTION(BlueprintCallable, Category = "Junjo|Events")
	void Close();

private:
	friend class UJunjoSubsystem;

	// Called once by the owning subsystem right after construction.
	// Posts the blocking native subscribe to the worker pool and
	// returns immediately; the object is in the Connecting state until
	// the continuation lands back on the game thread. ConnectTimeout,
	// when set, bounds the subscribe's connect phase only (the
	// subsystem passes it as a floor when the configured client
	// timeout is disabled); the established stream is never subject to
	// a timeout.
	void BeginConnect(UJunjoSubsystem* Owner, junjo::Client Client, junjo::Executor& Executor, const FString& InGroupId, std::optional<std::chrono::milliseconds> ConnectTimeout);

	// Game-thread continuations, reached only through the weak-pointer
	// hops posted by BeginConnect's worker task and stream callbacks.
	void FinishConnect(junjo::Subscription Subscription);
	void FinishConnectFailed(const FJunjoError& Error);
	void DeliverEvent(const FJunjoStreamEvent& Event);
	void DeliverStreamError(const FJunjoError& Error);
	void DeliverStreamClosed();

	// Blocking close of the native handle; see the comment in the
	// definition for why this can never self-deadlock.
	void ReleaseSubscription();

	// Drops the owning subsystem's reference on any terminal
	// transition, making the stream collectible once game code lets
	// go of it.
	void Unlink();

	EJunjoStreamState State = EJunjoStreamState::Connecting;
	FString GroupId;
	TWeakObjectPtr<UJunjoSubsystem> OwnerSubsystem;

	// Wired into the native subscribe as its cancellation token.
	// Close() during Connecting cancels it so the blocking connect
	// stops at the transport's next cancellation poll instead of
	// completing a connection nobody wants; a cancelled subscribe
	// fails with Cancelled and the continuation stays silent. Never
	// cancelled after Open (that would end the stream without a
	// callback; Open streams close through the handle instead).
	junjo::CancellationSource ConnectCancelSource;

	// Set while Open; empty in every other state. The subsystem's
	// invariants (terminal transitions release it, Deinitialize closes
	// every live stream) keep this already-empty by the time the
	// UObject is destroyed.
	TOptional<junjo::Subscription> NativeSubscription;

	// The stream thread starts delivering the moment the server
	// accepts, so event hops can land on the game thread before the
	// connect continuation does; they buffer here and flush, in order,
	// right after OnConnected. Terminal hops can outrun the
	// continuation the same way.
	TArray<FJunjoStreamEvent> PendingEvents;
	TOptional<FJunjoError> PendingError;
	bool bPendingClosed = false;
};
