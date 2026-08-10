// Junjo.io SDK for C++
//
// Precondition failure handling shared by the public headers.
//
// The SDK's documented contract is that precondition violations (such
// as calling value() on an error Result) throw std::logic_error. Some
// consumers compile with exception support disabled, and a bare throw
// in a non-template inline function fails to parse there. This helper
// keeps the headers valid in both modes: with exceptions available the
// contract is unchanged; without them a violation terminates via
// std::abort, since a broken precondition cannot be reported and must
// not be silently ignored.
#pragma once

#include <cstdlib>
#include <stdexcept>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define JUNJO_HAS_EXCEPTIONS 1
#else
#define JUNJO_HAS_EXCEPTIONS 0
#endif

namespace junjo::detail {

[[noreturn]] inline void precondition_violation(const char* message) {
#if JUNJO_HAS_EXCEPTIONS
  throw std::logic_error(message);
#else
  (void)message;
  std::abort();
#endif
}

}  // namespace junjo::detail
