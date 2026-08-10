// Junjo.io SDK for C++
//
// Linkage annotation for the symbols whose definitions live in the
// library's translation units. Header-only entities (templates and
// inline definitions) are instantiated in every consumer and never
// carry it.
//
// JUNJO_API expands to nothing by default. The SDK's own build
// systems produce either a static library or a shared library with
// every symbol exported (WINDOWS_EXPORT_ALL_SYMBOLS), and neither
// needs per-symbol annotations.
//
// A consuming build system that compiles these sources into a shared
// library with per-module symbol visibility (Windows DLL linkage, or
// ELF/Mach-O hidden-by-default visibility) defines JUNJO_API before
// these headers are included: to the platform's export attribute
// while compiling the library's own translation units, and to the
// matching import attribute (or the same visibility attribute, on
// platforms that do not distinguish) while compiling code that links
// against them. The definition must be identical across every
// translation unit of a given module or the ODR is violated, which
// is why it belongs in the build system rather than in code.
#pragma once

#if !defined(JUNJO_API)
#define JUNJO_API
#endif
