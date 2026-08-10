# cpp-consumer

A standalone CMake project that consumes the installed Junjo.io SDK for
C++ the way an external game backend would: `find_package(JunjoIO)` plus
`target_link_libraries(app PRIVATE JunjoIO::SDK)`. It is deliberately
not part of the monorepo build; it exists to prove the install/export
story end to end.

`main.cpp` constructs a `junjo::Client` against a base URL taken from
`argv[1]` or `JUNJO_BASE_URL` (default `http://127.0.0.1:8787`, the
local dev server), calls `key_info()`, and prints whichever branch of
the `Result` came back:

- With a live server and a real key in `JUNJO_API_KEY`, it prints the
  game id the key resolves to and exits `0`.
- With no server listening, it prints the typed `network_error` and
  exits `2`. That branch is the point: transport failures are values,
  not exceptions, and this is the smallest program that shows it.
- Exit `1` means client construction itself failed (bad config).

## 1. Install the SDK to a prefix

From the repository root. Static library (the default):

PowerShell:

```powershell
cmake -S packages/sdk-cpp -B build-sdk -G "Visual Studio 17 2022"
cmake --build build-sdk --config Release
cmake --install build-sdk --config Release --prefix $env:TEMP\junjo-prefix
```

POSIX:

```sh
cmake -S packages/sdk-cpp -B build-sdk -DCMAKE_BUILD_TYPE=Release
cmake --build build-sdk
cmake --install build-sdk --prefix /tmp/junjo-prefix
```

For a shared library instead, add `-DBUILD_SHARED_LIBS=ON` to the first
command; everything else is identical.

Note on curl: if the SDK build found a system libcurl, the installed
package re-resolves it with `find_package(CURL)` on the consumer side,
so the consumer machine needs that same system curl. If the SDK build
fell back to its pinned FetchContent curl (common on Windows), the
vendored static archive is installed into the prefix alongside the SDK
and the consumer needs nothing extra.

## 2. Build this project against the prefix

PowerShell:

```powershell
cmake -S examples/cpp-consumer -B build-consumer -G "Visual Studio 17 2022" -DCMAKE_PREFIX_PATH=$env:TEMP\junjo-prefix
cmake --build build-consumer --config Release
```

POSIX:

```sh
cmake -S examples/cpp-consumer -B build-consumer -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH=/tmp/junjo-prefix
cmake --build build-consumer
```

Build the consumer in the same configuration you installed (Release
above). On MSVC, mixing a Release SDK with a Debug consumer fails to
link over mismatched runtime libraries, by design.

## 3. Run it

PowerShell:

```powershell
.\build-consumer\Release\junjo-consumer.exe
```

POSIX:

```sh
./build-consumer/junjo-consumer
```

Expected output with no local server running:

```
GET http://127.0.0.1:8787/v1/whoami ...
typed error: network_error: <curl's description of the refusal>
```

To point it somewhere else, pass the base URL as the first argument or
set `JUNJO_BASE_URL`; set `JUNJO_API_KEY` to a real `jk_` key to
exercise the success branch against a live server. If you used a shared
SDK build on Windows, `junjo.dll` (installed into `bin/` under the
prefix) must be on `PATH` or next to the executable at run time.
