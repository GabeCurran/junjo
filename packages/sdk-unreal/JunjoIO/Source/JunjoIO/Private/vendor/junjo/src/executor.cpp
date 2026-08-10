// Junjo.io SDK for C++

#include "junjo/executor.hpp"

#include <cstddef>
#include <utility>

namespace junjo {

// Out-of-line so the vtable and key function live in exactly one
// translation unit.
Executor::~Executor() = default;

void InlineExecutor::post(std::function<void()> task) {
  if (task) task();
}

ThreadPoolExecutor::ThreadPoolExecutor(std::size_t thread_count) {
  const std::size_t count = thread_count == 0 ? 1 : thread_count;
  threads_.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    threads_.emplace_back([this] { worker(); });
  }
}

ThreadPoolExecutor::~ThreadPoolExecutor() {
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    stopping_ = true;
  }
  wake_.notify_all();
  for (std::thread& thread : threads_) {
    thread.join();
  }
}

void ThreadPoolExecutor::post(std::function<void()> task) {
  if (!task) return;
  {
    const std::lock_guard<std::mutex> lock(mutex_);
    queue_.push_back(std::move(task));
  }
  wake_.notify_one();
}

void ThreadPoolExecutor::worker() {
  for (;;) {
    std::function<void()> task;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      wake_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (queue_.empty()) {
        // stopping_ with an empty queue: the drain is complete. A task
        // posted DURING the drain lands in the queue before its poster
        // returns, and the posting worker (still inside this loop)
        // observes it, so nothing is dropped.
        return;
      }
      task = std::move(queue_.front());
      queue_.pop_front();
    }
    task();
  }
}

}  // namespace junjo
