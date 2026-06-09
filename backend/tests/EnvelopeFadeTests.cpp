// Envelope / fade: EnvelopeSnapshot interpolation, mixdown + tracksAsJson
// envelope carriage, edge-fade equal-power crossfades, and OffsetSource
// composition of edge fade with the volume envelope.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "LoudnessAnalyzer.h"
#include "Leveler.h"
#include "MixdownEngine.h"
#include "PayloadHelpers.h"
#include "PeaksCache.h"
#include "ProjectFile.h"
#include "ProjectState.h"
#include "SharedFx.h"
#include "ToneEq.h"
#include "ValueTreeJson.h"
#include "WarpProcessor.h"

#include <atomic>
#include <array>
#include <chrono>
#include <cmath>
#include <exception>
#include <limits>
#include <string>
#include <thread>
#include <vector>

#include <juce_events/juce_events.h>

namespace silverdaw::tests
{
namespace
{

void testOffsetSourceComposesEdgeFadeWithEnvelope()
{
    using silverdaw::EdgeFadeSnapshot;
    using silverdaw::EnvelopeSnapshot;
    using silverdaw::OffsetSource;

    ConstantSource child(1.0F);
    OffsetSource os(&child);
    const int blockSize = 512;
    os.prepareToPlay(blockSize, 48000.0);
    os.setOffsetSamples(0);
    os.setInSourceSamples(0);
    os.setClipDurationSamples(0); // play to end of source

    // Fade-in over [0,100) and fade-out over [400,500) in timeline samples.
    auto fade = EdgeFadeSnapshot::create(true, 0, 100, true, 400, 500);
    os.setEdgeFadeSnapshot(fade.get());

    const int n = 500;
    juce::AudioBuffer<float> buf(2, blockSize);

    const auto renderBlock = [&]() {
        buf.clear();
        juce::AudioSourceChannelInfo info(&buf, 0, n);
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    };

    renderBlock();
    for (int i = 0; i < n; ++i)
    {
        requireNear(buf.getSample(0, i), fade->gainAtSample(i), 1.0e-5,
                    "edge fade alone shapes the rendered block in timeline samples");
        requireNear(buf.getSample(1, i), fade->gainAtSample(i), 1.0e-5,
                    "edge fade applies to every channel");
    }

    // Compose with a flat 0.5 volume envelope: output == 0.5 * edge-fade gain.
    const auto mk = [](double t, double g) {
        auto* o = new juce::DynamicObject();
        o->setProperty("timeMs", t);
        o->setProperty("gain", g);
        return juce::var(o);
    };
    juce::Array<juce::var> pts;
    pts.add(mk(0.0, 0.5));
    pts.add(mk(10000.0, 0.5));
    auto env = EnvelopeSnapshot::fromVarArray(pts);
    require(!env->isEmpty(), "flat 0.5 envelope compiles to a usable snapshot");
    os.setEnvelopeSnapshot(env.get());

    renderBlock();
    for (int i = 0; i < n; ++i)
    {
        requireNear(buf.getSample(0, i), 0.5F * fade->gainAtSample(i), 1.0e-5,
                    "edge fade multiplies with the volume envelope, never clobbers it");
    }

    // Clearing the edge fade restores the envelope-only path (still 0.5).
    os.setEdgeFadeSnapshot(nullptr);
    renderBlock();
    for (int i = 0; i < n; ++i)
    {
        requireNear(buf.getSample(0, i), 0.5F, 1.0e-5,
                    "cleared edge fade leaves only the volume envelope");
    }

    // Clearing both layers is bit-identical passthrough of the source.
    os.setEnvelopeSnapshot(nullptr);
    renderBlock();
    for (int i = 0; i < n; ++i)
    {
        requireNear(buf.getSample(0, i), 1.0F, 1.0e-9,
                    "no envelope and no edge fade is a transparent passthrough");
    }
}

void testOffsetSourceReversesClipWindow()
{
    using silverdaw::OffsetSource;

    // RampSource emits each sample's absolute source position as its value, so the rendered
    // buffer reveals exactly which source samples were read and in what order.
    RampSource child;
    OffsetSource os(&child);
    const int blockSize = 256;
    os.prepareToPlay(blockSize, 48000.0);

    const juce::int64 inSrc = 1000;   // clip references source window [1000, 1000 + dur)
    const juce::int64 dur = 200;      // sourceDur in samples
    os.setOffsetSamples(0);
    os.setInSourceSamples(inSrc);
    os.setClipDurationSamples(dur);

    juce::AudioBuffer<float> buf(1, blockSize);
    const auto render = [&](juce::int64 fromPos, int count) {
        buf.clear();
        juce::AudioSourceChannelInfo info(&buf, 0, count);
        os.setNextReadPosition(fromPos);
        os.getNextAudioBlock(info);
    };

    // Forward: the audible block reads the window in ascending source order.
    os.setReversed(false);
    render(0, static_cast<int>(dur));
    for (int i = 0; i < dur; ++i)
        requireNear(buf.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-3,
                    "forward playback reads the clip window in source order");

    // Reversed in a single block: source order is mirrored within the window.
    os.setReversed(true);
    render(0, static_cast<int>(dur));
    for (int i = 0; i < dur; ++i)
        requireNear(buf.getSample(0, i), static_cast<float>(inSrc + (dur - 1 - i)), 1.0e-3,
                    "reversed playback mirrors the clip window");

    // Reversed across a block boundary: the concatenation is still a globally mirrored stream
    // because each block mirrors its own audible span at the correct source offset.
    const int firstBlock = 73;
    os.setReversed(true);
    render(0, firstBlock);
    for (int i = 0; i < firstBlock; ++i)
        requireNear(buf.getSample(0, i), static_cast<float>(inSrc + (dur - 1 - i)), 1.0e-3,
                    "reversed first block mirrors the head of the window");
    render(firstBlock, static_cast<int>(dur) - firstBlock);
    for (int i = 0; i < static_cast<int>(dur) - firstBlock; ++i)
        requireNear(buf.getSample(0, i), static_cast<float>(inSrc + (dur - 1 - (firstBlock + i))),
                    1.0e-3, "reversed second block continues the mirrored stream seamlessly");

    // Clearing the flag restores forward reads (toggling is non-destructive and stateless).
    os.setReversed(false);
    render(0, static_cast<int>(dur));
    for (int i = 0; i < dur; ++i)
        requireNear(buf.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-3,
                    "clearing the reverse flag restores forward source order");
}


void testEnvelopeSnapshotInterpolation()
{
    const auto makePoint = [](double timeMs, double gain) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("gain", gain);
        return juce::var(obj);
    };

    // Empty / single-point arrays compile to an empty (skipped) snapshot.
    require(silverdaw::EnvelopeSnapshot::fromVarArray({})->isEmpty(),
            "empty point array must be an empty snapshot");
    juce::Array<juce::var> single;
    single.add(makePoint(0.0, 0.5));
    require(silverdaw::EnvelopeSnapshot::fromVarArray(single)->isEmpty(),
            "single-point array must be an empty snapshot");

    // Two points: 1.0 (0 dB) at 0 ms down to 0.5 (~-6.02 dB) at 1000 ms.
    juce::Array<juce::var> ramp;
    ramp.add(makePoint(0.0, 1.0));
    ramp.add(makePoint(1000.0, 0.5));
    const auto snap = silverdaw::EnvelopeSnapshot::fromVarArray(ramp);
    require(!snap->isEmpty(), "two-point ramp must be a usable snapshot");

    std::size_t seg = 0;
    // Endpoints return the exact stored linear gains.
    requireNear(snap->gainAtMs(0.0, seg), 1.0, 1.0e-4, "gain at start endpoint");
    seg = 0;
    requireNear(snap->gainAtMs(1000.0, seg), 0.5, 1.0e-4, "gain at end endpoint");
    // Before/after the range clamps to the nearest endpoint.
    seg = 0;
    requireNear(snap->gainAtMs(-50.0, seg), 1.0, 1.0e-4, "before range clamps to first point");
    seg = 0;
    requireNear(snap->gainAtMs(5000.0, seg), 0.5, 1.0e-4, "after range clamps to last point");
    // Midpoint is linear in dB: halfway between 0 dB and -6.0206 dB is
    // -3.0103 dB => 10^(-3.0103/20) ≈ 0.70711, NOT the linear-in-gain 0.75.
    seg = 0;
    requireNear(snap->gainAtMs(500.0, seg), 0.70711, 1.0e-3,
                "midpoint interpolates linear-in-dB (~0.707), not linear-in-gain (0.75)");
}

void testMixdownSnapshotCarriesClipEnvelope()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2),
            "addLibraryItem should succeed");
    require(state.addClip("t1", "c-env", "lib1", 100.0, 1000.0),
            "addClip should succeed for shaped clip");

    const auto makePoint = [](double timeMs, double gain) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("gain", gain);
        return juce::var(obj);
    };
    juce::Array<juce::var> pts;
    pts.add(makePoint(0.0, 1.0));
    pts.add(makePoint(500.0, 0.25));
    require(state.setClipEnvelope("c-env", pts), "setClipEnvelope should succeed");

    // Un-shaped clip on the same track — must carry an empty envelope.
    require(state.addClip("t1", "c-plain", "lib1", 2000.0, 1000.0),
            "addClip should succeed for plain clip");

    const auto snapshot = silverdaw::snapshotProjectForMixdown(state);

    const silverdaw::MixdownSnapshot::ClipSnapshot* shaped = nullptr;
    const silverdaw::MixdownSnapshot::ClipSnapshot* plain = nullptr;
    for (const auto& track : snapshot.tracks)
    {
        for (const auto& clip : track.clips)
        {
            if (clip.id == "c-env") shaped = &clip;
            else if (clip.id == "c-plain") plain = &clip;
        }
    }

    require(shaped != nullptr, "shaped clip should appear in the mixdown snapshot");
    require(plain != nullptr, "plain clip should appear in the mixdown snapshot");
    require(shaped->envelopePoints.size() == 2,
            "snapshot should carry the clip volume-envelope points");
    require(plain->envelopePoints.isEmpty(),
            "un-shaped clip should default to an empty envelope");
    const auto compiled = silverdaw::EnvelopeSnapshot::fromVarArray(shaped->envelopePoints);
    require(!compiled->isEmpty(),
            "carried envelope points must compile to a usable snapshot");
}

void testTracksAsJsonCarriesClipEnvelope()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2),
            "addLibraryItem should succeed");
    require(state.addClip("t1", "c-env", "lib1", 100.0, 1000.0),
            "addClip should succeed for shaped clip");

    const auto makePoint = [](double timeMs, double gain) {
        auto* obj = new juce::DynamicObject();
        obj->setProperty("timeMs", timeMs);
        obj->setProperty("gain", gain);
        return juce::var(obj);
    };
    juce::Array<juce::var> pts;
    pts.add(makePoint(0.0, 1.0));
    pts.add(makePoint(500.0, 0.25));
    require(state.setClipEnvelope("c-env", pts), "setClipEnvelope should succeed");

    // Un-shaped clip on the same track — must omit envelopePoints entirely.
    require(state.addClip("t1", "c-plain", "lib1", 2000.0, 1000.0),
            "addClip should succeed for plain clip");

    // tracksAsJson() is the exact serialisation the renderer receives in the
    // PROJECT_STATE envelope. A clip's volume shape must survive this hop or
    // it is lost on every project reload (regression guard).
    const auto tracks = state.tracksAsJson();
    auto* tracksArr = tracks.getArray();
    require(tracksArr != nullptr && tracksArr->size() == 1, "tracksAsJson should yield one track");

    auto* clipsVar = (*tracksArr)[0].getDynamicObject()->getProperty("clips").getArray();
    require(clipsVar != nullptr && clipsVar->size() == 2, "track should carry two clips");

    const juce::var* shaped = nullptr;
    const juce::var* plain = nullptr;
    for (const auto& clipVar : *clipsVar)
    {
        const auto id = clipVar.getDynamicObject()->getProperty("id").toString();
        if (id == "c-env") shaped = &clipVar;
        else if (id == "c-plain") plain = &clipVar;
    }
    require(shaped != nullptr && plain != nullptr, "both clips should serialise");

    auto* shapedObj = shaped->getDynamicObject();
    require(shapedObj->hasProperty("envelopePoints"),
            "shaped clip must carry envelopePoints in PROJECT_STATE");
    auto* envArr = shapedObj->getProperty("envelopePoints").getArray();
    require(envArr != nullptr && envArr->size() == 2,
            "serialised envelope must carry both breakpoints");
    requireNear(static_cast<double>((*envArr)[1].getDynamicObject()->getProperty("gain")), 0.25, 1e-9,
                "serialised envelope must preserve breakpoint gain");

    require(!plain->getDynamicObject()->hasProperty("envelopePoints"),
            "un-shaped clip must omit envelopePoints to keep PROJECT_STATE tidy");
}

void testTracksAsJsonCarriesClipReversed()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2),
            "addLibraryItem should succeed");
    require(state.addClip("t1", "c-rev", "lib1", 100.0, 1000.0), "addClip should succeed");

    // Forward by default: neither the model nor the wire should carry a reversed flag.
    require(!state.isClipReversed("c-rev"), "a new clip is forward by default");

    require(state.setClipReversed("c-rev", true), "setClipReversed(true) should succeed");
    require(state.isClipReversed("c-rev"), "isClipReversed reflects the stored flag");

    const auto withFlag = state.tracksAsJson();
    auto* clipsArr = (*withFlag.getArray())[0].getDynamicObject()->getProperty("clips").getArray();
    require(clipsArr != nullptr && clipsArr->size() == 1, "track should carry the clip");
    auto* clipObj = (*clipsArr)[0].getDynamicObject();
    require(clipObj->hasProperty("reversed")
                && static_cast<bool>(clipObj->getProperty("reversed")),
            "a reversed clip must carry reversed=true in PROJECT_STATE");

    // Clearing the flag removes it entirely so forward clips stay absent on the wire.
    require(state.setClipReversed("c-rev", false), "setClipReversed(false) should succeed");
    require(!state.isClipReversed("c-rev"), "clearing the flag restores forward playback");
    const auto cleared = state.tracksAsJson();
    auto* clearedClips = (*cleared.getArray())[0].getDynamicObject()->getProperty("clips").getArray();
    require(!(*clearedClips)[0].getDynamicObject()->hasProperty("reversed"),
            "a forward clip must omit reversed to keep PROJECT_STATE tidy");
}

void testEdgeFadeSnapshotEqualPower()
{
        using silverdaw::EdgeFadeSnapshot;

        // Empty descriptor → unity everywhere, reported empty.
        auto empty = EdgeFadeSnapshot::create(false, 0, 0, false, 0, 0);
        require(empty->isEmpty(), "no-leg edge fade is empty");
        requireNear(empty->gainAtSample(500), 1.0, 1.0e-9, "empty edge fade is unity");

        // Degenerate spans (end <= start) are dropped.
        auto degenerate = EdgeFadeSnapshot::create(true, 1000, 1000, true, 2000, 1500);
        require(degenerate->isEmpty(), "degenerate-span legs are dropped");

        // Fade-in over [1000, 2000): equal-power sin ramp, true silence→unity.
        auto fadeIn = EdgeFadeSnapshot::create(true, 1000, 2000, false, 0, 0);
        requireNear(fadeIn->gainAtSample(1000), 0.0, 1.0e-6, "fade-in starts at true silence");
        requireNear(fadeIn->gainAtSample(2000), 1.0, 1.0e-6, "fade-in reaches true unity");
        requireNear(fadeIn->gainAtSample(1500), std::sin(0.5 * 1.57079632679489661923),
                    1.0e-6, "fade-in midpoint is sin(pi/4)");
        requireNear(fadeIn->gainAtSample(50), 0.0, 1.0e-9, "before fade-in region is silent");
        requireNear(fadeIn->gainAtSample(9000), 1.0, 1.0e-9, "after fade-in region is unity");

        // Fade-out over [1000, 2000): equal-power cos ramp, unity→true silence.
        auto fadeOut = EdgeFadeSnapshot::create(false, 0, 0, true, 1000, 2000);
        requireNear(fadeOut->gainAtSample(1000), 1.0, 1.0e-6, "fade-out starts at unity");
        requireNear(fadeOut->gainAtSample(2000), 0.0, 1.0e-6, "fade-out reaches true silence");
        requireNear(fadeOut->gainAtSample(9000), 0.0, 1.0e-9, "after fade-out region is silent");

        // Equal-power law: an out leg and an in leg over the SAME overlap keep
        // constant power (out^2 + in^2 == 1) across the whole sweep — this is
        // the acoustic guarantee that defines the "smooth" crossfade.
        for (juce::int64 s = 1000; s <= 2000; s += 50)
        {
            const double out = fadeOut->gainAtSample(s);
            const double in = fadeIn->gainAtSample(s);
            requireNear(out * out + in * in, 1.0, 1.0e-5,
                        "equal-power crossfade preserves constant power");
        }

        // Sandwiched clip: head fade-in [0,1000) and tail fade-out [4000,5000)
        // compose by multiplication and leave the middle untouched.
        auto sandwich = EdgeFadeSnapshot::create(true, 0, 1000, true, 4000, 5000);
        requireNear(sandwich->gainAtSample(2500), 1.0, 1.0e-9, "sandwich middle is unity");
        requireNear(sandwich->gainAtSample(0), 0.0, 1.0e-6, "sandwich head starts silent");
        requireNear(sandwich->gainAtSample(5000), 0.0, 1.0e-6, "sandwich tail ends silent");
}

} // namespace

void addEnvelopeFadeTests(std::vector<TestCase>& tests)
{
    tests.push_back({"EnvelopeSnapshot interpolates linear-in-dB with endpoint clamping", testEnvelopeSnapshotInterpolation});
    tests.push_back({"Mixdown snapshot carries per-clip volume envelope", testMixdownSnapshotCarriesClipEnvelope});
    tests.push_back({"tracksAsJson carries per-clip volume envelope into PROJECT_STATE", testTracksAsJsonCarriesClipEnvelope});
    tests.push_back({"tracksAsJson carries per-clip reverse flag into PROJECT_STATE", testTracksAsJsonCarriesClipReversed});
    tests.push_back({"EdgeFadeSnapshot equal-power crossfade, endpoints, and sandwiching", testEdgeFadeSnapshotEqualPower});
    tests.push_back({"OffsetSource composes edge fade with volume envelope (B2 audio wiring)", testOffsetSourceComposesEdgeFadeWithEnvelope});
    tests.push_back({"OffsetSource reverses the clip window non-destructively across block boundaries", testOffsetSourceReversesClipWindow});
}

} // namespace silverdaw::tests
