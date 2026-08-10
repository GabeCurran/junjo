# Junjo.io SDK for C++

C++20 client library for the [Junjo.io](https://junjo.io) API. Every
fallible operation returns a typed `junjo::Result<T>`; the SDK never
throws for API or transport failures. Full documentation lives on the
docs site (the C++ page), including quick start, error handling, async,
SSE, cancellation, and transport replacement.

This is a server-side SDK. The per-game API key (`jk_<prefix>.<secret>`)
is a full-control credential; keep it inside your game server or
backend, never in a client binary players can read.

## Surface

| Surface | Entry point |
| --- | --- |
| Groups, membership, per-group bans, invitations (including invite links and bulk CSV invite), relationships, sub-groups | `client.groups()` |
| Members, notes, metadata, roles on members, permission overrides | `client.members()` |
| Roles | `client.roles()` |
| Invitation listing / lookup / revoke | `client.invitations()` |
| Permission checks | `client.check(...)` / `client.can(...)` |
| Game-wide bans + ban history | `client.bans()` |
| Friends, requests, blocks, tags, visibility, suggestions | `client.friends()` |
| Group audit log | `client.audit()` |
| Webhook endpoints | `client.webhooks().endpoints()` |
| Webhook delivery verification (no client needed) | `junjo::verify_webhook` in `junjo/webhooks.hpp` |
| Live event subscriptions (SSE) | `client.events().subscribe(...)` |
| Async variants over your executor | `*_async` methods + `junjo/executor.hpp` |
| Cursor-pagination helper | `junjo::paginate` in `junjo/pagination.hpp` |
| Tri-state PATCH fields (omit / clear / set) | `junjo::Patch<T>` in `junjo/types.hpp` |

## Requirements

CMake 3.24+ and a C++20 compiler (MSVC 2022, Clang 15+, GCC 12+ are the
expected floor). The default HTTP transport uses libcurl: a system curl
found via `find_package(CURL)` is preferred, and without one a pinned
curl 8.9.1 is fetched and built HTTP-only with OS-native TLS (Schannel
on Windows, Secure Transport on macOS), so there is no CA bundle to
ship.

`find_package(CURL)` takes whatever libcurl is first on the search
path, and on machines with unrelated toolchains installed (Strawberry
Perl on Windows is the common case) that can be a curl built by a
different compiler, which surfaces as confusing link errors. Configure
with `-DCMAKE_DISABLE_FIND_PACKAGE_CURL=ON` to skip discovery and force
the pinned FetchContent build; CI uses exactly this on Windows.

## Integrating

Two supported modes.

Vendored, as part of your build:

```cmake
add_subdirectory(third_party/junjo/packages/sdk-cpp)
target_link_libraries(your_game PRIVATE JunjoIO::SDK)
```

Installed, as a CMake package:

```sh
cmake -S packages/sdk-cpp -B build-sdk -DCMAKE_BUILD_TYPE=Release
cmake --build build-sdk
cmake --install build-sdk --prefix /opt/junjo
```

```cmake
find_package(JunjoIO 0.1 REQUIRED)
target_link_libraries(your_game PRIVATE JunjoIO::SDK)
```

Configure the consuming project with `-DCMAKE_PREFIX_PATH=/opt/junjo`.
The installed package re-attaches curl to match how the SDK was built:
a system-curl build re-resolves it via `find_dependency(CURL)`, a
vendored-curl static build installs the vendored archive into the
prefix and imports it, and a shared build needs nothing (curl was
resolved at the library's own link step). A complete external consumer
(standalone project, `find_package`, build walkthrough for PowerShell
and POSIX) lives at `examples/cpp-consumer`.

## Quick taste

```cpp
#include <junjo/client.hpp>

auto created = junjo::Client::create({.api_key = "jk_..."});
if (!created) { /* created.error().message */ }
auto client = std::move(created).value();

auto group = client.groups().get("grp_123");
if (group && group.value().has_value()) {
  // group.value()->name
}
```

Exceptions are reserved for programmer errors (documented
preconditions) only; API and transport failures are `junjo::Error`
values carried in the `Result`, with distinct codes for server
rejections versus requests that never got there (`NetworkError`,
`Timeout`, `Cancelled`). The public headers also compile under
exceptions-disabled builds, where a precondition violation terminates
via `std::abort` instead of throwing.

## Building and testing

```sh
cmake -S . -B build -DJUNJO_DEV=ON
cmake --build build --config Release
ctest --test-dir build -C Release
```

The suite (262 doctest cases, registered with CTest as 263 tests) runs
against mock transports; no server or network is required. Options:

- `JUNJO_BUILD_CURL_TRANSPORT` (default `ON`): build the bundled
  libcurl transport. With it `OFF`, you must supply your own
  `junjo::Transport` implementation via `ClientConfig::transport`.
- `JUNJO_BUILD_TESTS` (default `ON` when top-level): build the
  `junjo_tests` binary and register it with CTest.
- `JUNJO_DEV` (default `OFF`): warnings as errors; used by CI, never
  imposed on consumers.
- `BUILD_SHARED_LIBS` is respected; the library is static by default.
  There is no ABI stability commitment before 1.0 (shared Windows
  builds export all symbols via `WINDOWS_EXPORT_ALL_SYMBOLS`), so
  rebuild anything linking the SDK whenever you update it.

CI (`.github/workflows/cpp.yml`) builds and tests Debug and Release on
MSVC, GCC, and Clang, and proves the install + `find_package` +
consumer-run chain on every OS in the matrix: Linux against a system
libcurl, Windows against the FetchContent curl, covering both
dependency modes.

## Dependency rationale

- **nlohmann/json v3.11.3** (FetchContent, pinned by content hash):
  wire (de)serialization. Strictly a PRIVATE dependency: it is compiled
  into the library and never appears in a public header, so your
  project can use any JSON library, or a different nlohmann version,
  without ODR or ABI conflicts.
- **libcurl 8.9.1** (system `find_package(CURL)` preferred; pinned
  FetchContent fallback, HTTP(S)-only, no exotic protocols): the
  default HTTP transport. See "Integrating" for how each build mode
  reaches consumers of the installed package.
- **HMAC-SHA256** for webhook verification is a small clean-room
  implementation bundled in the library (validated against the FIPS
  180-4 and RFC 4231 test vectors in the suite), so verification pulls
  in no crypto dependency.
- **doctest 2.4.11** (FetchContent, tests only): chosen for compile
  speed.

Licenses: the SDK itself is MIT (see LICENSE). nlohmann/json is MIT,
curl uses the curl license, doctest is MIT and never reaches shipped
binaries. THIRD_PARTY_NOTICES.md reproduces the notices you must carry
when distributing binaries built against the SDK.
