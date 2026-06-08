#pragma once

#include <juce_core/juce_core.h>

#include <initializer_list>
#include <utility>

namespace silverdaw
{

class BridgeServer;

// Shared `*_APPLIED` ack helper keeps bridge payload shapes consistent.
void broadcastApplied(BridgeServer& bridge, juce::StringRef type,
                      std::initializer_list<std::pair<const char*, juce::var>> fields,
                      bool ok = true);

} // namespace silverdaw
