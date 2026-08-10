// Junjo.io SDK for C++: test support.
//
// A scripted streaming Transport: plays back a configured status,
// header set, and chunk sequence through the StreamHandler contract,
// honoring the cancellation token between chunks and optionally
// holding the stream open (polling the token) after the chunks run
// out, the way a real idle SSE stream would. Configure before the
// first subscribe; the hooks run on the subscription's stream thread.
#pragma once

#include <atomic>
#include <chrono>
#include <cstddef>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <junjo/cancellation.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/transport.hpp>

namespace junjo::test {

class MockStreamTransport final : public Transport {
 public:
  // Response head delivered via on_open.
  int status = 200;
  std::vector<std::pair<std::string, std::string>> response_headers;
  // Body chunks delivered via on_data, in order. Chunk boundaries are
  // exactly as configured (the SDK must not care).
  std::vector<std::string> chunks;
  // Terminal result after the chunks are exhausted (default: clean
  // server-side end).
  Result<void> terminal = Result<void>::ok();
  // When true, after the chunks the stream idles, polling the token
  // until cancelled (terminal becomes Cancelled), like a real stream
  // with no traffic.
  bool hold_open_until_cancelled = false;
  // Invoked on the stream thread before delivering chunk i; may block
  // to stage a race.
  std::function<void(std::size_t)> before_chunk;

  // Streams in flight right now; lets tests wait for the stream
  // thread to finish without joining it themselves.
  [[nodiscard]] int active_streams() const noexcept {
    return active_streams_.load(std::memory_order_acquire);
  }

  [[nodiscard]] const std::vector<HttpRequest>& recorded() {
    const std::lock_guard<std::mutex> lock(mutex_);
    return recorded_;
  }

  [[nodiscard]] Result<HttpResponse> execute(const HttpRequest&,
                                             const CancellationToken&) override {
    return Error{.code = ErrorCode::NetworkError,
                 .message = "MockStreamTransport only implements execute_stream"};
  }

  [[nodiscard]] Result<void> execute_stream(const HttpRequest& request, StreamHandler& handler,
                                            const CancellationToken& token) override {
    {
      const std::lock_guard<std::mutex> lock(mutex_);
      recorded_.push_back(request);
    }
    active_streams_.fetch_add(1, std::memory_order_acq_rel);
    Result<void> result = run(handler, token);
    handler.on_complete(result);
    active_streams_.fetch_sub(1, std::memory_order_acq_rel);
    return result;
  }

 private:
  [[nodiscard]] Result<void> run(StreamHandler& handler, const CancellationToken& token) {
    if (token.is_cancelled()) {
      return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
    }
    HttpResponse head;
    head.status = status;
    head.headers = response_headers;
    if (!handler.on_open(head)) {
      return Result<void>::ok();
    }
    for (std::size_t i = 0; i < chunks.size(); ++i) {
      if (before_chunk) before_chunk(i);
      if (token.is_cancelled()) {
        return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
      }
      if (!handler.on_data(chunks[i])) {
        return Result<void>::ok();
      }
    }
    if (hold_open_until_cancelled) {
      while (!token.is_cancelled()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
      }
      return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
    }
    return terminal;
  }

  std::mutex mutex_;
  std::vector<HttpRequest> recorded_;
  std::atomic<int> active_streams_{0};
};

}  // namespace junjo::test
