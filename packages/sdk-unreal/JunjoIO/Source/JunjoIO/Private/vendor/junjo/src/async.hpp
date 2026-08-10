// Junjo.io SDK for C++
//
// Internal plumbing for the *_async call variants: wraps a
// self-contained callable into a packaged task posted to the caller's
// Executor. The callable owns everything the call needs (a copy of
// the API surface, which shares the request executor; copies of the
// arguments; the token), so the returned future stays valid and
// completes even if the Client and every surface object are destroyed
// first. Not installed.
#pragma once

#include <future>
#include <memory>
#include <type_traits>
#include <utility>

#include "junjo/executor.hpp"

namespace junjo::detail {

// `fn` must be invocable with no arguments and must not throw (SDK
// callables never do: failures travel inside the Result). The
// shared_ptr wrapper exists because std::function requires a copyable
// target and std::packaged_task is move-only.
template <typename Fn>
[[nodiscard]] auto post_task(Executor& executor, Fn fn) -> std::future<std::invoke_result_t<Fn>> {
  using R = std::invoke_result_t<Fn>;
  auto task = std::make_shared<std::packaged_task<R()>>(std::move(fn));
  std::future<R> future = task->get_future();
  executor.post([task] { (*task)(); });
  return future;
}

}  // namespace junjo::detail
