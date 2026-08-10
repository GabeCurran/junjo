// Junjo.io SDK for Unreal Engine

#include "JunjoSettings.h"

UJunjoSettings::UJunjoSettings()
	: BaseUrl(TEXT("https://api.junjo.io"))
	, RequestTimeoutSeconds(30.0f)
{
}

FName UJunjoSettings::GetCategoryName() const
{
	return FName(TEXT("Plugins"));
}
