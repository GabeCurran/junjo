// Junjo.io SDK for Unreal Engine
//
// JunjoIO: the plugin's single module. Carries the vendored Junjo C++
// core (Private/vendor, a byte-identical mirror of packages/sdk-cpp in
// the Junjo monorepo, kept honest by scripts/sync-unreal-sdk.mjs;
// never edit those files here), FJunjoUnrealTransport (the
// junjo::Transport backed by the engine's HTTP module), UJunjoSettings,
// UJunjoSubsystem with its delegate-based async surface, the Blueprint
// type mirrors, and JunjoNativeApi.h (the sanctioned include path to
// the native junjo:: API).
//
// One module rather than a core/facade split: the vendored core is a
// set of plain translation units, so compiling it directly into this
// module keeps the plugin a single DLL with no extra build products.
// Cross-module access works because the core's JUNJO_API annotations
// are mapped onto JUNJOIO_API below.

using System.IO;
using UnrealBuildTool;

public class JunjoIO : ModuleRules
{
	public JunjoIO(ReadOnlyTargetRules Target) : base(Target)
	{
		// Cpp20 to match the vendored junjo sources.
		CppStandard = CppStandardVersion.Cpp20;

		// The vendored core reserves exceptions for programmer errors
		// (junjo::Result precondition violations) and allocation
		// failure, and catches library exceptions at its own boundary
		// (SDK callbacks are required not to throw). Every junjo:: API
		// call reports failure as a junjo::Result value, so nothing
		// ever unwinds out of this module; the flag never leaks past
		// it.
		bEnableExceptions = true;

		// Engine PCHs are built with the engine's default flags; this
		// module diverges (exceptions on), and flag-divergent modules
		// cannot share engine PCHs.
		PCHUsage = PCHUsageMode.NoPCHs;

		// The vendored translation units use file-scope anonymous
		// namespaces with recurring helper names; unity builds would
		// merge them into one TU and collide. Keeping unity off also
		// keeps each vendored file compiling exactly as it does in
		// packages/sdk-cpp.
		bUseUnity = false;

		// DeveloperSettings is public because JunjoSettings.h derives
		// from UDeveloperSettings.
		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core", "CoreUObject", "Engine", "DeveloperSettings",
		});

		// HTTP stays private: the engine-HTTP transport is an
		// implementation detail behind the junjo::Transport interface.
		PrivateDependencyModuleNames.AddRange(new string[] { "HTTP" });

		// Game code consumes the native junjo:: API through
		// JunjoNativeApi.h: the vendored junjo headers must resolve for
		// consumers, so their include root is public.
		PublicIncludePaths.Add(Path.Combine(ModuleDirectory, "Private", "vendor", "junjo", "include"));

		// Ride along on UnrealBuildTool's per-module linkage macro. UBT
		// defines JUNJOIO_API as DLLEXPORT while compiling this module
		// and DLLIMPORT while compiling modules that import it, and as
		// empty in monolithic builds, so mapping the vendored core's
		// JUNJO_API onto it gives junjo:: symbols correct cross-module
		// linkage on every platform. Public so every consuming module
		// compiles the junjo headers with the import-side expansion
		// automatically.
		PublicDefinitions.Add("JUNJO_API=JUNJOIO_API");

		// DLLEXPORT and DLLIMPORT are engine macros from HAL/Platform.h.
		// The vendored core's translation units are plain C++ and never
		// include engine headers, so JUNJOIO_API's expansion would be an
		// undefined identifier there. Define the tokens for this
		// module's own compilation, token-identical to the engine's
		// per-platform definitions, so the TUs in this module that do
		// include engine headers see a benign identical redefinition.
		// Consumers are covered without this: JunjoNativeApi.h includes
		// HAL/Platform.h before the junjo headers. The Microsoft group
		// covers Win64 and the Xbox family (all use __declspec); the
		// Unix, Apple, and Android groups all use ELF/Mach-O visibility
		// attributes. Any other platform gets NOTHING defined here:
		// unknown platforms keep their engine definitions, and the
		// vendored TUs still compile there only because JUNJOIO_API is
		// empty in monolithic builds, which is the only build mode those
		// platforms use.
		if (Target.Platform.IsInGroup(UnrealPlatformGroup.Microsoft))
		{
			PrivateDefinitions.Add("DLLEXPORT=__declspec(dllexport)");
			PrivateDefinitions.Add("DLLIMPORT=__declspec(dllimport)");
		}
		else if (Target.Platform.IsInGroup(UnrealPlatformGroup.Unix)
			|| Target.Platform.IsInGroup(UnrealPlatformGroup.Apple)
			|| Target.Platform.IsInGroup(UnrealPlatformGroup.Android))
		{
			PrivateDefinitions.Add("DLLEXPORT=__attribute__((visibility(\"default\")))");
			PrivateDefinitions.Add("DLLIMPORT=__attribute__((visibility(\"default\")))");
		}

		// Private paths: the vendor root resolves <nlohmann/json.hpp>
		// for the vendored src (nlohmann stays a private dependency and
		// never appears in a public junjo header), and the src
		// directory resolves the core's internal headers.
		PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "Private", "vendor"));
		PrivateIncludePaths.Add(Path.Combine(ModuleDirectory, "Private", "vendor", "junjo", "src"));
	}
}
