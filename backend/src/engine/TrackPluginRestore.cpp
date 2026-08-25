#include "TrackPluginRestore.h"

#include "Log.h"
#include "PluginChain.h"

#include <algorithm>
#include <memory>

namespace silverdaw
{
namespace
{

// A live slot can stand in for a saved one when it is the same plugin *and* it actually
// loaded. Identity is the slot id: it is minted once and persisted, so it survives the
// round trip through the project tree.
bool canReuse(const plugins::PluginSlot* live, const TrackPluginSlot& saved)
{
    return live != nullptr && !live->isUnresolved()
           && live->getDescriptor().identifier == saved.identifier;
}

} // namespace

void restoreTrackPlugins(BusGraph& busGraph, plugins::PluginCatalogue& catalogue,
                         const juce::String& trackId, const std::vector<TrackPluginSlot>& slots,
                         double sampleRate, int blockSize,
                         const std::function<void(const juce::String&)>& onSlotDestroyed)
{
    if (trackId.isEmpty()) return;
    auto* existingChain = busGraph.getTrackPlugins(trackId);
    if (slots.empty() && existingChain == nullptr) return;

    // A rebuild that already has the right plugin loaded keeps it. Re-creating it would
    // restore the last *saved* chunk, throwing away anything the user has changed in the
    // plugin's editor since — and undoing an unrelated edit rebuilds every track, so that
    // loss would be triggered by actions with nothing to do with plugins.
    std::vector<bool> reusable(slots.size(), false);
    if (existingChain != nullptr)
    {
        for (std::size_t i = 0; i < slots.size(); ++i)
            reusable[i] = canReuse(existingChain->findSlot(slots[i].slotId), slots[i]);
    }

    const auto known = catalogue.getKnownPlugins();

    if (onSlotDestroyed != nullptr && existingChain != nullptr)
    {
        for (const auto& live : existingChain->getDescriptors())
        {
            bool kept = false;
            for (std::size_t i = 0; i < slots.size() && !kept; ++i)
                kept = reusable[i] && slots[i].slotId == live.slotId;

            if (!kept) onSlotDestroyed(live.slotId);
        }
    }

    // Left null where the existing instance is being kept.
    std::vector<std::unique_ptr<plugins::PluginSlot>> rebuilt(slots.size());

    for (std::size_t i = 0; i < slots.size(); ++i)
    {
        if (reusable[i]) continue;

        const auto& saved = slots[i];

        plugins::PluginSlotDescriptor descriptor;
        descriptor.slotId = saved.slotId;
        descriptor.identifier = saved.identifier;
        descriptor.formatName = saved.formatName;
        descriptor.name = saved.name;
        descriptor.manufacturer = saved.manufacturer;
        descriptor.bypassed = saved.bypassed;

        std::unique_ptr<juce::AudioPluginInstance> instance;
        for (const auto& candidate : known)
        {
            if (candidate.fileOrIdentifier != saved.identifier) continue;

            juce::String error;
            instance = catalogue.createInstance(candidate, sampleRate, blockSize, error);
            if (instance == nullptr)
                log::warn("plugins", "could not restore " + saved.name + ": " + error);
            break;
        }

        if (instance == nullptr)
            log::warn("plugins",
                      "unresolved slot for " + saved.name + " (" + saved.identifier + ")");

        rebuilt[i] = std::make_unique<plugins::PluginSlot>(descriptor, std::move(instance));
    }

    busGraph.mutateTrackPlugins(trackId, [&rebuilt, &slots, &reusable](plugins::PluginChain& chain) {
        // Detached rather than removed: a reused slot goes straight back in, and destroying
        // it here would take its open editor window's content component with it.
        std::vector<std::unique_ptr<plugins::PluginSlot>> detached;
        for (const auto& existing : chain.getDescriptors())
            detached.push_back(chain.detachSlot(existing.slotId));

        for (std::size_t i = 0; i < slots.size(); ++i)
        {
            if (reusable[i])
            {
                const auto found = std::find_if(
                    detached.begin(), detached.end(), [&slots, i](const auto& slot) {
                        return slot != nullptr && slot->getSlotId() == slots[i].slotId;
                    });
                if (found != detached.end())
                {
                    (*found)->setBypassed(slots[i].bypassed);
                    chain.addSlot(std::move(*found));
                    continue;
                }
            }

            auto* added = rebuilt[i].get();
            if (added == nullptr) continue;
            chain.addSlot(std::move(rebuilt[i]));
            // Restored after prepare, so a plugin that rebuilds its state on prepareToPlay
            // cannot overwrite what the project saved.
            added->setStateChunk(plugins::decodeStateChunk(slots[i].state));
        }

        for (auto& leftover : detached)
            chain.retireSlot(std::move(leftover));
    });
}

} // namespace silverdaw
