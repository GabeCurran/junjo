// Junjo.io SDK for Unreal Engine
//
// Project settings for the Junjo subsystem, surfaced in the editor
// under Project Settings > Plugins > Junjo.io SDK and persisted to
// DefaultGame.ini.
//
// THERE IS DELIBERATELY NO API KEY PROPERTY HERE, AND NONE MAY BE
// ADDED. Default*.ini files are packaged into the client pak files
// that ship to every player, and pak contents are trivially
// extractable, so an API key stored in config would hand a
// full-control server credential to anyone who installs the game. The
// subsystem reads the key from the JUNJO_API_KEY environment variable
// at runtime instead, which exists only on machines you configure
// (your dedicated game servers), never inside the build.
#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"

#include "JunjoSettings.generated.h"

UCLASS(config = Game, defaultconfig, meta = (DisplayName = "Junjo.io SDK"))
class JUNJOIO_API UJunjoSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	UJunjoSettings();

	// Groups the section under Project Settings > Plugins.
	virtual FName GetCategoryName() const override;

	// Base URL of the Junjo API, without a trailing slash. The
	// JUNJO_BASE_URL environment variable, when set, overrides this at
	// startup so deployed servers can be retargeted without re-cooking.
	UPROPERTY(EditAnywhere, config, Category = "Connection")
	FString BaseUrl;

	// Whole-request timeout applied to every API call, in seconds. A
	// value of zero or less disables the built-in timeout entirely.
	UPROPERTY(EditAnywhere, config, Category = "Connection")
	float RequestTimeoutSeconds;
};
