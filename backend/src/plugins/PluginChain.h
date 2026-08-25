#pragma once

#include "InsertProcessor.h"

#include <atomic>
#include <memory>
#include <vector>

#include <juce_audio_processors/juce_audio_processors.h>

namespace silverdaw::plugins
{

/** A plugin's opaque state chunk as base64, for storing inline in the project file. */
juce::String encodeStateChunk(const juce::MemoryBlock& chunk);
juce::MemoryBlock decodeStateChunk(const juce::String& base64);

// Everything about a slot that survives a reload and that the UI needs to draw it.
// Deliberately free of any live plugin state so it can be copied on the message thread.
struct PluginSlotDescriptor
{
    juce::String slotId;
    juce::String identifier;
    juce::String formatName{"VST3"};
    juce::String name;
    juce::String manufacturer;
    bool bypassed = false;
};

// One insert. Instantiation, preparation and destruction are message-thread only; the
// audio thread sees a prepared slot through PluginChain's published snapshot and calls
// nothing but `process`.
class PluginSlot final
{
public:
    PluginSlot(PluginSlotDescriptor slotDescriptor,
               std::unique_ptr<juce::AudioPluginInstance> pluginInstance);
    ~PluginSlot();

    PluginSlot(const PluginSlot&) = delete;
    PluginSlot& operator=(const PluginSlot&) = delete;

    /** Message thread. Negotiates a bus layout and sizes the scratch buffer. */
    void prepare(double sampleRate, int maxBlockSize);
    void release();

    /** Message thread. The transport every hosted plugin follows; null detaches it. */
    void setPlayHead(juce::AudioPlayHead* playHead);

    /** Audio thread. Passes audio through untouched when the slot is unresolved. */
    void process(juce::AudioBuffer<float>& buffer, int startSample, int numSamples) noexcept;

    /** Audio thread. Clears the bypass ramp so the next block starts settled. */
    void resetRamp() noexcept;

    /** A slot whose plugin could not be instantiated keeps its position and its saved
     *  state, and passes audio through (ADR 0025). */
    bool isUnresolved() const noexcept { return instance == nullptr; }

    void setBypassed(bool shouldBypass) noexcept
    {
        bypassed.store(shouldBypass, std::memory_order_relaxed);
        descriptor.bypassed = shouldBypass;
    }

    const PluginSlotDescriptor& getDescriptor() const noexcept { return descriptor; }
    const juce::String& getSlotId() const noexcept { return descriptor.slotId; }

    /** Message thread. Null when the slot is unresolved. */
    juce::AudioPluginInstance* getInstance() const noexcept { return instance.get(); }

    int getLatencySamples() const noexcept;

    /** Message thread. The plugin's own state chunk, or the chunk this slot was
     *  constructed with when it is unresolved, so a reload never drops it. */
    juce::MemoryBlock getStateChunk() const;
    void setStateChunk(const juce::MemoryBlock& chunk);

private:
    PluginSlotDescriptor descriptor;
    std::unique_ptr<juce::AudioPluginInstance> instance;
    juce::MemoryBlock savedState;

    juce::AudioBuffer<float> scratch;
    std::vector<float*> scratchChannels;
    juce::MidiBuffer midiScratch;

    std::atomic<bool> bypassed{false};
    float wetGain = 1.0F;
    bool prepared = false;
    double preparedRate = 0.0;
    int preparedBlockSize = 0;
};

// A track's insert chain. Slots are owned and mutated on the message thread; the audio
// thread reads an immutable snapshot published by an atomic pointer swap (ADR 0025).
class PluginChain final : public InsertProcessor
{
public:
    PluginChain() = default;
    ~PluginChain() override;

    PluginChain(const PluginChain&) = delete;
    PluginChain& operator=(const PluginChain&) = delete;

    // ── Audio thread ────────────────────────────────────────────────────

    void processInserts(juce::AudioBuffer<float>& buffer, int startSample,
                        int numSamples) noexcept override;
    void resetInserts() noexcept override;

    // ── Message thread ──────────────────────────────────────────────────

    void addSlot(std::unique_ptr<PluginSlot> slot);
    bool removeSlot(const juce::String& slotId);
    bool moveSlot(const juce::String& slotId, int newIndex);
    bool setSlotBypassed(const juce::String& slotId, bool shouldBypass);

    /** Message thread. Takes a slot out of the chain and hands back ownership *without*
     *  retiring it, so a caller rebuilding the chain can put a live instance back rather
     *  than destroying and re-creating it. The returned slot must be re-added or passed
     *  to `retireSlot` before the next publish. */
    std::unique_ptr<PluginSlot> detachSlot(const juce::String& slotId);

    /** Message thread. Hands a detached slot back for destruction under the usual
     *  publish-then-barrier contract. */
    void retireSlot(std::unique_ptr<PluginSlot> slot);

    void prepare(double sampleRate, int maxBlockSize);
    void release();

    /** Message thread. Shares one transport with every slot, now and as slots are added. */
    void setPlayHead(juce::AudioPlayHead* playHead);

    /** Rebuilds the snapshot the audio thread reads. Every structural mutation above
     *  must be followed by a publish, then a render-thread barrier, then `collectRetired`. */
    void publish();

    /** Destroys slots removed since the last publish. Only safe once the audio thread
     *  is known to have left the previous snapshot (see `BusGraph::mutateTrackPlugins`). */
    void collectRetired();

    PluginSlot* findSlot(const juce::String& slotId) noexcept;
    std::vector<PluginSlotDescriptor> getDescriptors() const;
    std::size_t size() const noexcept { return slots.size(); }
    bool isEmpty() const noexcept { return slots.empty(); }

    /** Worst-case latency the chain adds, in samples. Not yet compensated for. */
    int getLatencySamples() const noexcept;

private:
    // Immutable once published; holds raw pointers to slots the message thread keeps alive.
    struct Snapshot
    {
        std::vector<PluginSlot*> slots;
    };

    std::vector<std::unique_ptr<PluginSlot>> slots;
    std::vector<std::unique_ptr<PluginSlot>> retired;
    std::unique_ptr<Snapshot> currentSnapshot;
    std::unique_ptr<Snapshot> previousSnapshot;
    std::atomic<const Snapshot*> published{nullptr};
    juce::AudioPlayHead* sharedPlayHead = nullptr;

    double preparedRate = 0.0;
    int preparedBlockSize = 0;
};

} // namespace silverdaw::plugins
