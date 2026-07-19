// ProjectState FX/property round-trips: per-track sends/tone/leveler/pan and
// clip envelope normalisation as they appear in the PROJECT_STATE snapshot,
// plus default-suppression and the project delay note-value guard.

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

void testProjectStateTrackSendsRoundTrip()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-sends"), "addTrack should accept new id");
        const auto track = state.getTree().getChildWithProperty(
            juce::Identifier{"id"}, juce::var("t-sends"));
        require(track.isValid(), "track lookup should succeed");

        const juce::Identifier kSendReverb{"sendReverb"};
        const juce::Identifier kSendDelay{"sendDelay"};

        require(!track.hasProperty(kSendReverb),
                "default sendReverb should be absent on a fresh track");
        require(!track.hasProperty(kSendDelay),
                "default sendDelay should be absent on a fresh track");

        const bool noOp = state.setTrackSends("t-sends", 0.0F, 0.0F);
        require(!noOp, "setTrackSends 0/0 on a fresh track should be a no-op");
        require(!track.hasProperty(kSendReverb),
                "no-op send write must not create properties");

        const bool changed = state.setTrackSends("t-sends", 0.4F, 0.7F);
        require(changed, "non-default sends should report changed=true");
        requireNear(state.getTrackReverbSend("t-sends"), 0.4, 0.0001,
                    "reverbSend round-trip");
        requireNear(state.getTrackDelaySend("t-sends"), 0.7, 0.0001,
                    "delaySend round-trip");

        const bool repeat = state.setTrackSends("t-sends", 0.4F, 0.7F);
        require(!repeat, "repeated same-value send write should be a no-op");

        const bool clamped = state.setTrackSends("t-sends", 5.0F, 0.7F);
        require(clamped, "above-range reverb should clamp and report changed");
        requireNear(state.getTrackReverbSend("t-sends"), 1.0, 0.0001,
                    "reverbSend should clamp to 1.0");

        const bool cleared = state.setTrackSends("t-sends", 0.0F, 0.0F);
        require(cleared, "reset to default should report changed=true");
        require(!track.hasProperty(kSendReverb),
                "default-suppression: zero must remove sendReverb property");
        require(!track.hasProperty(kSendDelay),
                "default-suppression: zero must remove sendDelay property");

        require(!state.setTrackSends("missing", 0.1F, 0.2F),
                "setTrackSends should reject unknown trackId");
}

void testProjectStateClipEnvelopeNormalisation()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-env"), "addTrack should succeed");
        require(state.addClip("t-env", "c-env", "lib-x", 0.0, 5000.0),
                "addClip should succeed");

        const auto clip = state.getTree().getChildWithProperty(
                                       juce::Identifier{"id"}, juce::var("t-env"))
                              .getChildWithProperty(juce::Identifier{"id"}, juce::var("c-env"));
        require(clip.isValid(), "clip lookup should succeed");
        const juce::Identifier kEnvelopePoints{"envelopePoints"};

        require(!clip.hasProperty(kEnvelopePoints),
                "fresh clip should not carry envelopePoints");
        require(!state.setClipEnvelope("c-env", {}),
                "empty envelope on a fresh clip is a no-op");

        const auto makePoint = [](double timeMs, double gain) {
            auto* obj = new juce::DynamicObject();
            obj->setProperty("timeMs", timeMs);
            obj->setProperty("gain", gain);
            return juce::var(obj);
        };

        juce::Array<juce::var> unsorted;
        unsorted.add(makePoint(200.0, 0.5));
        unsorted.add(makePoint(0.0, 1.0));
        unsorted.add(makePoint(100.0, 0.75));
        require(state.setClipEnvelope("c-env", unsorted),
                "sort-and-store should report changed");

        const auto stored = state.getClipEnvelope("c-env");
        require(stored.size() == 3, "stored envelope should have 3 points");
        const auto t0 = static_cast<double>(stored.getReference(0).getProperty("timeMs", juce::var{}));
        const auto t1 = static_cast<double>(stored.getReference(1).getProperty("timeMs", juce::var{}));
        const auto t2 = static_cast<double>(stored.getReference(2).getProperty("timeMs", juce::var{}));
        requireNear(t0, 0.0, 0.0001, "points sorted ascending t0");
        requireNear(t1, 100.0, 0.0001, "points sorted ascending t1");
        requireNear(t2, 200.0, 0.0001, "points sorted ascending t2");

        juce::Array<juce::var> dup;
        dup.add(makePoint(50.0, 1.0));
        dup.add(makePoint(50.0, 0.5));
        require(!state.setClipEnvelope("c-env", dup),
                "duplicate timeMs must be rejected (no mutation)");
        require(state.getClipEnvelope("c-env").size() == 3,
                "rejected duplicate must leave prior envelope intact");

        juce::Array<juce::var> empty;
        require(state.setClipEnvelope("c-env", empty),
                "clearing a populated envelope should report changed");
        require(!clip.hasProperty(kEnvelopePoints),
                "empty envelope must remove the property entirely");
}

void testProjectStateDelayNoteValueGuard()
{
        silverdaw::ProjectState state;

        require(!state.setProjectDelay("1/8", 0.0F, 0.0F, 0.0F),
                "default 1/8 + zeros must be a no-op");

        require(state.setProjectDelay("1/4", 0.3F, 0.5F, 0.2F),
                "valid noteValue + non-default scalars should persist");
        requireEqual(state.getProjectDelayNoteValue(), juce::String{"1/4"},
                     "noteValue round-trip");

        require(!state.setProjectDelay(" 1/8 ", 0.3F, 0.5F, 0.2F),
                "whitespace variants must be rejected without mutation");
        require(!state.setProjectDelay("1/2", 0.3F, 0.5F, 0.2F),
                "unknown noteValue must be rejected without mutation");
        requireEqual(state.getProjectDelayNoteValue(), juce::String{"1/4"},
                     "rejected writes must leave noteValue untouched");
}

void testProjectStateSafetyLimiterDefaultsAndRoundTrip()
{
    silverdaw::ProjectState fresh;
    require(fresh.getSafetyLimiterEnabled(),
            "a newly created project should enable the safety limiter");

    fresh.setSafetyLimiterEnabled(false);
    require(!fresh.getSafetyLimiterEnabled(),
            "disabling the safety limiter should clear the enabled state");
    require(!fresh.getTree().hasProperty(juce::Identifier{"safetyLimiterEnabled"}),
            "the disabled safety limiter should use default suppression");

    juce::ValueTree legacyProject(juce::Identifier{"PROJECT"});
    legacyProject.setProperty(juce::Identifier{"name"}, "Legacy", nullptr);
    fresh.replaceTree(legacyProject);
    require(!fresh.getSafetyLimiterEnabled(),
            "an older project without the property must retain its original output behaviour");

    fresh.setSafetyLimiterEnabled(true);
    require(fresh.getSafetyLimiterEnabled(), "enabling the safety limiter should persist");
    require(static_cast<bool>(fresh.getTree().getProperty(
                juce::Identifier{"safetyLimiterEnabled"}, false)),
            "enabled safety limiter must be stored in project state");
}

void testProjectStateTrackToneJsonRoundTrip()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-tone"), "addTrack should succeed");

        const auto findTrackJson = [](const juce::var& tracks,
                                      const juce::String& id) -> juce::var {
            if (auto* arr = tracks.getArray())
            {
                for (const auto& tv : *arr)
                {
                    if (tv.getProperty("id", {}).toString() == id) return tv;
                }
            }
            return {};
        };

        // Fresh track: tone fields are at their defaults and must be
        // absent from the snapshot so saved files / acks stay tidy.
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "fresh track should appear in tracksAsJson");
            require(!json.hasProperty("toneBassDb"), "default bass must be omitted");
            require(!json.hasProperty("toneMidDb"), "default mid must be omitted");
            require(!json.hasProperty("toneTrebleDb"), "default treble must be omitted");
            require(!json.hasProperty("toneFilter"), "default filter must be omitted");
        }

        // Set a non-default tone and confirm every field round-trips
        // through the snapshot the renderer reads on PROJECT_STATE.
        require(state.setTrackTone("t-tone", 3.5F, -2.0F, 6.0F, -0.5F),
                "non-default tone should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "track should appear in tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneBassDb", 0.0)), 3.5, 0.0001,
                        "bass should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneMidDb", 0.0)), -2.0, 0.0001,
                        "mid should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneTrebleDb", 0.0)), 6.0, 0.0001,
                        "treble should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("toneFilter", 0.0)), -0.5, 0.0001,
                        "filter should round-trip through tracksAsJson");
        }

        // Reset to defaults: the snapshot must drop the fields again.
        require(state.setTrackTone("t-tone", 0.0F, 0.0F, 0.0F, 0.0F),
                "reset to default should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-tone");
            require(json.isObject(), "track should still appear in tracksAsJson");
            require(!json.hasProperty("toneBassDb"), "reset bass must be omitted");
            require(!json.hasProperty("toneMidDb"), "reset mid must be omitted");
            require(!json.hasProperty("toneTrebleDb"), "reset treble must be omitted");
            require(!json.hasProperty("toneFilter"), "reset filter must be omitted");
        }
}

void testProjectStateLevelerJsonRoundTrip()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-lev"), "addTrack should succeed");

        const auto findTrackJson = [](const juce::var& tracks,
                                      const juce::String& id) -> juce::var {
            if (auto* arr = tracks.getArray())
            {
                for (const auto& tv : *arr)
                {
                    if (tv.getProperty("id", {}).toString() == id) return tv;
                }
            }
            return {};
        };

        // Fresh track: the Leveler is at its default (0) and must be absent
        // from the snapshot so saved files / acks stay tidy.
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-lev");
            require(json.isObject(), "fresh track should appear in tracksAsJson");
            require(!json.hasProperty("levelerAmount"), "default leveler amount must be omitted");
        }

        // A non-default amount must round-trip through the snapshot the
        // renderer reads on PROJECT_STATE.
        require(state.setTrackLevelerAmount("t-lev", 0.6F),
                "non-default leveler amount should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-lev");
            require(json.isObject(), "track should appear in tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("levelerAmount", 0.0)), 0.6, 0.0001,
                        "leveler amount should round-trip through tracksAsJson");
        }

        // Reset to default: the snapshot must drop the field again.
        require(state.setTrackLevelerAmount("t-lev", 0.0F),
                "reset to default should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-lev");
            require(json.isObject(), "track should still appear in tracksAsJson");
            require(!json.hasProperty("levelerAmount"), "reset leveler amount must be omitted");
        }
}

void testProjectStateSendsJsonRoundTrip()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-snd"), "addTrack should succeed");

        const auto findTrackJson = [](const juce::var& tracks,
                                      const juce::String& id) -> juce::var {
            if (auto* arr = tracks.getArray())
            {
                for (const auto& tv : *arr)
                {
                    if (tv.getProperty("id", {}).toString() == id) return tv;
                }
            }
            return {};
        };

        // Fresh track: send amounts are at their defaults and must be
        // absent from the snapshot so reload / saved files stay tidy.
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-snd");
            require(json.isObject(), "fresh track should appear in tracksAsJson");
            require(!json.hasProperty("sendReverb"), "default sendReverb must be omitted");
            require(!json.hasProperty("sendDelay"), "default sendDelay must be omitted");
        }

        // Set non-default sends and confirm they round-trip through the
        // snapshot the renderer reads on PROJECT_STATE (so the Sends
        // sliders restore after a reload).
        require(state.setTrackSends("t-snd", 0.4F, 0.7F),
                "non-default sends should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-snd");
            require(json.isObject(), "track should appear in tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("sendReverb", 0.0)), 0.4, 0.0001,
                        "sendReverb should round-trip through tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("sendDelay", 0.0)), 0.7, 0.0001,
                        "sendDelay should round-trip through tracksAsJson");
        }

        // Reset to defaults: the snapshot must drop the fields again.
        require(state.setTrackSends("t-snd", 0.0F, 0.0F),
                "reset to default should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-snd");
            require(json.isObject(), "track should still appear in tracksAsJson");
            require(!json.hasProperty("sendReverb"), "reset sendReverb must be omitted");
            require(!json.hasProperty("sendDelay"), "reset sendDelay must be omitted");
        }
}

void testProjectStatePanJsonRoundTrip()
{
        silverdaw::ProjectState state;
        require(state.addTrack("t-pan"), "addTrack should succeed");

        const auto findTrackJson = [](const juce::var& tracks,
                                      const juce::String& id) -> juce::var {
            if (auto* arr = tracks.getArray())
            {
                for (const auto& tv : *arr)
                {
                    if (tv.getProperty("id", {}).toString() == id) return tv;
                }
            }
            return {};
        };

        // Fresh track: pan is centred (default) and must be absent from the
        // snapshot so reload / saved files stay byte-clean.
        require(!state.setTrackPan("t-pan", 0.0F),
                "setTrackPan 0 on a fresh track should be a no-op");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-pan");
            require(json.isObject(), "fresh track should appear in tracksAsJson");
            require(!json.hasProperty("pan"), "default (centre) pan must be omitted");
        }

        // Set an off-centre pan and confirm it round-trips through the
        // snapshot the renderer reads on PROJECT_STATE (so the Pan slider
        // restores after a project reload — the bug that bit the envelope).
        require(state.setTrackPan("t-pan", -0.5F), "off-centre pan should report changed");
        requireNear(state.getTrackPan("t-pan"), -0.5, 0.0001, "pan round-trip");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-pan");
            require(json.isObject(), "track should appear in tracksAsJson");
            requireNear(static_cast<double>(json.getProperty("pan", 0.0)), -0.5, 0.0001,
                        "pan should round-trip through tracksAsJson");
        }

        // Out-of-range requests clamp to the signed unit range.
        require(state.setTrackPan("t-pan", 5.0F), "over-range pan should report changed");
        requireNear(state.getTrackPan("t-pan"), 1.0, 0.0001, "pan should clamp to +1.0");

        // Reset to centre: the snapshot must drop the field again.
        require(state.setTrackPan("t-pan", 0.0F), "reset to centre should report changed");
        {
            const auto json = findTrackJson(state.tracksAsJson(), "t-pan");
            require(json.isObject(), "track should still appear in tracksAsJson");
            require(!json.hasProperty("pan"), "reset pan must be omitted");
        }

        require(!state.setTrackPan("missing", 0.5F),
                "setTrackPan should reject unknown trackId");
}

} // namespace

void addProjectStateFxTests(std::vector<TestCase>& tests)
{
    tests.push_back({"ProjectState per-track sends round-trip + default suppression", testProjectStateTrackSendsRoundTrip});
    tests.push_back({"ProjectState clip envelope sort / dedupe / clear", testProjectStateClipEnvelopeNormalisation});
    tests.push_back({"ProjectState project delay noteValue guard", testProjectStateDelayNoteValueGuard});
    tests.push_back({"ProjectState safety limiter defaults and legacy round-trip", testProjectStateSafetyLimiterDefaultsAndRoundTrip});
    tests.push_back({"ProjectState per-track tone round-trips through tracksAsJson", testProjectStateTrackToneJsonRoundTrip});
    tests.push_back({"ProjectState per-track leveler round-trips through tracksAsJson", testProjectStateLevelerJsonRoundTrip});
    tests.push_back({"ProjectState per-track sends round-trip through tracksAsJson", testProjectStateSendsJsonRoundTrip});
    tests.push_back({"ProjectState per-track pan round-trips through tracksAsJson", testProjectStatePanJsonRoundTrip});
}

} // namespace silverdaw::tests
