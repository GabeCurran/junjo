# Third-party notices

The Junjo.io SDK for Unreal Engine is MIT licensed (see LICENSE). The
Junjo C++ core vendored under `Source/JunjoIO/Private/vendor/junjo/`
is first-party code, mirrored byte-for-byte from the `packages/sdk-cpp`
package of the Junjo monorepo, and is covered by the plugin LICENSE.

The plugin compiles the third-party component below into the JunjoIO
module, and from there into consuming binaries. Its license notice is
reproduced here so shipping a game built against the plugin satisfies
the notice requirement. Reproduce this file (or the individual notice)
wherever your own distribution carries third-party attributions.

## nlohmann/json v3.11.3 (MIT)

Vendored as a single header at
`Source/JunjoIO/Private/vendor/nlohmann/json.hpp` and compiled into
the module in every build. Notice to reproduce:

```text
MIT License

Copyright (c) 2013-2022 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The SHA-256 and HMAC implementation used for webhook verification is
original code in the vendored Junjo core, covered by the plugin LICENSE.
The plugin's HTTP transport is built on Unreal Engine's own HTTP module;
no third-party HTTP library is bundled.
