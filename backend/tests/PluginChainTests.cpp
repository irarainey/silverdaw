// Per-track VST3 insert chain: ordering, ramped bypass, and the unresolved slot a missing
// plugin degrades to (ADR 0025). A fake in-process instance keeps the behaviour under test
// deterministic and independent of what is installed on the machine.

#include "TestRegistry.h"

#include "PluginChain.h"
#include "PluginPlayHead.h"

#include <cmath>
#include <vector>

namespace silverdaw::tests
{
namespace
{

// Applies a fixed gain so a block's value identifies exactly which slots ran, and in what
// order once the gains differ per slot.
class FakeGainPlugin final : public juce::AudioPluginInstance
{
public:
    explicit FakeGainPlugin(float gainToApply, int latency = 0) : gain(gainToApply)
    {
        setPlayConfigDetails(2, 2, 44100.0, 512);
        setLatencySamples(latency);
    }

    const juce::String getName() const override { return "FakeGain"; }

    void prepareToPlay(double, int) override { prepareCalls++; }
    void releaseResources() override {}

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer&) override
    {
        if (auto* host = getPlayHead())
            lastPosition = host->getPosition();

        buffer.applyGain(gain);
        blocksProcessed++;
    }

    double getTailLengthSeconds() const override { return 0.0; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }

    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock& destination) override
    {
        destination.replaceAll(state.getData(), state.getSize());
    }

    void setStateInformation(const void* data, int size) override
    {
        state.replaceAll(data, static_cast<std::size_t>(size));
    }

    void fillInPluginDescription(juce::PluginDescription& description) const override
    {
        description.name = "FakeGain";
        description.pluginFormatName = "VST3";
        description.category = "Fx";
    }

    bool isBusesLayoutSupported(const BusesLayout& layout) const override
    {
        return layout.getMainInputChannelSet() == juce::AudioChannelSet::stereo()
               && layout.getMainOutputChannelSet() == juce::AudioChannelSet::stereo();
    }

    juce::MemoryBlock state;
    int blocksProcessed = 0;
    int prepareCalls = 0;
    juce::Optional<juce::AudioPlayHead::PositionInfo> lastPosition;

private:
    float gain;
};

plugins::PluginSlotDescriptor makeDescriptor(const juce::String& slotId, bool bypassed = false)
{
    plugins::PluginSlotDescriptor descriptor;
    descriptor.slotId = slotId;
    descriptor.name = "FakeGain";
    descriptor.identifier = "fake:" + slotId;
    descriptor.bypassed = bypassed;
    return descriptor;
}

// Fills both channels with `value` and returns what the chain leaves at `sampleIndex`.
// A ramp lands on its target at the final sample, so mid-block is where a cross-fade shows.
float runChain(plugins::PluginChain& chain, float value, int sampleIndex = -1,
               int numSamples = 64)
{
    juce::AudioBuffer<float> buffer(2, numSamples);
    for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
        juce::FloatVectorOperations::fill(buffer.getWritePointer(ch), value, numSamples);

    chain.processInserts(buffer, 0, numSamples);
    return buffer.getSample(0, sampleIndex < 0 ? numSamples - 1 : sampleIndex);
}

constexpr double kRate = 44100.0;
constexpr int kBlock = 64;

// Nothing may reach the audio thread until it is published, and slots must then run in the
// order the user arranged them.
void testChainRunsSlotsInOrder()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("a"),
                                                        std::make_unique<FakeGainPlugin>(2.0F)));
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("b"),
                                                        std::make_unique<FakeGainPlugin>(3.0F)));

    require(runChain(chain, 1.0F) == 1.0F, "an unpublished chain must not touch the audio");

    chain.publish();
    require(std::abs(runChain(chain, 1.0F) - 6.0F) < 1.0e-5F, "both slots must run");

    require(chain.moveSlot("b", 0), "moveSlot must find an existing slot");
    chain.publish();
    require(std::abs(runChain(chain, 1.0F) - 6.0F) < 1.0e-5F,
            "reordering gains must not change their product");
    require(chain.getDescriptors().front().slotId == "b", "the moved slot must lead the chain");
}

// Removing a slot must take it off the audio path immediately, and only destroy it once the
// caller has confirmed the audio thread has moved on.
void testRemovedSlotLeavesTheAudioPath()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    auto plugin = std::make_unique<FakeGainPlugin>(2.0F);
    auto* fake = plugin.get();
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("a"), std::move(plugin)));
    chain.publish();

    require(std::abs(runChain(chain, 1.0F) - 2.0F) < 1.0e-5F, "the slot must be audible");
    const int processedWhileLive = fake->blocksProcessed;

    require(chain.removeSlot("a"), "removeSlot must find an existing slot");
    chain.publish();
    chain.collectRetired();

    require(runChain(chain, 1.0F) == 1.0F, "a removed slot must not process audio");
    require(chain.isEmpty(), "the chain must forget a removed slot");
    require(processedWhileLive > 0, "the slot must have processed audio before removal");
}

// A missing plugin keeps its place and passes audio through rather than disappearing, so a
// project opened on a machine without the plugin still saves the user's settings back.
void testUnresolvedSlotPassesAudioThrough()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    juce::MemoryBlock savedState;
    savedState.append("opaque-plugin-state", 19);

    auto slot = std::make_unique<plugins::PluginSlot>(makeDescriptor("missing"), nullptr);
    slot->setStateChunk(savedState);
    auto* unresolved = slot.get();
    chain.addSlot(std::move(slot));
    chain.publish();

    require(unresolved->isUnresolved(), "a slot with no instance must report as unresolved");
    require(runChain(chain, 0.5F) == 0.5F, "an unresolved slot must pass audio through untouched");
    require(unresolved->getStateChunk() == savedState,
            "an unresolved slot must hand back the state it was given");
    require(chain.getLatencySamples() == 0, "an unresolved slot must add no latency");
}

// Bypass crossfades rather than cutting, and a settled bypass stops calling the plugin at all.
void testBypassRampsAndThenSkipsThePlugin()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    auto plugin = std::make_unique<FakeGainPlugin>(2.0F);
    auto* fake = plugin.get();
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("a"), std::move(plugin)));
    chain.publish();

    require(std::abs(runChain(chain, 1.0F) - 2.0F) < 1.0e-5F, "the slot must start active");

    require(chain.setSlotBypassed("a", true), "setSlotBypassed must find an existing slot");
    const float ramped = runChain(chain, 1.0F, /*sampleIndex*/ 32);
    require(ramped > 1.0F && ramped < 2.0F, "the first bypassed block must cross-fade, not cut");

    const int processedDuringRamp = fake->blocksProcessed;
    require(runChain(chain, 1.0F) == 1.0F, "a settled bypass must leave the audio untouched");
    require(fake->blocksProcessed == processedDuringRamp,
            "a settled bypass must not call the plugin at all");

    require(chain.setSlotBypassed("a", false), "un-bypassing must find the slot");
    const float resumed = runChain(chain, 1.0F, /*sampleIndex*/ 32);
    require(resumed > 1.0F && resumed < 2.0F, "resuming must fade the wet path back in");
    require(std::abs(runChain(chain, 1.0F) - 2.0F) < 1.0e-5F,
            "the slot must be fully wet again once the ramp has settled");
}

// The chain has to reach the plugin's own prepareToPlay, including for a slot added after
// the chain was already prepared.
void testSlotsArePreparedIncludingLateAdditions()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    auto plugin = std::make_unique<FakeGainPlugin>(2.0F, /*latency*/ 128);
    auto* fake = plugin.get();
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("late"), std::move(plugin)));
    chain.publish();

    require(fake->prepareCalls > 0, "a slot added after prepare must still be prepared");
    require(chain.getLatencySamples() == 128, "the chain must report its plugins' latency");
}

// Tempo-synced plugins are useless without a transport, so the chain must hand every slot
// the shared play head — including slots added after the play head was set.
void testSlotsSeeTheSharedPlayHead()
{
    std::atomic<juce::int64> position{88200};
    const std::atomic<double> rate{kRate};
    const std::atomic<bool> playing{true};

    plugins::PluginPlayHead playHead;
    playHead.setTransportSources(&position, &rate, &playing);
    playHead.setBpm(90.0);

    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);
    chain.setPlayHead(&playHead);

    auto plugin = std::make_unique<FakeGainPlugin>(1.0F);
    auto* fake = plugin.get();
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("sync"), std::move(plugin)));
    chain.publish();

    runChain(chain, 1.0F);
    require(fake->lastPosition.hasValue(), "a hosted plugin must be given a play head");
    require(fake->lastPosition->getTimeInSamples().orFallback(-1) == 88200,
            "the play head must report the engine's transport position");
    require(std::abs(fake->lastPosition->getBpm().orFallback(0.0) - 90.0) < 1.0e-9,
            "the play head must report the project tempo");
    require(fake->lastPosition->getIsPlaying(), "the play head must report the transport state");

    // Two seconds in at 90 bpm is three beats.
    require(std::abs(fake->lastPosition->getPpqPosition().orFallback(0.0) - 3.0) < 1.0e-6,
            "the play head must derive a ppq position from tempo and elapsed time");

    // The play head is shared, not copied, so movement is visible without re-publishing.
    position.store(0);
    runChain(chain, 1.0F);
    require(fake->lastPosition->getTimeInSamples().orFallback(-1) == 0,
            "the play head must follow the transport, not a snapshot of it");
}

// A chain rebuild triggered by an unrelated edit must not reset live plugins: a slot that is
// still the same plugin is moved across intact rather than destroyed and re-created.
void testDetachedSlotsSurviveAChainRebuild()
{
    plugins::PluginChain chain;
    chain.prepare(kRate, kBlock);

    auto plugin = std::make_unique<FakeGainPlugin>(2.0F);
    auto* fake = plugin.get();
    chain.addSlot(std::make_unique<plugins::PluginSlot>(makeDescriptor("keep"), std::move(plugin)));
    chain.publish();

    const int preparesAfterAdd = fake->prepareCalls;

    auto detached = chain.detachSlot("keep");
    require(detached != nullptr, "detachSlot must hand back the slot");
    require(chain.isEmpty(), "a detached slot must leave the chain");
    require(detached->getInstance() == fake, "detaching must not destroy the instance");

    chain.addSlot(std::move(detached));
    chain.publish();

    require(fake->prepareCalls == preparesAfterAdd,
            "re-adding an already-prepared slot must not re-prepare the plugin");
    require(std::abs(runChain(chain, 1.0F) - 2.0F) < 1.0e-5F,
            "the reinstated slot must still be in the audio path");

    require(chain.detachSlot("missing") == nullptr, "detachSlot must tolerate an unknown id");
}

} // namespace

void addPluginChainTests(std::vector<TestCase>& tests)
{
    tests.push_back({"PluginChain runs its slots in order once published", testChainRunsSlotsInOrder});
    tests.push_back({"PluginChain removes a slot from the audio path", testRemovedSlotLeavesTheAudioPath});
    tests.push_back({"PluginChain passes audio through an unresolved slot", testUnresolvedSlotPassesAudioThrough});
    tests.push_back({"PluginChain ramps bypass and then skips the plugin", testBypassRampsAndThenSkipsThePlugin});
    tests.push_back({"PluginChain prepares slots added after the chain", testSlotsArePreparedIncludingLateAdditions});
    tests.push_back({"PluginChain gives its slots the shared transport play head", testSlotsSeeTheSharedPlayHead});
    tests.push_back({"PluginChain keeps a detached slot alive across a rebuild", testDetachedSlotsSurviveAChainRebuild});
}

} // namespace silverdaw::tests
