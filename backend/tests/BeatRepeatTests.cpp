#include "TestRegistry.h"

#include "BeatRepeatProcessor.h"
#include "BeatRepeatSnapshot.h"
#include "ProjectState.h"
#include "ValueTreeJson.h"

#include <vector>

namespace silverdaw::tests
{
namespace
{

void testBeatRepeatProjectStatePersistenceAndJson()
{
    ProjectState state;
    require(state.addTrack("track"), "beat repeat test track should add");
    require(!state.addBeatRepeatRegion("track", "bad", -1.0, 4.0, "1/8"),
            "negative beat repeat start must reject");
    require(!state.addBeatRepeatRegion("track", "bad", 0.0, 4.0, "1/32"),
            "unknown beat repeat division must reject");
    require(state.addBeatRepeatRegion("track", "one", 1.25, 4.5, "1/16"),
            "valid fractional beat repeat should add");
    require(!state.addBeatRepeatRegion("track", "overlap", 5.0, 1.0, "1/8"),
            "overlapping beat repeat should reject");
    require(state.addBeatRepeatRegion("track", "adjacent", 5.75, 1.0, "1/4"),
            "adjacent beat repeat should add");
    require(state.addBeatRepeatRegion("track", "clamped", 8.0, 0.1, "1/8"),
            "short beat repeat should clamp to the supported minimum");

    const auto regions = state.getBeatRepeatRegions("track");
    require(regions.size() == 3, "three valid beat repeats should persist");
    requireNear(regions[0].startBeat, 1.25, 1.0e-9, "fractional start beat must preserve");
    requireNear(regions[0].lengthBeats, 4.5, 1.0e-9, "fractional length must preserve");
    requireEqual(regions[0].division, "1/16", "division must preserve");
    requireNear(regions[2].lengthBeats, 0.25, 1.0e-9, "length should clamp to one sixteenth");

    const std::vector<BeatRepeatRegion> timingRegion{{"timing", 4.0, 1.0, "1/4"}};
    const auto at44100 = makeBeatRepeatSnapshot(timingRegion, 44100.0, 120.0);
    const auto at48000 = makeBeatRepeatSnapshot(timingRegion, 48000.0, 120.0);
    require(at44100->regions[0].startSample == 88200,
            "44.1 kHz repeat timing should use the active sample rate");
    require(at48000->regions[0].startSample == 96000,
            "48 kHz repeat timing should use the active sample rate");

    const auto tracks = state.tracksAsJson();
    const auto& jsonRegions = tracks[0].getProperty("beatRepeats", juce::var()).getArray();
    require(jsonRegions != nullptr && jsonRegions->size() == 3,
            "track JSON must expose beat repeat regions");
    requireEqual((*jsonRegions)[0].getProperty("id", "").toString(), "one",
                 "track JSON region id");

    const auto loaded = ValueTreeJson::fromVar(ValueTreeJson::toVar(state.getTree()));
    ProjectState restored;
    require(restored.replaceTree(loaded).wasOk(), "beat repeat tree should restore");
    require(restored.getBeatRepeatRegions("track").size() == 3,
            "beat repeat regions should survive serialization");
}

void testBeatRepeatProcessorCaptureRepeatAndDiscontinuity()
{
    BeatRepeatProcessor processor;
    processor.prepare(20.0);
    BeatRepeatSnapshot snapshot;
    snapshot.regions.push_back({0, 12, 4});

    juce::AudioBuffer<float> buffer(2, 8);
    for (int i = 0; i < 8; ++i)
        buffer.setSample(0, i, static_cast<float>(i + 1));
    buffer.copyFrom(1, 0, buffer, 0, 0, 8);
    processor.process(buffer, 0, 8, 0, &snapshot);
    const float expected[] = {1, 2, 3, 4, 1, 2, 3, 4};
    for (int i = 0; i < 8; ++i)
        requireNear(buffer.getSample(0, i), expected[i], 1.0e-6, "captured slice should repeat");

    juce::AudioBuffer<float> inactive(2, 3);
    inactive.setSample(0, 0, 7.0F);
    inactive.setSample(0, 1, 8.0F);
    inactive.setSample(0, 2, 9.0F);
    processor.process(inactive, 0, 3, 20, &snapshot);
    requireNear(inactive.getSample(0, 1), 8.0, 1.0e-6, "inactive repeat must be transparent");

    juce::AudioBuffer<float> seeked(2, 4);
    for (int i = 0; i < 4; ++i) seeked.setSample(0, i, static_cast<float>(20 + i));
    processor.process(seeked, 0, 4, 2, &snapshot);
    for (int i = 0; i < 4; ++i)
        requireNear(seeked.getSample(0, i), 20.0 + i, 1.0e-6,
                    "discontinuity must capture fresh audio rather than stale replay");
}

} // namespace

void addBeatRepeatTests(std::vector<TestCase>& tests)
{
    tests.push_back({"Beat repeat ProjectState persistence and JSON", testBeatRepeatProjectStatePersistenceAndJson});
    tests.push_back({"Beat repeat processor capture repeat and discontinuity",
                     testBeatRepeatProcessorCaptureRepeatAndDiscontinuity});
}

} // namespace silverdaw::tests
