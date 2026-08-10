// Junjo.io SDK for Unreal Engine
//
// The one sanctioned way to reach the native junjo:: C++ API from a
// translation unit that also includes engine headers. Game modules
// consuming the native client (UJunjoSubsystem::GetNativeClient) must
// include this header instead of raw junjo headers.
//
// Why it exists: Misc/AssertionMacros.h defines function-like macros
// named check, verify, and ensure, and junjo/client.hpp declares the
// member function junjo::Client::check. In any TU where engine headers
// come first, the check macro rewrites that declaration into garbage
// before the compiler sees it. This header suspends the macros, pulls
// in the junjo public headers, and restores the macros exactly as they
// were, so engine code after this include keeps its assertions.
//
// Survey note: check is the only junjo public-header token that
// actually collides today. verify and ensure are suspended too as
// insurance against future SDK surface; suspending an undefined macro
// is harmless (push_macro and pop_macro round-trip the undefined
// state).
//
// Call sites: the suspension above protects DECLARATIONS. A call
// spelled Client->check(...) in a TU where the engine macro is live is
// still rewritten at the call site, because macro expansion does not
// care what precedes the identifier. Either suspend the macro around
// the call the same way,
//   #pragma push_macro("check")
//   #undef check
//   auto Decision = Client->check(UserId, GroupId, Permission);
//   #pragma pop_macro("check")
// or go through UJunjoSubsystem::CheckPermission, which wraps this for
// you. Every other junjo method name is collision free, including the
// convenience wrapper Client::can.
#pragma once

// The junjo headers carry JUNJO_API annotations, which the module's
// build rules map onto JUNJOIO_API; in modular builds that expands to
// the engine's DLLIMPORT/DLLEXPORT macros from HAL/Platform.h. Include
// it here so this header works even in a translation unit that has not
// pulled in any engine header yet.
#include "HAL/Platform.h"

#pragma push_macro("check")
#pragma push_macro("verify")
#pragma push_macro("ensure")
#undef check
#undef verify
#undef ensure

// client.hpp transitively includes the whole API surface (groups,
// members, roles, invitations, bans, friends, audit, webhooks, events,
// results, transport, types). executor.hpp and pagination.hpp are the
// two opt-in headers it leaves out.
#include "junjo/client.hpp"
#include "junjo/executor.hpp"
#include "junjo/pagination.hpp"

#pragma pop_macro("ensure")
#pragma pop_macro("verify")
#pragma pop_macro("check")
