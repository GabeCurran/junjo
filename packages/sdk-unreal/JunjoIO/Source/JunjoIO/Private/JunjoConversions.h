// Junjo.io SDK for Unreal Engine
//
// One-way converters from native junjo:: values to the Blueprint
// mirror structs in JunjoTypes.h, plus the string and timestamp
// helpers the subsystem shares. Module private: game code receives
// mirrors from the subsystem and never converts back, and the async
// surface's input parameters are mapped onto native option structs
// inline at the call sites, so no reverse conversions exist yet.
#pragma once

#include "CoreMinimal.h"

#include <optional>
#include <string>

#include "JunjoNativeApi.h"
#include "JunjoTypes.h"

namespace JunjoConversions
{
	FString ToFString(const std::string& Utf8);
	std::string ToUtf8(const FString& Value);

	// Optional string under the empty-string convention: absent maps
	// to the empty FString. Use only for fields whose present value is
	// guaranteed non-empty (see the convention notes in JunjoTypes.h).
	FString ToFStringOrEmpty(const std::optional<std::string>& Utf8);

	// Parses one of the server's ISO 8601 timestamp strings into an
	// FDateTime. The result is UTC: FDateTime::ParseIso8601 applies
	// any UTC offset carried by the string before returning. The
	// server contract guarantees well-formed ISO 8601; a string that
	// fails to parse anyway maps to the zero FDateTime rather than
	// failing the surrounding conversion.
	FDateTime ParseServerTimestamp(const std::string& Iso8601);

	EJunjoErrorCode Convert(junjo::ErrorCode Code);
	FJunjoError Convert(const junjo::Error& Native);
	FJunjoKeyInfo Convert(const junjo::KeyInfo& Native);
	EJunjoPermissionSource Convert(junjo::PermissionSource Source);
	FJunjoPermissionCheck Convert(const junjo::PermissionCheckResult& Native);
	FJunjoGroup Convert(const junjo::Group& Native);
	FJunjoMember Convert(const junjo::Member& Native);
	FJunjoRole Convert(const junjo::Role& Native);
	FJunjoGroupPage Convert(const junjo::Page<junjo::Group>& Native);
	FJunjoMemberPage Convert(const junjo::Page<junjo::Member>& Native);
}
