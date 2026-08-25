#include "PluginChain.h"

#include "Log.h"

#include <algorithm>

namespace silverdaw::plugins
{
namespace
{
// Inserts are stereo in the canonical chain, so a plugin is asked for stereo first and
// its sidechain and aux buses are switched off. A plugin that refuses keeps its own
// layout and we pad the extra inputs with silence instead.
bool negotiateStereoLayout(juce::AudioPluginInstance& instance)
{
    const auto stereo = juce::AudioChannelSet::stereo();
    const auto disabled = juce::AudioChannelSet::disabled();

    auto preferred = instance.getBusesLayout();
    for (int i = 0; i < preferred.inputBuses.size(); ++i)
        preferred.inputBuses.getReference(i) = (i == 0) ? stereo : disabled;
    for (int i = 0; i < preferred.outputBuses.size(); ++i)
        preferred.outputBuses.getReference(i) = (i == 0) ? stereo : disabled;

    if (instance.setBusesLayout(preferred)) return true;

    // Some plugins require their sidechain to stay enabled; keep the aux buses as they are.
    auto mainOnly = instance.getBusesLayout();
    if (!mainOnly.inputBuses.isEmpty()) mainOnly.inputBuses.getReference(0) = stereo;
    if (!mainOnly.outputBuses.isEmpty()) mainOnly.outputBuses.getReference(0) = stereo;

    return instance.setBusesLayout(mainOnly);
}
} // namespace

juce::String encodeStateChunk(const juce::MemoryBlock& chunk)
{
    return chunk.isEmpty() ? juce::String{} : chunk.toBase64Encoding();
}

juce::MemoryBlock decodeStateChunk(const juce::String& base64)
{
    juce::MemoryBlock chunk;
    if (base64.isNotEmpty() && !chunk.fromBase64Encoding(base64)) chunk.reset();
    return chunk;
}

// ── PluginSlot ──────────────────────────────────────────────────────────

PluginSlot::PluginSlot(PluginSlotDescriptor slotDescriptor,
                       std::unique_ptr<juce::AudioPluginInstance> pluginInstance)
    : descriptor(std::move(slotDescriptor)), instance(std::move(pluginInstance))
{
    bypassed.store(descriptor.bypassed, std::memory_order_relaxed);
    wetGain = descriptor.bypassed ? 0.0F : 1.0F;
}

PluginSlot::~PluginSlot() { release(); }

void PluginSlot::prepare(double sampleRate, int maxBlockSize)
{
    if (instance == nullptr) return;

    const int blockSize = juce::jmax(1, maxBlockSize);

    // Re-preparing tears the plugin down and builds it back up, which some plugins treat as
    // a reset. A slot moved within an already-prepared chain must not pay that.
    if (prepared && preparedRate == sampleRate && preparedBlockSize == blockSize) return;

    if (prepared) instance->releaseResources();

    negotiateStereoLayout(*instance);

    const int busChannels = juce::jmax(2, instance->getTotalNumInputChannels(),
                                       instance->getTotalNumOutputChannels());

    instance->setRateAndBufferSizeDetails(sampleRate, blockSize);
    instance->prepareToPlay(sampleRate, blockSize);
    prepared = true;
    preparedRate = sampleRate;
    preparedBlockSize = blockSize;

    scratch.setSize(busChannels, blockSize, false, true, false);
    scratch.clear();
    scratchChannels.assign(static_cast<std::size_t>(busChannels), nullptr);
    midiScratch.ensureSize(256);
    midiScratch.clear();
    wetGain = bypassed.load(std::memory_order_relaxed) ? 0.0F : 1.0F;

    // The negotiated layout is the first thing to check when a plugin loads but sounds
    // wrong: extra inputs are fed silence and MIDI is never sent, so either can leave a
    // plugin quiet for reasons that look like a fault.
    log::debug("plugins", "slot prepared name=" + descriptor.name + " in=" +
                              juce::String(instance->getTotalNumInputChannels()) + " out=" +
                              juce::String(instance->getTotalNumOutputChannels()) +
                              " acceptsMidi=" + (instance->acceptsMidi() ? "1" : "0") +
                              " latency=" + juce::String(instance->getLatencySamples()));
}

PluginSlotIo PluginSlot::getIo() const noexcept
{
    PluginSlotIo io;
    if (instance == nullptr) return io;

    io.resolved = true;
    io.acceptsMidi = instance->acceptsMidi();
    io.inputChannels = instance->getTotalNumInputChannels();
    io.outputChannels = instance->getTotalNumOutputChannels();
    return io;
}

void PluginSlot::release()
{
    if (instance != nullptr && prepared)
    {
        // Keep the chunk so an unprepared or unresolved slot still round-trips its state.
        instance->getStateInformation(savedState);
        instance->releaseResources();
    }
    prepared = false;
    preparedRate = 0.0;
    preparedBlockSize = 0;
}

void PluginSlot::resetRamp() noexcept
{
    wetGain = bypassed.load(std::memory_order_relaxed) ? 0.0F : 1.0F;
}

void PluginSlot::setPlayHead(juce::AudioPlayHead* playHead)
{
    if (instance != nullptr) instance->setPlayHead(playHead);
}

void PluginSlot::process(juce::AudioBuffer<float>& buffer, int startSample,
                         int numSamples) noexcept
{
    if (instance == nullptr || !prepared || numSamples <= 0) return;
    if (numSamples > scratch.getNumSamples()) return;

    const float target = bypassed.load(std::memory_order_relaxed) ? 0.0F : 1.0F;

    // A settled bypass costs nothing: the third-party call is skipped entirely. Resuming
    // fades the wet path back in from silence, so a stale tail cannot click.
    if (wetGain == 0.0F && target == 0.0F) return;

    const int busChannels = scratch.getNumChannels();
    const int sourceChannels = juce::jmin(buffer.getNumChannels(), busChannels);

    for (std::size_t ch = 0; ch < scratchChannels.size(); ++ch)
        scratchChannels[ch] = scratch.getWritePointer(static_cast<int>(ch));

    for (int ch = 0; ch < sourceChannels; ++ch)
        juce::FloatVectorOperations::copy(scratchChannels[static_cast<std::size_t>(ch)],
                                          buffer.getReadPointer(ch, startSample), numSamples);
    for (int ch = sourceChannels; ch < busChannels; ++ch)
        juce::FloatVectorOperations::clear(scratchChannels[static_cast<std::size_t>(ch)],
                                           numSamples);

    midiScratch.clear();

    // Third-party code: it may allocate or lock inside this call and we cannot prevent
    // it. This is the bounded exception to ADR 0006 that ADR 0025 documents.
    juce::AudioBuffer<float> view(scratchChannels.data(), busChannels, numSamples);
    instance->processBlock(view, midiScratch);

    if (wetGain == target)
    {
        for (int ch = 0; ch < sourceChannels; ++ch)
            juce::FloatVectorOperations::copy(buffer.getWritePointer(ch, startSample),
                                              view.getReadPointer(ch), numSamples);
        return;
    }

    // Bypass is a ramped crossfade rather than a graph edit, so a toggle never clicks.
    const float step = (target - wetGain) / static_cast<float>(numSamples);
    for (int ch = 0; ch < sourceChannels; ++ch)
    {
        auto* dry = buffer.getWritePointer(ch, startSample);
        const auto* wet = view.getReadPointer(ch);
        float gain = wetGain;
        for (int i = 0; i < numSamples; ++i)
        {
            gain += step;
            dry[i] += (wet[i] - dry[i]) * gain;
        }
    }
    wetGain = target;
}

int PluginSlot::getLatencySamples() const noexcept
{
    return instance != nullptr ? juce::jmax(0, instance->getLatencySamples()) : 0;
}

juce::MemoryBlock PluginSlot::getStateChunk() const
{
    if (instance == nullptr) return savedState;

    juce::MemoryBlock chunk;
    instance->getStateInformation(chunk);
    return chunk;
}

void PluginSlot::setStateChunk(const juce::MemoryBlock& chunk)
{
    savedState = chunk;
    if (instance != nullptr && !chunk.isEmpty())
        instance->setStateInformation(chunk.getData(), static_cast<int>(chunk.getSize()));
}

// ── PluginChain ─────────────────────────────────────────────────────────

PluginChain::~PluginChain()
{
    published.store(nullptr, std::memory_order_release);
    release();
}

void PluginChain::processInserts(juce::AudioBuffer<float>& buffer, int startSample,
                                 int numSamples) noexcept
{
    const auto* snapshot = published.load(std::memory_order_acquire);
    if (snapshot == nullptr) return;

    for (auto* slot : snapshot->slots)
        slot->process(buffer, startSample, numSamples);
}

void PluginChain::resetInserts() noexcept
{
    const auto* snapshot = published.load(std::memory_order_acquire);
    if (snapshot == nullptr) return;

    for (auto* slot : snapshot->slots)
        slot->resetRamp();
}

void PluginChain::addSlot(std::unique_ptr<PluginSlot> slot)
{
    if (slot == nullptr) return;
    // Set before prepare: a plugin may query the transport while preparing.
    slot->setPlayHead(sharedPlayHead);
    if (preparedRate > 0.0) slot->prepare(preparedRate, preparedBlockSize);
    slots.push_back(std::move(slot));
}

bool PluginChain::removeSlot(const juce::String& slotId)
{
    const auto found = std::find_if(slots.begin(), slots.end(), [&slotId](const auto& slot) {
        return slot->getSlotId() == slotId;
    });
    if (found == slots.end()) return false;

    retired.push_back(std::move(*found));
    slots.erase(found);
    return true;
}

std::unique_ptr<PluginSlot> PluginChain::detachSlot(const juce::String& slotId)
{
    const auto found = std::find_if(slots.begin(), slots.end(), [&slotId](const auto& slot) {
        return slot->getSlotId() == slotId;
    });
    if (found == slots.end()) return nullptr;

    auto detached = std::move(*found);
    slots.erase(found);
    return detached;
}

void PluginChain::retireSlot(std::unique_ptr<PluginSlot> slot)
{
    if (slot != nullptr) retired.push_back(std::move(slot));
}

bool PluginChain::moveSlot(const juce::String& slotId, int newIndex)
{
    const auto found = std::find_if(slots.begin(), slots.end(), [&slotId](const auto& slot) {
        return slot->getSlotId() == slotId;
    });
    if (found == slots.end()) return false;

    const auto clamped = juce::jlimit(0, static_cast<int>(slots.size()) - 1, newIndex);
    auto moved = std::move(*found);
    slots.erase(found);
    slots.insert(slots.begin() + clamped, std::move(moved));
    return true;
}

bool PluginChain::setSlotBypassed(const juce::String& slotId, bool shouldBypass)
{
    auto* slot = findSlot(slotId);
    if (slot == nullptr) return false;

    slot->setBypassed(shouldBypass);
    return true;
}

void PluginChain::prepare(double sampleRate, int maxBlockSize)
{
    preparedRate = sampleRate;
    preparedBlockSize = juce::jmax(1, maxBlockSize);
    for (auto& slot : slots)
        slot->prepare(preparedRate, preparedBlockSize);
}

void PluginChain::release()
{
    preparedRate = 0.0;
    preparedBlockSize = 0;
    for (auto& slot : slots)
        slot->release();
}

void PluginChain::setPlayHead(juce::AudioPlayHead* playHead)
{
    sharedPlayHead = playHead;
    for (auto& slot : slots)
        slot->setPlayHead(playHead);
}

void PluginChain::publish()
{
    auto next = std::make_unique<Snapshot>();
    next->slots.reserve(slots.size());
    for (auto& slot : slots)
        next->slots.push_back(slot.get());

    previousSnapshot = std::move(currentSnapshot);
    currentSnapshot = std::move(next);
    published.store(currentSnapshot.get(), std::memory_order_release);
}

void PluginChain::collectRetired()
{
    previousSnapshot.reset();
    retired.clear();
}

PluginSlot* PluginChain::findSlot(const juce::String& slotId) noexcept
{
    for (auto& slot : slots)
        if (slot->getSlotId() == slotId) return slot.get();

    return nullptr;
}

std::vector<PluginSlotDescriptor> PluginChain::getDescriptors() const
{
    std::vector<PluginSlotDescriptor> out;
    out.reserve(slots.size());
    for (const auto& slot : slots)
        out.push_back(slot->getDescriptor());

    return out;
}

int PluginChain::getLatencySamples() const noexcept
{
    int total = 0;
    for (const auto& slot : slots)
        total += slot->getLatencySamples();

    return total;
}

} // namespace silverdaw::plugins
