#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw::bridge_auth
{

/** Returns true when `payload.token` satisfies the expected per-session bridge token. */
bool isTokenValid(const juce::String& expectedToken, const juce::var& payload);

} // namespace silverdaw::bridge_auth
