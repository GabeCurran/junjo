// Junjo.io SDK for Unreal Engine
//
// FHttpModule-backed transport implementation. One engine request per
// call and no shared mutable state on the transport itself, so
// concurrent calls from multiple SDK worker threads are safe. See
// JunjoUnrealTransport.h for the threading contract and failure
// classification.

#include "JunjoUnrealTransport.h"

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "HAL/CriticalSection.h"
#include "HAL/Event.h"
#include "HAL/PlatformTime.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/ScopeLock.h"
#include "Serialization/Archive.h"

#include "junjo/error.hpp"

namespace
{

// Cancellation poll granularity for the blocked caller. The token is
// checked between event waits, so cancellation latency is bounded by
// one slice.
constexpr uint32 GPollSliceMs = 50;

// Bounded grace between the streaming path's status arrival and
// on_open delivery when neither a body chunk nor completion has
// arrived to prove the header block complete; see the connect phase in
// execute_stream.
constexpr double GOpenGraceSeconds = 0.25;

FString ToFString(const std::string& Utf8)
{
	return FString(UTF8_TO_TCHAR(Utf8.c_str()));
}

std::string ToUtf8(const FString& Value)
{
	return std::string(TCHAR_TO_UTF8(*Value));
}

junjo::Error MakeError(junjo::ErrorCode Code, const char* Message)
{
	junjo::Error Err;
	Err.code = Code;
	Err.message = Message;
	return Err;
}

// Maps a failed completion to the Transport contract. Cancelled is
// reported ONLY when this call's token fired. An engine-initiated
// EHttpFailureReason::Cancelled with the token unfired (e.g.
// FHttpManager shutdown yanking the request) classifies as
// NetworkError instead: the vendored core treats a post-open Cancelled
// stream result as a user stop and ends silently, so an engine cancel
// must surface through on_error so UJunjoEventStream fires
// OnStreamError instead of sitting Open forever on a dead stream.
junjo::Error ClassifyFailure(EHttpFailureReason Reason, bool bTokenCancelled,
	const char* TimeoutMessage, const char* NetworkMessage)
{
	if (bTokenCancelled)
	{
		return MakeError(junjo::ErrorCode::Cancelled, "request cancelled");
	}
	if (Reason == EHttpFailureReason::Cancelled)
	{
		return MakeError(junjo::ErrorCode::NetworkError,
			"network error: request cancelled by the engine HTTP manager");
	}
	if (Reason == EHttpFailureReason::TimedOut)
	{
		return MakeError(junjo::ErrorCode::Timeout, TimeoutMessage);
	}
	return MakeError(junjo::ErrorCode::NetworkError, NetworkMessage);
}

// Applies the parts of a junjo::HttpRequest shared by both paths and
// pins the delegate thread policy.
void ConfigureRequest(const TSharedRef<IHttpRequest, ESPMode::ThreadSafe>& HttpRequest,
	const junjo::HttpRequest& Request)
{
	HttpRequest->SetVerb(ToFString(Request.method));
	HttpRequest->SetURL(ToFString(Request.url));
	// Headers pass through verbatim; the SDK builds lowercase names
	// (header names are case-insensitive on the wire).
	for (const std::pair<std::string, std::string>& Header : Request.headers)
	{
		HttpRequest->SetHeader(ToFString(Header.first), ToFString(Header.second));
	}
	if (Request.body.has_value())
	{
		TArray<uint8> Payload(reinterpret_cast<const uint8*>(Request.body->data()),
			static_cast<int32>(Request.body->size()));
		HttpRequest->SetContent(MoveTemp(Payload));
	}
	// execute() and execute_stream() are called from SDK worker threads
	// and block until the request finishes. Under the default
	// CompleteOnGameThread policy a caller that happened to block on the
	// game thread would deadlock, waiting for a completion that needs
	// the game thread to tick; CompleteOnHttpThread fires every delegate
	// on the HTTP thread instead.
	HttpRequest->SetDelegateThreadPolicy(EHttpRequestDelegateThreadPolicy::CompleteOnHttpThread);
}

// Converts an engine response to the transport's response type. The
// body is copied as raw wire bytes (GetContentAsString would transcode;
// the SDK parses the bytes itself).
junjo::HttpResponse ConvertResponse(const FHttpResponsePtr& Response)
{
	junjo::HttpResponse Converted;
	Converted.status = Response->GetResponseCode();
	for (const FString& Line : Response->GetAllHeaders())
	{
		// GetAllHeaders returns "Name: Value" lines with wire casing.
		FString Name;
		FString Value;
		if (Line.Split(TEXT(":"), &Name, &Value))
		{
			Value.TrimStartAndEndInline();
			Converted.headers.emplace_back(ToUtf8(Name), ToUtf8(Value));
		}
	}
	const TArray<uint8>& Content = Response->GetContent();
	Converted.body.assign(reinterpret_cast<const char*>(Content.GetData()),
		static_cast<size_t>(Content.Num()));
	return Converted;
}

// Completion state for the buffered path, shared between the blocked
// caller and the completion delegate (which runs on the HTTP thread).
// Delegate-owned, so it outlives execute() even when the caller returns
// early on cancellation or timeout.
struct FBufferedRequestState
{
	FEventRef DoneEvent;
	FCriticalSection Lock;
	bool bDone = false;
	bool bConnectedSuccessfully = false;
	FHttpResponsePtr Response;
	EHttpFailureReason FailureReason = EHttpFailureReason::None;
};

// Shared state for the streaming path: filled by the HTTP thread
// (status and header delegates, the body archive, completion), drained
// by the blocked execute_stream caller. Owned jointly by the delegates,
// the archive, and the caller, so it outlives the engine request
// however execute_stream returns.
struct FStreamRequestState
{
	FEventRef WakeEvent;
	FCriticalSection Lock;
	TArray<TArray<uint8>> Chunks;
	std::vector<std::pair<std::string, std::string>> Headers;
	int32 StatusCode = 0;
	bool bStatusReceived = false;
	bool bDone = false;
	bool bConnectedSuccessfully = false;
	FHttpResponsePtr Response;
	EHttpFailureReason FailureReason = EHttpFailureReason::None;
};

// Receives streamed body bytes. The engine calls Serialize on the HTTP
// thread; it only queues and signals, and the blocked caller invokes
// StreamHandler::on_data on itself, preserving the
// callbacks-on-calling-thread contract. Shares ownership of the state,
// and the engine may keep this archive alive briefly after
// execute_stream has returned (post-cancellation teardown), which is
// safe for the same reason.
class FJunjoSseBodyArchive final : public FArchive
{
public:
	explicit FJunjoSseBodyArchive(const TSharedRef<FStreamRequestState, ESPMode::ThreadSafe>& InState)
		: State(InState)
	{
		// The engine writes received bytes INTO the archive.
		this->SetIsSaving(true);
	}

	virtual void Serialize(void* Data, int64 Length) override
	{
		if (Data == nullptr || Length <= 0)
		{
			return;
		}
		TArray<uint8> Chunk(static_cast<const uint8*>(Data), static_cast<int32>(Length));
		{
			FScopeLock Guard(&State->Lock);
			State->Chunks.Add(MoveTemp(Chunk));
		}
		State->WakeEvent->Trigger();
	}

	virtual FString GetArchiveName() const override
	{
		return TEXT("FJunjoSseBodyArchive");
	}

private:
	TSharedRef<FStreamRequestState, ESPMode::ThreadSafe> State;
};

}  // namespace

junjo::Result<junjo::HttpResponse> FJunjoUnrealTransport::execute(
	const junjo::HttpRequest& Request, const junjo::CancellationToken& Token)
{
	// Fast path: no point standing up a request for a dead call.
	if (Token.is_cancelled())
	{
		return MakeError(junjo::ErrorCode::Cancelled, "request cancelled");
	}

	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> HttpRequest =
		FHttpModule::Get().CreateRequest();
	ConfigureRequest(HttpRequest, Request);

	const bool bHasTimeout = Request.timeout.has_value() && Request.timeout->count() > 0;
	if (bHasTimeout)
	{
		// Engine-enforced whole-request timeout; expiry completes the
		// request with EHttpFailureReason::TimedOut.
		HttpRequest->SetTimeout(static_cast<float>(Request.timeout->count()) / 1000.0f);
	}

	const TSharedRef<FBufferedRequestState, ESPMode::ThreadSafe> State =
		MakeShared<FBufferedRequestState, ESPMode::ThreadSafe>();
	HttpRequest->OnProcessRequestComplete().BindLambda(
		[State](FHttpRequestPtr CompletedRequest, FHttpResponsePtr Response,
			bool bConnectedSuccessfully)
		{
			{
				FScopeLock Guard(&State->Lock);
				State->bDone = true;
				State->bConnectedSuccessfully = bConnectedSuccessfully;
				State->Response = Response;
				State->FailureReason = CompletedRequest.IsValid()
					? CompletedRequest->GetFailureReason()
					: EHttpFailureReason::None;
			}
			State->DoneEvent->Trigger();
		});

	if (!HttpRequest->ProcessRequest())
	{
		return MakeError(junjo::ErrorCode::NetworkError,
			"network error: failed to start request");
	}

	// Block in short slices so the token is observed within one slice.
	// The deadline check is a backstop behind SetTimeout: classifying
	// expiry locally keeps a slow engine-side teardown from blurring
	// Timeout into anything else.
	const double DeadlineSeconds = bHasTimeout
		? FPlatformTime::Seconds() + static_cast<double>(Request.timeout->count()) / 1000.0
		: 0.0;
	for (;;)
	{
		{
			FScopeLock Guard(&State->Lock);
			if (State->bDone)
			{
				break;
			}
		}
		if (Token.is_cancelled())
		{
			HttpRequest->CancelRequest();
			return MakeError(junjo::ErrorCode::Cancelled, "request cancelled");
		}
		if (bHasTimeout && FPlatformTime::Seconds() >= DeadlineSeconds)
		{
			HttpRequest->CancelRequest();
			return MakeError(junjo::ErrorCode::Timeout, "request timed out");
		}
		State->DoneEvent->Wait(GPollSliceMs);
	}

	FScopeLock Guard(&State->Lock);
	if (State->bConnectedSuccessfully && State->Response.IsValid())
	{
		// Any received response, whatever the status code, is a
		// transport success; HTTP-level errors are the Client's job.
		return ConvertResponse(State->Response);
	}
	return ClassifyFailure(State->FailureReason, Token.is_cancelled(),
		"request timed out", "network error: request failed");
}

junjo::Result<void> FJunjoUnrealTransport::execute_stream(
	const junjo::HttpRequest& Request, junjo::StreamHandler& Handler,
	const junjo::CancellationToken& Token)
{
	// The single terminal report: on_complete, then the same result
	// back to the caller, on every path out of this function.
	const auto Finish = [&Handler](junjo::Result<void> StreamResult) -> junjo::Result<void>
	{
		Handler.on_complete(StreamResult);
		return StreamResult;
	};

	if (Token.is_cancelled())
	{
		return Finish(MakeError(junjo::ErrorCode::Cancelled, "request cancelled"));
	}

	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> HttpRequest =
		FHttpModule::Get().CreateRequest();
	ConfigureRequest(HttpRequest, Request);

	// The engine's default activity timeout (30 seconds of idle) would
	// kill a quiet event stream between heartbeats; zero disables it.
	// No SetTimeout either: a stream stays open indefinitely by design,
	// and request.timeout bounds the CONNECT phase only, enforced by
	// hand below because the engine has no per-request connect-timeout
	// setter.
	HttpRequest->SetActivityTimeout(0.0f);

	const TSharedRef<FStreamRequestState, ESPMode::ThreadSafe> State =
		MakeShared<FStreamRequestState, ESPMode::ThreadSafe>();

	HttpRequest->OnStatusCodeReceived().BindLambda(
		[State](FHttpRequestPtr, int32 StatusCode)
		{
			{
				FScopeLock Guard(&State->Lock);
				State->StatusCode = StatusCode;
				State->bStatusReceived = true;
			}
			State->WakeEvent->Trigger();
		});
	HttpRequest->OnHeaderReceived().BindLambda(
		[State](FHttpRequestPtr, const FString& HeaderName, const FString& HeaderValue)
		{
			FScopeLock Guard(&State->Lock);
			State->Headers.emplace_back(ToUtf8(HeaderName), ToUtf8(HeaderValue));
		});
	HttpRequest->OnProcessRequestComplete().BindLambda(
		[State](FHttpRequestPtr CompletedRequest, FHttpResponsePtr Response,
			bool bConnectedSuccessfully)
		{
			{
				FScopeLock Guard(&State->Lock);
				State->bDone = true;
				State->bConnectedSuccessfully = bConnectedSuccessfully;
				State->Response = Response;
				State->FailureReason = CompletedRequest.IsValid()
					? CompletedRequest->GetFailureReason()
					: EHttpFailureReason::None;
			}
			State->WakeEvent->Trigger();
		});
	if (!HttpRequest->SetResponseBodyReceiveStream(MakeShared<FJunjoSseBodyArchive>(State)))
	{
		// Mirrors the Transport base-class wording for a backend that
		// cannot stream.
		return Finish(MakeError(junjo::ErrorCode::InvalidConfig, "streaming not supported"));
	}

	if (!HttpRequest->ProcessRequest())
	{
		return Finish(MakeError(junjo::ErrorCode::NetworkError,
			"network error: failed to start request"));
	}

	// Connect phase: wait for the response status (or completion,
	// cancellation, or the connect deadline). The engine broadcasts the
	// status as it parses the header block, but the header lines land
	// in shared state one delegate at a time behind it and the engine
	// has no headers-complete signal, so a caller waking on the status
	// alone could snapshot a partial header map into on_open's head
	// (which the core keeps for envelope-error enrichment on rejected
	// streams). The status is therefore snapshotted the moment it
	// arrives, but on_open delivery waits for the first body chunk or
	// completion, either of which fires on the HTTP thread strictly
	// after the last header delegate and so proves the block complete;
	// a short bounded grace covers an accepted stream that goes idle
	// right after its headers (every enrichment path has a body or a
	// completion and never relies on the grace). The header map is
	// rebuilt freshly from shared state at delivery time.
	const bool bHasConnectDeadline = Request.timeout.has_value() && Request.timeout->count() > 0;
	const double ConnectDeadline = bHasConnectDeadline
		? FPlatformTime::Seconds() + static_cast<double>(Request.timeout->count()) / 1000.0
		: 0.0;
	junjo::HttpResponse Head;
	bool bStatusSeen = false;
	double StatusSeenAt = 0.0;
	for (;;)
	{
		bool bOpenedNow = false;
		bool bDoneNow = false;
		{
			FScopeLock Guard(&State->Lock);
			if (!bStatusSeen && State->bStatusReceived)
			{
				bStatusSeen = true;
				StatusSeenAt = FPlatformTime::Seconds();
				Head.status = State->StatusCode;
			}
			bDoneNow = State->bDone;
			const bool bHaveChunk = State->Chunks.Num() > 0;
			if (bStatusSeen && (bDoneNow || bHaveChunk ||
				FPlatformTime::Seconds() >= StatusSeenAt + GOpenGraceSeconds))
			{
				Head.headers = State->Headers;
				bOpenedNow = true;
			}
		}
		if (bOpenedNow)
		{
			break;
		}
		if (bDoneNow)
		{
			bool bHadResponse = false;
			EHttpFailureReason FailureReason = EHttpFailureReason::None;
			{
				FScopeLock Guard(&State->Lock);
				if (State->bConnectedSuccessfully && State->Response.IsValid())
				{
					// Completed with a valid response but no status
					// delegate ever recorded (a backend that skips the
					// OnStatusCodeReceived broadcast); take the head,
					// headers complete, from the final response.
					const junjo::HttpResponse Full = ConvertResponse(State->Response);
					Head.status = Full.status;
					Head.headers = Full.headers;
					bHadResponse = true;
				}
				FailureReason = State->FailureReason;
			}
			if (bHadResponse)
			{
				break;
			}
			// Connect failed before any response: on_open is never
			// called, on_complete still is. The lock is released first;
			// handler callbacks never run under it.
			return Finish(ClassifyFailure(FailureReason, Token.is_cancelled(),
				"connect timed out", "network error: request failed"));
		}
		if (Token.is_cancelled())
		{
			HttpRequest->CancelRequest();
			return Finish(MakeError(junjo::ErrorCode::Cancelled, "request cancelled"));
		}
		// Once the status has arrived the connection is established and
		// the connect deadline no longer applies; only the open gate's
		// grace (bounded above) remains before on_open.
		if (!bStatusSeen && bHasConnectDeadline && FPlatformTime::Seconds() >= ConnectDeadline)
		{
			HttpRequest->CancelRequest();
			return Finish(MakeError(junjo::ErrorCode::Timeout, "connect timed out"));
		}
		State->WakeEvent->Wait(GPollSliceMs);
	}

	if (!Handler.on_open(Head))
	{
		// Handler-requested stop is a SUCCESS per the StreamHandler
		// contract; no further data callbacks, just on_complete.
		HttpRequest->CancelRequest();
		return Finish(junjo::Result<void>::ok());
	}

	// Data phase: drain queued chunks and invoke on_data on this
	// thread. After connect, only token cancellation and stream end
	// terminate this loop; there is no timeout on an open stream.
	for (;;)
	{
		TArray<TArray<uint8>> Pending;
		bool bDoneNow = false;
		{
			FScopeLock Guard(&State->Lock);
			Pending = MoveTemp(State->Chunks);
			bDoneNow = State->bDone;
		}
		for (const TArray<uint8>& Chunk : Pending)
		{
			const std::string_view View(reinterpret_cast<const char*>(Chunk.GetData()),
				static_cast<size_t>(Chunk.Num()));
			if (!Handler.on_data(View))
			{
				HttpRequest->CancelRequest();
				return Finish(junjo::Result<void>::ok());
			}
		}
		if (bDoneNow)
		{
			// Body bytes and completion both arrive on the HTTP thread
			// in order, so no chunk can be queued after bDone was set:
			// Pending held the full tail and it has been delivered.
			break;
		}
		if (Token.is_cancelled())
		{
			HttpRequest->CancelRequest();
			return Finish(MakeError(junjo::ErrorCode::Cancelled, "request cancelled"));
		}
		State->WakeEvent->Wait(GPollSliceMs);
	}

	bool bStreamSucceeded = false;
	EHttpFailureReason FailureReason = EHttpFailureReason::None;
	{
		FScopeLock Guard(&State->Lock);
		bStreamSucceeded = State->bConnectedSuccessfully;
		FailureReason = State->FailureReason;
	}
	if (bStreamSucceeded)
	{
		// The server ended the stream normally.
		return Finish(junjo::Result<void>::ok());
	}
	return Finish(ClassifyFailure(FailureReason, Token.is_cancelled(),
		"connect timed out", "network error: stream interrupted"));
}
