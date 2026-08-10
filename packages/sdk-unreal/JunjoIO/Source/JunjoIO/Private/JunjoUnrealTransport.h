// Junjo.io SDK for Unreal Engine
//
// FJunjoUnrealTransport: junjo::Transport backed by the engine's HTTP
// module (FHttpModule), so the SDK rides the engine's platform HTTP
// stacks and certificate handling instead of bundling its own. Engine
// facing but UObject free; it can be constructed and destroyed on any
// thread with no garbage collection concerns.
//
// Threading contract, exactly as junjo/transport.hpp specifies it:
//   - execute() and execute_stream() BLOCK the calling thread until the
//     request or stream finishes. The junjo Client calls them from its
//     own worker threads (one dedicated thread per SSE subscription),
//     never from the game thread.
//   - Every engine request is configured with the CompleteOnHttpThread
//     delegate policy. The default CompleteOnGameThread policy would
//     deadlock any caller that happened to block on the game thread
//     waiting for a completion that needs the game thread to tick.
//   - StreamHandler callbacks (on_open, on_data, on_complete) are
//     invoked on the thread that called execute_stream, in the strict
//     order transport.hpp documents. Engine delegates and the response
//     body FArchive run on the HTTP thread and only fill shared state;
//     the blocked caller drains that state and invokes the handler on
//     itself.
//
// Precondition: FHttpModule must have been touched once from the game
// thread (FHttpModule::Get() loads the module) before any transport
// call runs on a worker thread. The future Junjo subsystem does this at
// startup; standalone users of this transport must do the same.
//
// Failure classification, matching the Transport contract:
//   - ErrorCode::Timeout when HttpRequest::timeout elapsed (the whole
//     request for execute(), the connect phase only for
//     execute_stream()),
//   - ErrorCode::Cancelled ONLY when the CancellationToken was
//     observed cancelled,
//   - ErrorCode::NetworkError for everything else that prevented a
//     response, including an engine-initiated cancellation
//     (EHttpFailureReason::Cancelled with the token unfired, e.g.
//     FHttpManager shutdown). The vendored core treats a post-open
//     Cancelled stream result as a user stop and ends silently, so an
//     engine cancel must classify as NetworkError to surface through
//     on_error; UJunjoEventStream then fires OnStreamError instead of
//     staying Open on a stream that is already dead.
// Any received HTTP response, whatever its status code, is a transport
// success; HTTP-level error handling belongs to the Client.
//
// Cancellation is polled: the blocked caller checks the token roughly
// every 50 ms between event waits, calls CancelRequest() when it fires,
// and returns without waiting for the engine to finish tearing the
// request down (shared state owned by the delegates outlives this
// call).
#pragma once

#include "CoreMinimal.h"

#include "junjo/cancellation.hpp"
#include "junjo/result.hpp"
#include "junjo/transport.hpp"

class FJunjoUnrealTransport final : public junjo::Transport
{
public:
	FJunjoUnrealTransport() = default;

	// Buffered request. HttpRequest::timeout, when set, bounds the whole
	// request via the engine's request timeout.
	[[nodiscard]] virtual junjo::Result<junjo::HttpResponse> execute(
		const junjo::HttpRequest& Request, const junjo::CancellationToken& Token) override;

	// Streaming request per the Transport::execute_stream contract.
	// on_open fires before any body data is delivered; its status is
	// snapshotted the moment the engine broadcasts it, and its header
	// map is rebuilt freshly when the first body chunk or the
	// completion proves the header block complete, with a short bounded
	// grace for an accepted stream that goes idle right after its
	// headers (the engine has no headers-complete signal; see the
	// connect phase in the definition). The activity timeout is
	// disabled so an idle event stream stays open, and
	// HttpRequest::timeout bounds the connect phase only, enforced by
	// this transport since the engine has no per-request connect
	// timeout setter.
	[[nodiscard]] virtual junjo::Result<void> execute_stream(
		const junjo::HttpRequest& Request, junjo::StreamHandler& Handler,
		const junjo::CancellationToken& Token) override;
};
