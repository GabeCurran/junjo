// Junjo.io SDK for C++
//
// Cooperative cancellation. A CancellationSource owns the "please stop"
// flag; the CancellationToken it hands out is a cheap, copyable view of
// that flag which SDK calls accept and transports poll.
//
// Guarantees:
//   - Thread safety: request_cancellation() may be called from any
//     thread, concurrently with is_cancelled() polls on other threads.
//     A cancellation requested before a poll happens-before that poll
//     observing it (acquire/release ordering on the shared flag).
//   - Stickiness: once requested, cancellation never resets. Create a
//     new CancellationSource per logical operation instead of reusing.
//   - Lifetime: tokens share ownership of the flag, so a token remains
//     valid (and permanently reports its last observed state semantics)
//     after the source is destroyed; destroying the source does NOT
//     cancel outstanding work.
//   - Delivery model: polling only. Transports are expected to check
//     the token at natural progress points (the bundled curl transport
//     polls from libcurl's progress callback, roughly once per second
//     during stalls and far more often during active transfer).
//     Callback registration is deliberately out of scope for this
//     slice; polling keeps the type trivially thread-safe.
//   - Cancellation is best-effort and cooperative: after
//     request_cancellation() returns, an in-flight request finishes
//     with ErrorCode::Cancelled as soon as the transport next observes
//     the token, not instantaneously.
#pragma once

#include <atomic>
#include <memory>

namespace junjo {

class CancellationSource;

// A read-only view of a cancellation flag. Default-constructed tokens
// are never cancelled ("no cancellation requested" is the natural
// default for SDK call sites). Copying is cheap (two shared_ptrs).
class CancellationToken {
 public:
  // A token that can never be cancelled.
  CancellationToken() noexcept = default;

  // Equivalent to CancellationToken(); reads better at call sites that
  // want to be explicit about "no cancellation".
  [[nodiscard]] static CancellationToken none() noexcept { return CancellationToken(); }

  // A token cancelled as soon as EITHER input is. The result shares
  // both flags (no thread, no allocation beyond the link nodes), so it
  // stays valid however long either source lives. Combining already
  // combined tokens works; each layer adds one flag to the poll. The
  // SDK uses this to merge a caller's token with an internal stop
  // signal (see junjo/events.hpp); it is public because embedders end
  // up needing the same merge.
  [[nodiscard]] static CancellationToken any_of(const CancellationToken& a,
                                                const CancellationToken& b);

  [[nodiscard]] bool is_cancelled() const noexcept {
    if (state_ != nullptr && state_->load(std::memory_order_acquire)) return true;
    for (const Link* link = links_.get(); link != nullptr; link = link->next.get()) {
      if (link->flag->load(std::memory_order_acquire)) return true;
    }
    return false;
  }

 private:
  friend class CancellationSource;

  // Extra flags beyond `state_`, present only on combined tokens. The
  // chain is immutable once built, so copies share it safely.
  struct Link {
    std::shared_ptr<const std::atomic<bool>> flag;
    std::shared_ptr<const Link> next;
  };

  explicit CancellationToken(std::shared_ptr<const std::atomic<bool>> state) noexcept
      : state_(std::move(state)) {}

  std::shared_ptr<const std::atomic<bool>> state_;
  std::shared_ptr<const Link> links_;
};

inline CancellationToken CancellationToken::any_of(const CancellationToken& a,
                                                   const CancellationToken& b) {
  CancellationToken result;
  result.state_ = a.state_;
  result.links_ = a.links_;
  const auto add_flag = [&result](const std::shared_ptr<const std::atomic<bool>>& flag) {
    if (flag == nullptr) return;
    if (result.state_ == nullptr) {
      result.state_ = flag;
      return;
    }
    auto link = std::make_shared<Link>();
    link->flag = flag;
    link->next = result.links_;
    result.links_ = std::move(link);
  };
  add_flag(b.state_);
  for (const Link* link = b.links_.get(); link != nullptr; link = link->next.get()) {
    add_flag(link->flag);
  }
  return result;
}

// Owns a cancellation flag and mints tokens observing it. Copyable;
// copies share the same flag.
class CancellationSource {
 public:
  CancellationSource() : state_(std::make_shared<std::atomic<bool>>(false)) {}

  [[nodiscard]] CancellationToken token() const noexcept { return CancellationToken(state_); }

  // Sticky; idempotent; safe from any thread.
  void request_cancellation() noexcept { state_->store(true, std::memory_order_release); }

  [[nodiscard]] bool cancellation_requested() const noexcept {
    return state_->load(std::memory_order_acquire);
  }

 private:
  std::shared_ptr<std::atomic<bool>> state_;
};

}  // namespace junjo
