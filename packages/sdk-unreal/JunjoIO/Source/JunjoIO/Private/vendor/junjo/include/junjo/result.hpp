// Junjo.io SDK for C++
//
// junjo::Result<T>: the return type of every fallible SDK operation.
//
// Why not std::expected: the SDK targets C++20 and std::expected is
// C++23. Rather than take a dependency on a polyfill (tl::expected) in
// public headers, we ship this deliberately small tagged union with the
// subset of the expected API the SDK actually needs. If the project
// ever moves to C++23 the migration is mechanical.
//
// Exception policy: the SDK NEVER throws for API errors, transport
// failures, or invalid wire data; those are all reported as Error
// values. Exceptions are reserved for programmer errors (precondition
// violations such as calling value() on an error Result), which throw
// std::logic_error, and for allocation failure (std::bad_alloc), which
// is not the SDK's to swallow. In translation units compiled without
// exception support, a precondition violation terminates via
// std::abort instead (see junjo/preconditions.hpp).
#pragma once

#include <optional>
#include <type_traits>
#include <utility>
#include <variant>

#include "junjo/error.hpp"
#include "junjo/preconditions.hpp"

namespace junjo {

// Result of a fallible operation: exactly one of a T value or an Error.
// T must be an object type distinct from junjo::Error.
template <typename T>
class Result {
  static_assert(!std::is_same_v<std::remove_cv_t<T>, Error>,
                "Result<Error> is ambiguous; use Result<void> or a distinct value type");
  static_assert(!std::is_reference_v<T>, "Result<T&> is not supported");

 public:
  // Implicit on purpose: `return some_value;` and `return some_error;`
  // both read naturally at call sites.
  Result(T value) : state_(std::in_place_index<0>, std::move(value)) {}
  Result(Error error) : state_(std::in_place_index<1>, std::move(error)) {}

  [[nodiscard]] bool has_value() const noexcept { return state_.index() == 0; }
  [[nodiscard]] explicit operator bool() const noexcept { return has_value(); }

  // Precondition: has_value(). Violation throws std::logic_error
  // (programmer error, not an API failure).
  [[nodiscard]] T& value() & {
    require_value();
    return *std::get_if<0>(&state_);
  }
  [[nodiscard]] const T& value() const& {
    require_value();
    return *std::get_if<0>(&state_);
  }
  [[nodiscard]] T&& value() && {
    require_value();
    return std::move(*std::get_if<0>(&state_));
  }

  // Precondition: !has_value(). Violation throws std::logic_error.
  [[nodiscard]] const Error& error() const& {
    require_error();
    return *std::get_if<1>(&state_);
  }
  [[nodiscard]] Error&& error() && {
    require_error();
    return std::move(*std::get_if<1>(&state_));
  }

  template <typename U>
  [[nodiscard]] T value_or(U&& fallback) const& {
    return has_value() ? *std::get_if<0>(&state_) : static_cast<T>(std::forward<U>(fallback));
  }
  template <typename U>
  [[nodiscard]] T value_or(U&& fallback) && {
    return has_value() ? std::move(*std::get_if<0>(&state_))
                       : static_cast<T>(std::forward<U>(fallback));
  }

  // Applies `f` to the value; propagates the error unchanged.
  // f: T -> U, giving Result<U>.
  template <typename F>
  [[nodiscard]] auto map(F&& f) const& -> Result<std::invoke_result_t<F, const T&>> {
    if (has_value()) return std::forward<F>(f)(*std::get_if<0>(&state_));
    return *std::get_if<1>(&state_);
  }
  template <typename F>
  [[nodiscard]] auto map(F&& f) && -> Result<std::invoke_result_t<F, T&&>> {
    if (has_value()) return std::forward<F>(f)(std::move(*std::get_if<0>(&state_)));
    return std::move(*std::get_if<1>(&state_));
  }

  // Chains a fallible continuation; propagates the error unchanged.
  // f: T -> Result<U>, giving Result<U>.
  template <typename F>
  [[nodiscard]] auto and_then(F&& f) const& -> std::invoke_result_t<F, const T&> {
    if (has_value()) return std::forward<F>(f)(*std::get_if<0>(&state_));
    return *std::get_if<1>(&state_);
  }
  template <typename F>
  [[nodiscard]] auto and_then(F&& f) && -> std::invoke_result_t<F, T&&> {
    if (has_value()) return std::forward<F>(f)(std::move(*std::get_if<0>(&state_)));
    return std::move(*std::get_if<1>(&state_));
  }

 private:
  void require_value() const {
    if (!has_value()) {
      detail::precondition_violation("junjo::Result::value() called on an error Result");
    }
  }
  void require_error() const {
    if (has_value()) {
      detail::precondition_violation("junjo::Result::error() called on a success Result");
    }
  }

  std::variant<T, Error> state_;
};

// Result of a fallible operation with no value payload (e.g. an HTTP
// 204 response). Default construction is success.
template <>
class Result<void> {
 public:
  Result() noexcept = default;
  Result(Error error) : error_(std::move(error)) {}

  [[nodiscard]] static Result ok() noexcept { return Result(); }

  [[nodiscard]] bool has_value() const noexcept { return !error_.has_value(); }
  [[nodiscard]] explicit operator bool() const noexcept { return has_value(); }

  // Precondition: !has_value(). Violation throws std::logic_error.
  [[nodiscard]] const Error& error() const& {
    require_error();
    return *error_;
  }
  [[nodiscard]] Error&& error() && {
    require_error();
    return std::move(*error_);
  }

 private:
  void require_error() const {
    if (has_value()) {
      detail::precondition_violation("junjo::Result::error() called on a success Result");
    }
  }

  std::optional<Error> error_;
};

}  // namespace junjo
