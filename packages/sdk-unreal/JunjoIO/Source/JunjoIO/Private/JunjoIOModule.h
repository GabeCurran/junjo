// Junjo.io SDK for Unreal Engine
//
// Module interface for JunjoIO. No startup or shutdown work:
// UJunjoSubsystem::Initialize touches FHttpModule from the game thread
// so worker-thread transports find the HTTP module already loaded, and
// everything else is owned by the subsystem's own lifecycle.
#pragma once

#include "Modules/ModuleManager.h"

class FJunjoIOModule final : public IModuleInterface
{
};
