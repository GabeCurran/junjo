# Junjo.io SDK for Unreal Engine

Unreal Engine plugin for the [Junjo.io](https://junjo.io) API: groups,
ranks, and permissions for games. One Runtime module (`JunjoIO`)
carrying the vendored Junjo C++ SDK core, an HTTP transport built on
the engine's HTTP module, a game instance subsystem with a
delegate-based async surface, Blueprint async nodes, live SSE event
streams, and the full native `junjo::` C++ API for gameplay code that
needs more than the bound surface. Engine support: UE 5.8 is compiled
and verified (Win64 MSVC, Linux cross-clang, and the Linux Server
target in Epic's dev container); 5.4 is the declared floor and has
not yet been compiled. Full documentation lives on the docs site (the
Unreal Engine page).

This is a server-side SDK. The per-game API key (`jk_<prefix>.<secret>`)
is a full-control credential; it belongs on your dedicated game
servers and nowhere else.

## The security model

The subsystem reads the API key from the `JUNJO_API_KEY` environment
variable at startup, and from nowhere else. There is deliberately no
key property in the plugin's project settings, and none may be added:
`Default*.ini` files are packaged into the client pak files that ship
to every player, and pak contents are trivially extractable, so a key
in config would hand a full-control server credential to anyone who
installs the game.

The environment variable exists only on machines you configure, which
means your dedicated game servers. On player clients the variable is
absent, the subsystem stays inactive, every delegate method fails
immediately with an `InvalidConfig` error, and no credential exists in
the build to extract. `IsActive()` tells you which world you are in.

The API endpoint follows the same pattern when needed: the
`JUNJO_BASE_URL` environment variable, when set, overrides the
configured base URL at startup, so one cooked server build can be
pointed at staging, production, or a self-hosted deployment purely
through its environment. An attacker who can set your server's
environment already controls the machine and the key outright, so the
override adds no new exposure; treat server environment configuration
as part of the credential boundary.

## Install

Copy the `JunjoIO` folder into your project's `Plugins` directory (or
add the repo as a submodule and junction/symlink the folder), then
enable it in your `.uproject`:

```json
"Plugins": [
    { "Name": "JunjoIO", "Enabled": true }
]
```

After copying, regenerate project files (right-click the `.uproject`
and choose Generate Visual Studio project files) so the plugin's
module is picked up. The host project must be a C++ project:
Blueprint-only projects cannot compile source plugins, so add at
least one C++ class first if yours has none.

The plugin is source-only (`CanContainContent` false) and builds with
your project; there are no prebuilt binaries to fetch. Configure the
base URL and request timeout under Project Settings > Plugins >
Junjo.io SDK.

## Quick start

From C++, everything hangs off the game instance subsystem:

```cpp
#include "JunjoSubsystem.h"

// In AMyGameMode's declaration. BindDynamic requires the handler to
// be a UFUNCTION(); a plain member function will not bind.
UFUNCTION()
void HandleChecked(bool bSuccess, const FJunjoPermissionCheck& Result, const FJunjoError& Error);

void AMyGameMode::CheckJoinPermission(const FString& GroupId, const FString& UserId)
{
    UJunjoSubsystem* Junjo = GetGameInstance()->GetSubsystem<UJunjoSubsystem>();
    if (!Junjo->IsActive())
    {
        return; // No JUNJO_API_KEY in this environment.
    }

    FOnJunjoPermissionCheck OnChecked;
    OnChecked.BindDynamic(this, &AMyGameMode::HandleChecked);
    Junjo->CheckPermission(GroupId, UserId, TEXT("invite_member"), OnChecked);
}
```

Call the subsystem's methods on the game thread; the blocking SDK call
runs on the subsystem's worker pool and the callback fires exactly
once, on the game thread. In Blueprint, use the Get JunjoSubsystem
node and the delegate methods, or the dedicated async nodes (Check
Permission Async, Get Group Async, Create Group Async, List Groups
Async, Join Group Async) under Junjo > Async, which expose OnSuccess
and OnFailure exec pins (Get Group Async adds OnNotFound: OnSuccess
means found). `SubscribeToGroupEvents` returns a
`UJunjoEventStream` whose delegates deliver live server events on the
game thread.

## Native API access

The delegate and Blueprint surfaces bind the representative gameplay
path. The whole SDK (friends, roles admin, invitations, audit,
webhooks) is available to C++ through the native client:

```cpp
#include "JunjoNativeApi.h"

junjo::Client* Client = Junjo->GetNativeClient();
auto Page = Client->audit().list("grp_123", {});
```

Include `JunjoNativeApi.h`, never raw `junjo/` headers: it suspends
the engine's `check` macro family around the junjo includes (the
native `Client::check` method collides with it) and restores them
afterwards. The header documents the one call-site caveat for calling
`Client->check(...)` directly. Native access works from any module in
your project; the plugin maps the core's linkage annotations onto the
module's import/export macros, so `junjo::` symbols resolve across
DLL boundaries in modular builds.

## Windows toolchain for UE 5.8

Facts you will hit on a stock machine, stated so you do not rediscover
them:

- UE 5.8's UnrealBuildTool refuses MSVC 14.40 through 14.43 outright
  (known compiler issues), which covers the default toolchain of many
  VS 2022 installs.
- UBT states 14.38 as the minimum, but 5.8's own engine headers fail
  to compile under 14.38 (error C7539 in
  `ContainerAllocationPolicies.h`), so the stated minimum does not
  hold for real builds.
- The plugin and engine build cleanly with 14.50+ from the current
  Visual Studio generation (VS 2026 / Build Tools work; UBT enumerates
  Build Tools installs).

If UBT keeps picking a stale toolchain after you install a new one,
delete the host project's `Intermediate` folder; the build makefile
caches the toolchain choice.

## Building for Linux

Cross-compile from Windows with Epic's Linux cross-toolchain v26
(clang 20.1.8, rockylinux8 sysroot). Install it and point
`LINUX_MULTIARCH_ROOT` at it (the installer sets a machine-level
variable; long-lived shells hold stale environments, so inject it into
the build shell explicitly):

```powershell
$env:LINUX_MULTIARCH_ROOT = "C:\UnrealToolchains\v26_clang-20.1.8-rockylinux8\"
& "...\Engine\Build\BatchFiles\Build.bat" MyProject Linux Development -Project="...\MyProject.uproject"
```

Game and Editor targets build against the launcher-installed engine.
Dedicated Server targets require a source-built engine (or Epic's dev
containers); see the docs site for the dedicated-server story.

## Not bound to Blueprint yet

Friends, audit logs, webhook endpoint management, invitations, and
roles administration have no delegate or Blueprint surface in this
version. All of them are reachable today through `GetNativeClient()`
and the `junjo::` API; later versions bind more of the surface.

## Limitations

Stated honestly:

- The plugin has no automated test suite. It is verified by compilation
  on Win64 and Linux, code review, and a manual containerized runtime
  smoke; its logic-heavy parts (the SSE state machine, the
  thread-marshaling transport, the USTRUCT conversions) are not covered
  by executable tests. The vendored core is byte-identical to the tested
  `packages/sdk-cpp`, so the core's own tests cover the client below the
  Unreal layer, but nothing exercises the Unreal-specific wrapper
  automatically.
- The delegate and Blueprint surfaces bind a representative subset of
  the API. Friends, audit, webhook endpoints, invitations, and roles
  administration are native-API-only for now.
- Engine support: UE 5.8 is compiled and verified; 5.4 is the declared
  floor but has not yet been compiled.
- Windows and Linux (cross-compile) builds are verified; macOS is not
  yet, and console platforms are unverified.

## License

MIT, see `LICENSE`. `THIRD_PARTY_NOTICES.md` reproduces the notices
for the vendored dependencies (nlohmann/json) that you must carry when
distributing binaries built from this plugin.
