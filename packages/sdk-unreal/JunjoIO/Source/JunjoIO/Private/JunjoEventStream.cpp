// Junjo.io SDK for Unreal Engine
//
// UJunjoEventStream implementation. The rule that makes the whole
// file safe: the native stream thread never touches this UObject.
// Stream callbacks convert their payloads to engine types (pure
// string work) and post game-thread tasks holding a weak pointer;
// every state read and write, every broadcast, and every native
// close() happens on the game thread.

#include "JunjoEventStream.h"

#include <chrono>
#include <optional>
#include <string>
#include <utility>

#include "Async/Async.h"

#include "JunjoConversions.h"
#include "JunjoSubsystem.h"

EJunjoStreamState UJunjoEventStream::GetState() const
{
	return State;
}

FString UJunjoEventStream::GetGroupId() const
{
	return GroupId;
}

void UJunjoEventStream::Close()
{
	if (State == EJunjoStreamState::Closed || State == EJunjoStreamState::Failed)
	{
		return;
	}
	if (State == EJunjoStreamState::Connecting)
	{
		// No native handle exists yet. Cancel the in-flight subscribe
		// (safe from any thread; a queued one fails before sending
		// anything, a blocking one stops at the transport's next
		// cancellation poll) and flip the state; whichever
		// continuation lands stays silent, and FinishConnect closes
		// the fresh subscription if the connect won the race. Silent
		// by contract, like the native close().
		ConnectCancelSource.request_cancellation();
		State = EJunjoStreamState::Closed;
		Unlink();
		return;
	}
	State = EJunjoStreamState::Closed;
	ReleaseSubscription();
	Unlink();
}

void UJunjoEventStream::BeginConnect(UJunjoSubsystem* Owner, junjo::Client Client, junjo::Executor& Executor, const FString& InGroupId, std::optional<std::chrono::milliseconds> ConnectTimeout)
{
	OwnerSubsystem = Owner;
	GroupId = InGroupId;

	// Everything the worker task and the stream callbacks need travels
	// by value; the only path back to this object is the weak pointer,
	// and only after a hop to the game thread.
	TWeakObjectPtr<UJunjoEventStream> WeakThis(this);
	Executor.post([WeakThis, Client = MoveTemp(Client), Group = JunjoConversions::ToUtf8(InGroupId), Token = ConnectCancelSource.token(), ConnectTimeout]() mutable
	{
		junjo::SubscribeOptions Options;
		Options.token = Token;
		if (ConnectTimeout.has_value())
		{
			// The owning subsystem's connect-phase floor for a client
			// whose configured timeout is disabled; a subscription's
			// timeout only ever bounds the connect phase, so the open
			// stream stays unbounded as the contract requires.
			Options.timeout = *ConnectTimeout;
		}

		// These three run on the subscription's dedicated stream
		// thread, one at a time.
		Options.on_event = [WeakThis](const junjo::SseEvent& NativeEvent)
		{
			FJunjoStreamEvent Event;
			Event.EventType = JunjoConversions::ToFString(NativeEvent.event_type);
			Event.EventId = JunjoConversions::ToFString(NativeEvent.event_id);
			Event.PayloadJson = JunjoConversions::ToFString(NativeEvent.payload_json);
			AsyncTask(ENamedThreads::GameThread, [WeakThis, Event = MoveTemp(Event)]()
			{
				if (UJunjoEventStream* Stream = WeakThis.Get())
				{
					Stream->DeliverEvent(Event);
				}
			});
		};
		Options.on_error = [WeakThis](const junjo::Error& NativeError)
		{
			AsyncTask(ENamedThreads::GameThread, [WeakThis, Error = JunjoConversions::Convert(NativeError)]()
			{
				if (UJunjoEventStream* Stream = WeakThis.Get())
				{
					Stream->DeliverStreamError(Error);
				}
			});
		};
		Options.on_close = [WeakThis]()
		{
			AsyncTask(ENamedThreads::GameThread, [WeakThis]()
			{
				if (UJunjoEventStream* Stream = WeakThis.Get())
				{
					Stream->DeliverStreamClosed();
				}
			});
		};

		// Blocks this worker until the server accepts or rejects the
		// connection; the connect phase is bounded by the client's
		// configured request timeout.
		junjo::Result<junjo::Subscription> Subscribed = Client.events().subscribe(Group, std::move(Options));

		if (Subscribed)
		{
			AsyncTask(ENamedThreads::GameThread, [WeakThis, Subscription = MoveTemp(Subscribed).value()]() mutable
			{
				if (UJunjoEventStream* Stream = WeakThis.Get())
				{
					Stream->FinishConnect(MoveTemp(Subscription));
				}
				else
				{
					// The stream object is already gone (teardown
					// unlinked it and GC collected it). This is the
					// game thread, not the stream thread, so the
					// blocking close is legal; the just-opened stream
					// stops at its next progress poll.
					Subscription.close();
				}
			});
		}
		else
		{
			AsyncTask(ENamedThreads::GameThread, [WeakThis, Error = JunjoConversions::Convert(Subscribed.error())]()
			{
				if (UJunjoEventStream* Stream = WeakThis.Get())
				{
					Stream->FinishConnectFailed(Error);
				}
			});
		}
	});
}

void UJunjoEventStream::FinishConnect(junjo::Subscription Subscription)
{
	if (State != EJunjoStreamState::Connecting)
	{
		// Close() ran while the connect was in flight: the caller
		// asked for the stream to end, silently. Discard the fresh
		// subscription; game thread, so blocking close is legal.
		Subscription.close();
		return;
	}

	NativeSubscription.Emplace(MoveTemp(Subscription));
	State = EJunjoStreamState::Open;
	OnConnected.Broadcast();

	// Flush event hops that outran this continuation, re-checking the
	// state every step: an OnConnected or OnEvent handler may Close()
	// mid-flush, and a closed stream must not deliver.
	for (int32 Index = 0; Index < PendingEvents.Num() && State == EJunjoStreamState::Open; ++Index)
	{
		OnEvent.Broadcast(PendingEvents[Index]);
	}
	PendingEvents.Empty();

	// A terminal hop can outrun the continuation too (a stream that
	// dies immediately after accepting); replay it after the events.
	if (State == EJunjoStreamState::Open && PendingError.IsSet())
	{
		const FJunjoError Error = PendingError.GetValue();
		PendingError.Reset();
		DeliverStreamError(Error);
	}
	else if (State == EJunjoStreamState::Open && bPendingClosed)
	{
		DeliverStreamClosed();
	}
}

void UJunjoEventStream::FinishConnectFailed(const FJunjoError& Error)
{
	if (State != EJunjoStreamState::Connecting)
	{
		// Close() beat the rejection; the caller asked for silence.
		return;
	}
	State = EJunjoStreamState::Failed;
	Unlink();
	OnStreamError.Broadcast(Error);
}

void UJunjoEventStream::DeliverEvent(const FJunjoStreamEvent& Event)
{
	switch (State)
	{
	case EJunjoStreamState::Connecting:
		// Outran the connect continuation; FinishConnect flushes.
		PendingEvents.Add(Event);
		break;
	case EJunjoStreamState::Open:
		OnEvent.Broadcast(Event);
		break;
	default:
		// Closed or Failed: a hop posted before Close() landed. The
		// stream is over for game code; drop it.
		break;
	}
}

void UJunjoEventStream::DeliverStreamError(const FJunjoError& Error)
{
	if (State == EJunjoStreamState::Connecting)
	{
		PendingError = Error;
		return;
	}
	if (State != EJunjoStreamState::Open)
	{
		return;
	}
	State = EJunjoStreamState::Failed;
	ReleaseSubscription();
	Unlink();
	OnStreamError.Broadcast(Error);
}

void UJunjoEventStream::DeliverStreamClosed()
{
	if (State == EJunjoStreamState::Connecting)
	{
		bPendingClosed = true;
		return;
	}
	if (State != EJunjoStreamState::Open)
	{
		return;
	}
	State = EJunjoStreamState::Closed;
	ReleaseSubscription();
	Unlink();
	OnStreamClosed.Broadcast();
}

void UJunjoEventStream::ReleaseSubscription()
{
	// Game thread by construction, never the stream thread (all
	// broadcasts are marshaled there first), so this blocking close()
	// can never hit the close-from-a-callback caveat in
	// junjo/events.hpp. On the terminal paths the stream thread has
	// already unwound past its last callback and the join returns
	// almost immediately; for a caller-initiated Close() it returns
	// once the stream observes the stop at its next progress poll.
	if (NativeSubscription.IsSet())
	{
		NativeSubscription->close();
		NativeSubscription.Reset();
	}
}

void UJunjoEventStream::Unlink()
{
	if (UJunjoSubsystem* Owner = OwnerSubsystem.Get())
	{
		Owner->NotifyStreamFinished(this);
	}
}
