// Envelope / fade: EnvelopeSnapshot interpolation, mixdown + tracksAsJson
// envelope carriage, edge-fade equal-power crossfades, and OffsetSource
// composition of edge fade with the volume envelope.

#include "TestRegistry.h"

#include "AudioEngine.h"
#include "AudioConstants.h"
#include "BridgeAuth.h"
#include "EdgeFadeSnapshot.h"
#include "BrakeSnapshot.h"
#include "BackspinSnapshot.h"
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

void testTracksAsJsonCarriesClipBrake()
{
    silverdaw::ProjectState state;
    require(state.addTrack("t1"), "addTrack should succeed");
    require(state.addLibraryItem("lib1", "C:\\audio\\a.wav", "a.wav", 5000.0, 48000, 2),
            "addLibraryItem should succeed");
    require(state.addClip("t1", "c-brake", "lib1", 100.0, 1000.0), "addClip should succeed");

    // No brake by default: neither the model nor the wire should carry a brake flag.
    require(!state.isClipBrake("c-brake"), "a new clip has no brake");

    require(state.setClipBrake("c-brake", true), "setClipBrake(true) should succeed");
    require(state.isClipBrake("c-brake"), "isClipBrake reflects the stored flag");

    const auto withBrake = state.tracksAsJson();
    auto* clipsArr = (*withBrake.getArray())[0].getDynamicObject()->getProperty("clips").getArray();
    require(clipsArr != nullptr && clipsArr->size() == 1, "track should carry the clip");
    auto* clipObj = (*clipsArr)[0].getDynamicObject();
    require(clipObj->hasProperty("brake")
                && static_cast<bool>(clipObj->getProperty("brake")),
            "a braked clip must carry brake=true in PROJECT_STATE");

    // Clearing the brake removes it entirely so plain clips stay absent on the wire.
    require(state.setClipBrake("c-brake", false), "setClipBrake(false) should succeed");
    require(!state.isClipBrake("c-brake"), "clearing the brake removes it");
    const auto cleared = state.tracksAsJson();
    auto* clearedClips = (*cleared.getArray())[0].getDynamicObject()->getProperty("clips").getArray();
    require(!(*clearedClips)[0].getDynamicObject()->hasProperty("brake"),
            "a brake-free clip must omit brake to keep PROJECT_STATE tidy");
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

void testEdgeFadeSnapshotLinear()
{
        using silverdaw::EdgeFadeCurve;
        using silverdaw::EdgeFadeSnapshot;

        // Linear fade-in over [1000, 2000): straight amplitude ramp t, not sin.
        auto fadeIn = EdgeFadeSnapshot::create(true, 1000, 2000, false, 0, 0,
                                               EdgeFadeCurve::linear, EdgeFadeCurve::equalPower);
        requireNear(fadeIn->gainAtSample(1000), 0.0, 1.0e-6, "linear fade-in starts at silence");
        requireNear(fadeIn->gainAtSample(2000), 1.0, 1.0e-6, "linear fade-in reaches unity");
        requireNear(fadeIn->gainAtSample(1500), 0.5, 1.0e-6, "linear fade-in midpoint is 0.5");
        requireNear(fadeIn->gainAtSample(1250), 0.25, 1.0e-6, "linear fade-in quarter is 0.25");

        // Linear fade-out over [1000, 2000): straight 1 - t ramp.
        auto fadeOut = EdgeFadeSnapshot::create(false, 0, 0, true, 1000, 2000,
                                                EdgeFadeCurve::equalPower, EdgeFadeCurve::linear);
        requireNear(fadeOut->gainAtSample(1000), 1.0, 1.0e-6, "linear fade-out starts at unity");
        requireNear(fadeOut->gainAtSample(2000), 0.0, 1.0e-6, "linear fade-out reaches silence");
        requireNear(fadeOut->gainAtSample(1500), 0.5, 1.0e-6, "linear fade-out midpoint is 0.5");

        // Paired linear legs sum to unity gain (amplitude), not constant power.
        for (juce::int64 s = 1000; s <= 2000; s += 50)
        {
            const double in = fadeIn->gainAtSample(s);
            const double out = fadeOut->gainAtSample(s);
            requireNear(in + out, 1.0, 1.0e-5, "linear crossfade sums to unity amplitude");
        }

        // Per-leg curves are independent: a clip can fade in linearly and out
        // with equal power, which is what distinct sandwiching recipes produce.
        auto mixed = EdgeFadeSnapshot::create(true, 0, 1000, true, 4000, 5000,
                                              EdgeFadeCurve::linear, EdgeFadeCurve::equalPower);
        requireNear(mixed->gainAtSample(500), 0.5, 1.0e-6, "mixed head uses linear law");
        requireNear(mixed->gainAtSample(4500),
                    std::cos(0.5 * 1.57079632679489661923), 1.0e-6,
                    "mixed tail uses equal-power law");
}

void testBrakeSnapshotConsumedSourceEndpointsAndMonotonic()
{
    using silverdaw::BrakeSnapshot;

    // Linear rate (power 1): S(u) = u - u^2/(2T); S(0)=0, S(T)=T/2, S(T/2)=3T/8.
    const double T = 1000.0;
    auto lin = BrakeSnapshot::create(static_cast<juce::int64>(T), 1.0);
    requireNear(lin->sourceConsumedAt(0.0, T), 0.0, 1.0e-9, "brake consumes nothing at start");
    requireNear(lin->sourceConsumedAt(T, T), T / 2.0, 1.0e-6, "linear brake swallows half the source");
    requireNear(lin->sourceConsumedAt(T / 2.0, T), 3.0 * T / 8.0, 1.0e-6, "linear S(T/2)=3T/8");

    // Strictly increasing, and always less than linear playback (it decelerates).
    double prev = -1.0;
    for (double u = 0.0; u <= T; u += 25.0)
    {
        const double s = lin->sourceConsumedAt(u, T);
        require(s >= prev - 1.0e-9, "consumed source is monotonic non-decreasing");
        require(s <= u + 1.0e-9, "a brake consumes no more source than 1x playback");
        prev = s;
    }

    // Default power-2 curve: S(T)=T/3 (consumes even less — a longer grind).
    auto p2 = BrakeSnapshot::create(static_cast<juce::int64>(T), 2.0);
    requireNear(p2->sourceConsumedAt(T, T), T / 3.0, 1.0e-6, "power-2 brake swallows two-thirds of the source");
    require(p2->sourceConsumedAt(T / 2.0, T) < lin->sourceConsumedAt(T / 2.0, T),
            "a steeper curve consumes less source early (drops rate faster)");
}

void testBrakeSnapshotRateAndClickGuard()
{
    using silverdaw::BrakeSnapshot;

    const double T = 1000.0;
    auto b = BrakeSnapshot::create(static_cast<juce::int64>(T), 2.0);

    requireNear(b->rateAt(0.0, T), 1.0, 1.0e-9, "rate starts at full speed");
    requireNear(b->rateAt(T, T), 0.0, 1.0e-9, "rate reaches zero at the stop");
    requireNear(b->rateAt(T / 2.0, T), 0.25, 1.0e-9, "power-2 rate at half is 0.25");

    // Click-guard: unity through most of the brake, then a short linear ramp to 0.
    require(b->gainAt(0.0, T) == 1.0F, "click-guard is unity at the start");
    require(b->gainAt(T * 0.5, T) == 1.0F, "click-guard is unity well before the stop");
    require(b->gainAt(T, T) == 0.0F, "click-guard reaches silence exactly at the stop");
    require(b->gainAt(T - 1.0, T) < 1.0F, "click-guard ramps down just before the stop");

    // An empty (zero-length) brake is a guaranteed no-op.
    auto empty = BrakeSnapshot::create(0, 2.0);
    require(empty->isEmpty(), "zero-length brake is empty");
}

void testOffsetSourceBrakeDeceleratesAndIsBlockInvariant()
{
    using silverdaw::BrakeSnapshot;
    using silverdaw::OffsetSource;

    // RampSource emits each sample's absolute source position as its value, so the
    // rendered value reveals exactly which (fractional) source position was read.
    // Linear interpolation of a linear ramp is exact, so the brake's analytic
    // source-consumption curve can be checked to float precision.
    RampSource child;
    OffsetSource os(&child);
    const int blockSize = 256;
    os.prepareToPlay(blockSize, 48000.0);

    const juce::int64 inSrc = 1000;
    const juce::int64 dur = 400;
    os.setOffsetSamples(0);
    os.setInSourceSamples(inSrc);
    os.setClipDurationSamples(dur);

    const juce::int64 brakeLen = 200; // the last 200 samples decelerate to a stop
    auto brake = BrakeSnapshot::create(brakeLen, 2.0);
    os.setBrakeSnapshot(brake.get());

    const juce::int64 brakeStart = dur - brakeLen; // clipStart is 0
    const double baseSrc = static_cast<double>(inSrc + brakeStart);

    const auto renderWhole = [&](juce::AudioBuffer<float>& out) {
        out.setSize(1, static_cast<int>(dur));
        out.clear();
        juce::AudioSourceChannelInfo info(&out, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    };

    juce::AudioBuffer<float> whole;
    renderWhole(whole);

    // Pre-brake region plays at 1x in source order.
    for (int i = 0; i < brakeStart; ++i)
        requireNear(whole.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-2,
                    "pre-brake region plays at 1x in source order");

    // Brake region follows the analytic deceleration curve (skip the click-guard tail).
    for (int j = 0; j < brakeLen; ++j)
    {
        const double u = static_cast<double>(j);
        if (brake->gainAt(u, static_cast<double>(brakeLen)) < 1.0F) continue;
        const double expected = baseSrc + brake->sourceConsumedAt(u, static_cast<double>(brakeLen));
        requireNear(whole.getSample(0, static_cast<int>(brakeStart) + j),
                    static_cast<float>(expected), 0.25,
                    "brake source position follows the analytic deceleration curve");
    }

    // Playback rate is non-increasing through the brake (source increments shrink).
    // Stop at the rate-keyed end fade, where the gain envelope (not the rate) drives
    // the rendered values toward silence.
    for (int j = 1; j < static_cast<int>(brakeLen) - 5; ++j)
    {
        if (brake->gainAt(static_cast<double>(j + 1), static_cast<double>(brakeLen)) < 1.0F) break;
        const float d0 = whole.getSample(0, static_cast<int>(brakeStart) + j)
                       - whole.getSample(0, static_cast<int>(brakeStart) + j - 1);
        const float d1 = whole.getSample(0, static_cast<int>(brakeStart) + j + 1)
                       - whole.getSample(0, static_cast<int>(brakeStart) + j);
        require(d1 <= d0 + 1.0e-3F, "playback rate is non-increasing through the brake");
    }

    // Block-size invariance (parity): render in odd small chunks and confirm the
    // stateless analytic mapping produces sample-identical output.
    juce::AudioBuffer<float> piecewise(1, static_cast<int>(dur));
    piecewise.clear();
    const int chunk = 37;
    for (juce::int64 p = 0; p < dur;)
    {
        const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(chunk), dur - p));
        juce::AudioBuffer<float> tmp(1, n);
        tmp.clear();
        juce::AudioSourceChannelInfo info(&tmp, 0, n);
        os.setNextReadPosition(p);
        os.getNextAudioBlock(info);
        for (int i = 0; i < n; ++i) piecewise.setSample(0, static_cast<int>(p) + i, tmp.getSample(0, i));
        p += n;
    }
    for (int i = 0; i < static_cast<int>(dur); ++i)
        requireNear(piecewise.getSample(0, i), whole.getSample(0, i), 1.0e-3,
                    "brake render is block-size invariant (stateless analytic mapping)");

    // v1 gate: a reversed clip ignores the brake (plain window mirror).
    os.setReversed(true);
    juce::AudioBuffer<float> revBuf(1, static_cast<int>(dur));
    revBuf.clear();
    {
        juce::AudioSourceChannelInfo info(&revBuf, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    }
    requireNear(revBuf.getSample(0, 0), static_cast<float>(inSrc + dur - 1), 1.0e-2,
                "reversed clip ignores the brake in v1 (plain mirror)");
    os.setReversed(false);

    // Clearing the snapshot restores 1x forward playback (toggling is non-destructive).
    os.setBrakeSnapshot(nullptr);
    juce::AudioBuffer<float> cleared;
    renderWhole(cleared);
    for (int i = 0; i < static_cast<int>(dur); ++i)
        requireNear(cleared.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-2,
                    "clearing the brake restores 1x forward playback");
}

// Regression: the read-ahead thread can request brake blocks far larger than the
// scratch buffer. `renderBrakeBlock` must sub-chunk internally so a single huge
// call renders identically to many small calls (previously the tail garbled when
// the span was clamped to the scratch size).
void testOffsetSourceBrakeLargeBlockMatchesPiecewise()
{
    using silverdaw::BrakeSnapshot;
    using silverdaw::OffsetSource;

    RampSource child;
    OffsetSource os(&child);
    os.prepareToPlay(256, 48000.0); // brakeScratch ~ 8208 samples

    const juce::int64 inSrc = 0;
    const juce::int64 dur = 16000;
    os.setOffsetSamples(0);
    os.setInSourceSamples(inSrc);
    os.setClipDurationSamples(dur);

    const juce::int64 brakeLen = 12000; // > scratch -> forces internal sub-chunking
    auto brake = BrakeSnapshot::create(brakeLen, 1.0);
    os.setBrakeSnapshot(brake.get());

    // One huge call (count >> scratch) exercises the multi sub-chunk path.
    juce::AudioBuffer<float> whole(1, static_cast<int>(dur));
    whole.clear();
    {
        juce::AudioSourceChannelInfo info(&whole, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    }

    // Many small odd-sized calls.
    juce::AudioBuffer<float> piece(1, static_cast<int>(dur));
    piece.clear();
    const int chunk = 101;
    for (juce::int64 p = 0; p < dur;)
    {
        const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(chunk), dur - p));
        juce::AudioBuffer<float> tmp(1, n);
        tmp.clear();
        juce::AudioSourceChannelInfo info(&tmp, 0, n);
        os.setNextReadPosition(p);
        os.getNextAudioBlock(info);
        for (int i = 0; i < n; ++i) piece.setSample(0, static_cast<int>(p) + i, tmp.getSample(0, i));
        p += n;
    }

    for (int i = 0; i < static_cast<int>(dur); ++i)
        requireNear(whole.getSample(0, i), piece.getSample(0, i), 1.0e-3,
                    "large single-block brake render matches piecewise (internal sub-chunking is seamless)");

    // No held/garbled run inside the brake: consecutive source positions advance by
    // < 1.05 sample (rate <= 1) and never jump, which a clamped span would violate.
    // Checked over the un-faded region (the rate-keyed end fade scales values down).
    const juce::int64 brakeStart = dur - brakeLen;
    for (int j = 1; j < static_cast<int>(brakeLen); ++j)
    {
        if (brake->gainAt(static_cast<double>(j), static_cast<double>(brakeLen)) < 1.0F) break;
        const float step = whole.getSample(0, static_cast<int>(brakeStart) + j)
                         - whole.getSample(0, static_cast<int>(brakeStart) + j - 1);
        require(step >= -1.0e-2F && step <= 1.05F,
                "braked source position advances smoothly (no clamped/garbled run)");
    }
}

void testBackspinSnapshotRewindEndpointsAndMonotonic()
{
    using silverdaw::BackspinSnapshot;

    const double T = 1000.0;
    const double speed = 4.0;
    auto bs = BackspinSnapshot::create(static_cast<juce::int64>(T), speed, 2.0);

    requireNear(bs->sourceRewoundAt(0.0, T), 0.0, 1.0e-9, "backspin rewinds nothing at the trigger");
    requireNear(bs->sourceRewoundAt(T, T), speed * T / 3.0, 1.0e-6,
                "power-2 backspin rewinds spinSpeed*T/3 of source");
    requireNear(bs->totalRewound(T), speed * T / 3.0, 1.0e-6, "totalRewound matches sourceRewoundAt(T)");

    double prev = -1.0;
    for (double u = 0.0; u <= T; u += 25.0)
    {
        const double s = bs->sourceRewoundAt(u, T);
        require(s >= prev - 1.0e-9, "rewound source is monotonic non-decreasing");
        prev = s;
    }

    auto empty = BackspinSnapshot::create(0, speed, 2.0);
    require(empty->isEmpty(), "zero-length backspin is empty");
}

void testBackspinSnapshotRateAndEndFade()
{
    using silverdaw::BackspinSnapshot;

    const double T = 1000.0;
    auto bs = BackspinSnapshot::create(static_cast<juce::int64>(T), 4.0, 2.0);

    requireNear(bs->rateMagAt(0.0, T), 4.0, 1.0e-9, "spin starts at full reverse speed");
    requireNear(bs->rateMagAt(T, T), 0.0, 1.0e-9, "spin reaches zero at the stop");
    requireNear(bs->rateMagAt(T / 2.0, T), 1.0, 1.0e-9, "power-2 rate at half is speed*0.25");

    require(bs->gainAt(0.0, T) == 1.0F, "end fade is unity at full speed");
    require(bs->gainAt(T * 0.5, T) == 1.0F, "end fade is unity well before the stop");
    require(bs->gainAt(T, T) == 0.0F, "end fade reaches silence exactly at the stop");
    require(bs->gainAt(T - 1.0, T) < 1.0F, "end fade ramps down just before the stop");
}

void testOffsetSourceBackspinRewindsAndIsBlockInvariant()
{
    using silverdaw::BackspinSnapshot;
    using silverdaw::OffsetSource;

    RampSource child;
    OffsetSource os(&child);
    const int blockSize = 256;
    os.prepareToPlay(blockSize, 48000.0);

    const juce::int64 inSrc = 2000;
    const juce::int64 dur = 1000;
    os.setOffsetSamples(0);
    os.setInSourceSamples(inSrc);
    os.setClipDurationSamples(dur);

    const juce::int64 spinLen = 400; // the last 400 samples rewind backward
    const double speed = 4.0;
    auto spin = BackspinSnapshot::create(spinLen, speed, 2.0);
    os.setBackspinSnapshot(spin.get());

    const juce::int64 tailStart = dur - spinLen; // clipStart is 0
    const double s0 = static_cast<double>(inSrc + tailStart);

    const auto renderWhole = [&](juce::AudioBuffer<float>& out) {
        out.setSize(1, static_cast<int>(dur));
        out.clear();
        juce::AudioSourceChannelInfo info(&out, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    };

    juce::AudioBuffer<float> whole;
    renderWhole(whole);

    // Pre-spin region plays at 1x forward in source order.
    for (int i = 0; i < tailStart; ++i)
        requireNear(whole.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-2,
                    "pre-spin region plays forward at 1x");

    // Backspin region follows the analytic reverse rewind curve (skip the end fade).
    for (int j = 0; j < spinLen; ++j)
    {
        const double u = static_cast<double>(j);
        if (spin->gainAt(u, static_cast<double>(spinLen)) < 1.0F) continue;
        const double expected = s0 - spin->sourceRewoundAt(u, static_cast<double>(spinLen));
        requireNear(whole.getSample(0, static_cast<int>(tailStart) + j),
                    static_cast<float>(expected), 0.25,
                    "backspin source position follows the analytic rewind curve");
    }

    // Source position is non-increasing through the spin (it rewinds backward).
    for (int j = 1; j < static_cast<int>(spinLen); ++j)
    {
        if (spin->gainAt(static_cast<double>(j), static_cast<double>(spinLen)) < 1.0F) break;
        const float step = whole.getSample(0, static_cast<int>(tailStart) + j)
                         - whole.getSample(0, static_cast<int>(tailStart) + j - 1);
        require(step <= 1.0e-2F, "backspin rewinds (source position is non-increasing)");
    }

    // Block-size invariance (parity): render in odd small chunks and confirm the
    // stateless analytic mapping produces sample-identical output.
    juce::AudioBuffer<float> piecewise(1, static_cast<int>(dur));
    piecewise.clear();
    const int chunk = 37;
    for (juce::int64 p = 0; p < dur;)
    {
        const int n = static_cast<int>(juce::jmin(static_cast<juce::int64>(chunk), dur - p));
        juce::AudioBuffer<float> tmp(1, n);
        tmp.clear();
        juce::AudioSourceChannelInfo info(&tmp, 0, n);
        os.setNextReadPosition(p);
        os.getNextAudioBlock(info);
        for (int i = 0; i < n; ++i) piecewise.setSample(0, static_cast<int>(p) + i, tmp.getSample(0, i));
        p += n;
    }
    for (int i = 0; i < static_cast<int>(dur); ++i)
        requireNear(piecewise.getSample(0, i), whole.getSample(0, i), 1.0e-3,
                    "backspin render is block-size invariant (stateless analytic mapping)");

    // v1 gate: a reversed clip ignores the backspin (plain window mirror).
    os.setReversed(true);
    juce::AudioBuffer<float> revBuf(1, static_cast<int>(dur));
    revBuf.clear();
    {
        juce::AudioSourceChannelInfo info(&revBuf, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    }
    requireNear(revBuf.getSample(0, 0), static_cast<float>(inSrc + dur - 1), 1.0e-2,
                "reversed clip ignores the backspin in v1 (plain mirror)");
    os.setReversed(false);

    // Clearing the snapshot restores 1x forward playback.
    os.setBackspinSnapshot(nullptr);
    juce::AudioBuffer<float> cleared;
    renderWhole(cleared);
    for (int i = 0; i < static_cast<int>(dur); ++i)
        requireNear(cleared.getSample(0, i), static_cast<float>(inSrc + i), 1.0e-2,
                    "clearing the backspin restores 1x forward playback");
}

// Regression: a long, fast backspin would rewind more source than is available
// before the clip start and FREEZE there for the rest of the region (so a "long"
// backspin sounded short). The render must scale the rewind to fit the available
// source so the spin spans the FULL duration and reaches the clip start only at
// the very end — never bottoming out early.
void testOffsetSourceBackspinScalesToFitShortClip()
{
    using silverdaw::BackspinSnapshot;
    using silverdaw::OffsetSource;

    RampSource child;
    OffsetSource os(&child);
    os.prepareToPlay(256, 48000.0);

    const juce::int64 inSrc = 1000;
    const juce::int64 dur = 600;
    os.setOffsetSamples(0);
    os.setInSourceSamples(inSrc);
    os.setClipDurationSamples(dur);

    // spinLen 500 over a 600-sample clip: only 100 samples precede the trigger,
    // but speed 6 / power 2 requests 6*500/3 = 1000 samples of rewind (10x too much).
    const juce::int64 spinLen = 500;
    auto spin = BackspinSnapshot::create(spinLen, 6.0, 2.0);
    os.setBackspinSnapshot(spin.get());

    const juce::int64 tailStart = dur - spinLen; // = 100; s0 = inSrc + 100 = 1100
    const double s0 = static_cast<double>(inSrc + tailStart);

    juce::AudioBuffer<float> whole(1, static_cast<int>(dur));
    whole.clear();
    {
        juce::AudioSourceChannelInfo info(&whole, 0, static_cast<int>(dur));
        os.setNextReadPosition(0);
        os.getNextAudioBlock(info);
    }

    // RampSource value == source position. At the MIDDLE of the spin the read must
    // still be clearly mid-rewind (between the trigger and the clip start), not
    // pinned at the clip start as the old clamp-and-freeze behaviour would do.
    const int mid = static_cast<int>(tailStart) + static_cast<int>(spinLen / 2);
    const float midPos = whole.getSample(0, mid);
    require(midPos > static_cast<float>(inSrc) + 3.0F,
            "scaled backspin is still rewinding at the midpoint (not frozen at the clip start)");
    require(midPos < static_cast<float>(s0) - 3.0F,
            "scaled backspin has rewound past the trigger by the midpoint");

    // Source position is non-increasing across the whole spin (a true rewind) and
    // never reads before the clip start.
    float prev = static_cast<float>(s0) + 1.0F;
    for (int j = 0; j < static_cast<int>(spinLen); ++j)
    {
        if (spin->gainAt(static_cast<double>(j), static_cast<double>(spinLen)) < 1.0F) break;
        const float v = whole.getSample(0, static_cast<int>(tailStart) + j);
        require(v <= prev + 1.0e-2F, "scaled backspin rewinds monotonically (no forward jump)");
        require(v >= static_cast<float>(inSrc) - 1.0e-2F, "scaled backspin never reads before the clip start");
        prev = v;
    }
}

} // namespace

void addEnvelopeFadeTests(std::vector<TestCase>& tests)
{
    tests.push_back({"EnvelopeSnapshot interpolates linear-in-dB with endpoint clamping", testEnvelopeSnapshotInterpolation});
    tests.push_back({"Mixdown snapshot carries per-clip volume envelope", testMixdownSnapshotCarriesClipEnvelope});
    tests.push_back({"tracksAsJson carries per-clip volume envelope into PROJECT_STATE", testTracksAsJsonCarriesClipEnvelope});
    tests.push_back({"tracksAsJson carries per-clip reverse flag into PROJECT_STATE", testTracksAsJsonCarriesClipReversed});
    tests.push_back({"tracksAsJson carries per-clip brake flag into PROJECT_STATE", testTracksAsJsonCarriesClipBrake});
    tests.push_back({"EdgeFadeSnapshot equal-power crossfade, endpoints, and sandwiching", testEdgeFadeSnapshotEqualPower});
    tests.push_back({"EdgeFadeSnapshot linear curve law and independent per-leg curves", testEdgeFadeSnapshotLinear});
    tests.push_back({"OffsetSource composes edge fade with volume envelope (B2 audio wiring)", testOffsetSourceComposesEdgeFadeWithEnvelope});
    tests.push_back({"OffsetSource reverses the clip window non-destructively across block boundaries", testOffsetSourceReversesClipWindow});
    tests.push_back({"BrakeSnapshot consumed-source endpoints and monotonicity", testBrakeSnapshotConsumedSourceEndpointsAndMonotonic});
    tests.push_back({"BrakeSnapshot rate curve and click-guard", testBrakeSnapshotRateAndClickGuard});
    tests.push_back({"OffsetSource brake decelerates and is block-size invariant", testOffsetSourceBrakeDeceleratesAndIsBlockInvariant});
    tests.push_back({"OffsetSource brake renders large read-ahead blocks without garbling", testOffsetSourceBrakeLargeBlockMatchesPiecewise});
    tests.push_back({"BackspinSnapshot rewind endpoints and monotonicity", testBackspinSnapshotRewindEndpointsAndMonotonic});
    tests.push_back({"BackspinSnapshot rate magnitude and end fade", testBackspinSnapshotRateAndEndFade});
    tests.push_back({"OffsetSource backspin rewinds and is block-size invariant", testOffsetSourceBackspinRewindsAndIsBlockInvariant});
    tests.push_back({"OffsetSource backspin scales the rewind to fit a short clip", testOffsetSourceBackspinScalesToFitShortClip});
}

} // namespace silverdaw::tests
