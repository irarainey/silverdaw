// Message-thread entry points for per-track VST3 inserts. Instantiation, preparation, state
// restore and destruction all happen here; BusGraph owns the barrier that keeps the audio
// thread out of a chain while it changes (ADR 0025).

#include "AudioEngine.h"
#include "Log.h"
#include "TrackPluginRestore.h"

namespace silverdaw
{

plugins::PluginCatalogue& AudioEngine::pluginCatalogue()
{
    if (pluginCatalogueInstance == nullptr)
        pluginCatalogueInstance = std::make_unique<plugins::PluginCatalogue>();

    return *pluginCatalogueInstance;
}

double AudioEngine::getPluginLatencyMs() const
{
    const double sr = master.getSampleRate();
    if (sr <= 0.0) return 0.0;
    return static_cast<double>(busGraph.getLatencyCompensationSamples()) * 1000.0 / sr;
}

juce::String AudioEngine::addTrackPlugin(const juce::String& trackId,
                                         const juce::PluginDescription& description,
                                         const juce::MemoryBlock& state, bool bypassed,
                                         juce::String& errorMessage)
{
    errorMessage.clear();
    if (trackId.isEmpty()) return {};

    double sampleRate = 44100.0;
    int blockSize = 512;
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        sampleRate = device->getCurrentSampleRate();
        blockSize = device->getCurrentBufferSizeSamples();
    }

    auto instance = pluginCatalogue().createInstance(description, sampleRate, blockSize,
                                                     errorMessage);
    if (instance == nullptr)
    {
        log::warn("plugins", "instantiation failed for " + description.name + ": " + errorMessage);
    }

    plugins::PluginSlotDescriptor descriptor;
    descriptor.slotId = juce::Uuid().toDashedString();
    descriptor.identifier = description.fileOrIdentifier;
    descriptor.formatName = description.pluginFormatName;
    descriptor.name = description.name;
    descriptor.manufacturer = description.manufacturerName;
    descriptor.bypassed = bypassed;

    auto slot = std::make_unique<plugins::PluginSlot>(descriptor, std::move(instance));
    const auto slotId = descriptor.slotId;

    busGraph.mutateTrackPlugins(trackId, [&slot, &state](plugins::PluginChain& chain) {
        auto* added = slot.get();
        chain.addSlot(std::move(slot));
        // After prepare, so a plugin that resizes its state on prepareToPlay does not
        // overwrite what we just restored.
        if (!state.isEmpty()) added->setStateChunk(state);
    });

    return slotId;
}

bool AudioEngine::removeTrackPlugin(const juce::String& trackId, const juce::String& slotId)
{
    // The window holds a component owned by the instance we are about to destroy.
    closeTrackPluginEditor(slotId);

    bool removed = false;
    busGraph.mutateTrackPlugins(trackId, [&removed, &slotId](plugins::PluginChain& chain) {
        removed = chain.removeSlot(slotId);
    });

    return removed;
}

bool AudioEngine::moveTrackPlugin(const juce::String& trackId, const juce::String& slotId,
                                  int newIndex)
{
    bool moved = false;
    busGraph.mutateTrackPlugins(trackId, [&moved, &slotId, newIndex](plugins::PluginChain& chain) {
        moved = chain.moveSlot(slotId, newIndex);
    });

    return moved;
}

bool AudioEngine::setTrackPluginBypassed(const juce::String& trackId, const juce::String& slotId,
                                         bool bypassed)
{
    auto* chain = busGraph.getTrackPlugins(trackId);
    if (chain == nullptr) return false;

    // Bypass is an atomic flag the audio thread already reads, so the chain does not change
    // shape and no barrier is needed.
    return chain->setSlotBypassed(slotId, bypassed);
}

std::vector<plugins::PluginSlotDescriptor> AudioEngine::getTrackPluginSlots(
    const juce::String& trackId)
{
    auto* chain = busGraph.getTrackPlugins(trackId);
    return chain != nullptr ? chain->getDescriptors() : std::vector<plugins::PluginSlotDescriptor>{};
}

juce::MemoryBlock AudioEngine::getTrackPluginState(const juce::String& trackId,
                                                   const juce::String& slotId)
{
    auto* chain = busGraph.getTrackPlugins(trackId);
    if (chain == nullptr) return {};

    auto* slot = chain->findSlot(slotId);
    return slot != nullptr ? slot->getStateChunk() : juce::MemoryBlock{};
}

void AudioEngine::setTrackPluginsFromState(const juce::String& trackId,
                                           const std::vector<TrackPluginSlot>& slots)
{
    // Skip the catalogue entirely for a project with no plugins: a headless run that never
    // mentions one has no reason to read the catalogue from disk.
    if (slots.empty() && busGraph.getTrackPlugins(trackId) == nullptr) return;

    double sampleRate = 44100.0;
    int blockSize = 512;
    if (auto* device = deviceManager.getCurrentAudioDevice())
    {
        sampleRate = device->getCurrentSampleRate();
        blockSize = device->getCurrentBufferSizeSamples();
    }

    // A restore may replace instances on the track, so any editor showing one that is not
    // being kept must go first — the window's content component belongs to the instance.
    restoreTrackPlugins(busGraph, pluginCatalogue(), trackId, slots, sampleRate, blockSize,
                        [this](const juce::String& slotId) { closeTrackPluginEditor(slotId); });
}

bool AudioEngine::openTrackPluginEditor(const juce::String& trackId, const juce::String& slotId,
                                        const juce::String& windowTitle)
{
    const auto key = slotId.toStdString();
    if (auto existing = pluginEditors.find(key); existing != pluginEditors.end())
    {
        existing->second->bringToFrontAndFocus();
        return true;
    }

    auto* chain = busGraph.getTrackPlugins(trackId);
    if (chain == nullptr) return false;

    auto* slot = chain->findSlot(slotId);
    if (slot == nullptr) return false;

    auto* instance = slot->getInstance();
    if (instance == nullptr) return false;

    pluginEditors.emplace(
        key, std::make_unique<plugins::PluginEditorWindow>(
                 *instance, windowTitle, [this, key]() {
                     // Deferred: the callback runs from inside the window we are erasing.
                     juce::MessageManager::callAsync(
                         [this, key]() { pluginEditors.erase(key); });
                 }));

    return true;
}

void AudioEngine::closeTrackPluginEditor(const juce::String& slotId)
{
    pluginEditors.erase(slotId.toStdString());
}
} // namespace silverdaw
