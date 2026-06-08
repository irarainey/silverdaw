#pragma once

#include <juce_core/juce_core.h>

#include <initializer_list>
#include <utility>

namespace silverdaw
{

class BridgeServer;

/** Build a `{ ...fields, ok }` payload and broadcast it under `type`.
 *  Collapses the identical DynamicObject + setProperty + broadcast
 *  boilerplate every `*_APPLIED` ack handler used to repeat. Field
 *  values accept anything `juce::var` constructs from (String, bool,
 *  numeric, var array), preserving each handler's existing wire shape. */
void broadcastApplied(BridgeServer& bridge, juce::StringRef type,
                      std::initializer_list<std::pair<const char*, juce::var>> fields,
                      bool ok = true);

} // namespace silverdaw
