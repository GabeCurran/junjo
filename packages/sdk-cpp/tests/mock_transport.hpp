// Junjo.io SDK for C++: test support.
//
// A scripted Transport: records every request it receives and replays
// queued results in order. Honors the cancellation token the way a
// real transport must (checked once per execute, after the optional
// on_execute hook, so tests can cancel "mid-flight").
#pragma once

#include <deque>
#include <functional>
#include <stdexcept>
#include <utility>
#include <vector>

#include <junjo/cancellation.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/transport.hpp>

namespace junjo::test {

class MockTransport final : public Transport {
 public:
  // Requests seen, in order, with the token each one carried.
  struct Recorded {
    HttpRequest request;
    CancellationToken token;
  };

  // Queues the next scripted outcome (response or error).
  void enqueue(Result<HttpResponse> result) { script_.push_back(std::move(result)); }

  // Convenience: queues a JSON response with the given status/body.
  void enqueue_json(int status, std::string body,
                    std::vector<std::pair<std::string, std::string>> headers = {}) {
    HttpResponse response;
    response.status = status;
    response.headers = std::move(headers);
    response.body = std::move(body);
    enqueue(std::move(response));
  }

  // Invoked at the start of every execute, before the token check;
  // lets a test cancel the source to simulate mid-flight cancellation.
  std::function<void(const HttpRequest&)> on_execute;

  [[nodiscard]] Result<HttpResponse> execute(const HttpRequest& request,
                                             const CancellationToken& token) override {
    recorded_.push_back(Recorded{request, token});
    if (on_execute) on_execute(request);
    if (token.is_cancelled()) {
      return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
    }
    if (script_.empty()) {
      // A test bug, not an SDK failure: fail loudly.
      throw std::logic_error("MockTransport: no scripted response left");
    }
    Result<HttpResponse> next = std::move(script_.front());
    script_.pop_front();
    return next;
  }

  [[nodiscard]] const std::vector<Recorded>& recorded() const noexcept { return recorded_; }
  [[nodiscard]] std::size_t request_count() const noexcept { return recorded_.size(); }
  [[nodiscard]] const HttpRequest& last_request() const {
    if (recorded_.empty()) throw std::logic_error("MockTransport: no requests recorded");
    return recorded_.back().request;
  }

 private:
  std::deque<Result<HttpResponse>> script_;
  std::vector<Recorded> recorded_;
};

}  // namespace junjo::test
