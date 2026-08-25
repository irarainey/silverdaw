#pragma once

#include "BusGraph.h"
#include "PluginCatalogue.h"
#include "ProjectStateTypes.h"

#include <functional>
#include <vector>

namespace silverdaw
{

// Rebuilds `trackId`'s VST3 inserts on `busGraph` from persisted slots, resolving each plugin
// against `catalogue`. Live playback and offline mixdown both go through here so an export
// renders the same chain, in the same order, from the same saved state (ADR 0022, ADR 0025).
// A plugin that cannot be resolved becomes an unresolved pass-through rather than vanishing.
//
// A slot the track already holds is kept rather than re-created, so a rebuild triggered by an
// unrelated edit cannot reset a plugin to its last-saved settings. `onSlotDestroyed` is called
// on the message thread for each live slot that is *not* kept, before anything is torn down,
// so the caller can close an editor window whose content the instance owns.
void restoreTrackPlugins(BusGraph& busGraph, plugins::PluginCatalogue& catalogue,
                         const juce::String& trackId, const std::vector<TrackPluginSlot>& slots,
                         double sampleRate, int blockSize,
                         const std::function<void(const juce::String&)>& onSlotDestroyed = {});

} // namespace silverdaw
