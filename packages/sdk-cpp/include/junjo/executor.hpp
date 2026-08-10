// Junjo.io SDK for C++
//
// The execution context for the *_async call variants (see
// junjo/client.hpp). The SDK never spawns hidden threads for async
// work: every async call runs on an Executor the CALLER constructs,
// owns, and outlives-or-drains. That keeps thread count, affinity, and
// shutdown order in the application's hands, where a game server needs
// them.
//
// Two implementations ship: ThreadPoolExecutor (a fixed pool; the
// production choice) and InlineExecutor (runs tasks on the posting
// thread; the deterministic choice for tests).
#pragma once

#include <condition_variable>
#include <cstddef>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>
#include <vector>

#include "junjo/export.hpp"

namespace junjo {

// Runs posted tasks. Implementations decide where and when; the only
// contract is that every posted task eventually runs exactly once.
//
// Task rules:
//   - Tasks must not throw. The SDK's own posted tasks never do (an
//     async call's failure travels inside its Result); a user task
//     that throws has no one to catch it and the implementation may
//     terminate.
//   - post() must be safe to call from any thread, including from
//     inside a running task.
class JUNJO_API Executor {
 public:
  Executor() = default;
  Executor(const Executor&) = delete;
  Executor& operator=(const Executor&) = delete;
  virtual ~Executor();

  virtual void post(std::function<void()> task) = 0;
};

// Runs each task immediately on the thread that posted it, before
// post() returns. No concurrency, fully deterministic: an async call
// through an InlineExecutor has completed (future ready) by the time
// the *_async method returns. Made for tests and for callers that want
// the async signatures without the threads.
class JUNJO_API InlineExecutor final : public Executor {
 public:
  void post(std::function<void()> task) override;
};

// A fixed pool of worker threads draining one FIFO queue.
//
// Thread guarantees:
//   - post() is safe from any thread, including from a running task
//     (tasks may fan out).
//   - Tasks run on pool threads, never on the posting thread.
//   - Destruction DRAINS: the destructor runs every task already
//     queued (including tasks those tasks post during the drain),
//     then joins its threads. No posted task is dropped, so a future
//     obtained from an async call posted here always becomes ready,
//     even when the pool is destroyed while the call is in flight.
//   - Do not call post() concurrently WITH the destructor from another
//     thread (that is a use-after-free race on the pool object itself,
//     same as any other C++ object); posting from inside a task during
//     the drain is fine.
//   - Destroying the pool from inside one of its own tasks deadlocks
//     (the destructor would join the thread it runs on); do not.
class JUNJO_API ThreadPoolExecutor final : public Executor {
 public:
  // `thread_count` == 0 is clamped to 1.
  explicit ThreadPoolExecutor(std::size_t thread_count);
  ~ThreadPoolExecutor() override;

  void post(std::function<void()> task) override;

 private:
  void worker();

  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<std::function<void()>> queue_;
  bool stopping_ = false;
  std::vector<std::thread> threads_;
};

}  // namespace junjo
