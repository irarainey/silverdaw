#include "TrackCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "CommandHelpers.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::readOptionalBool;
using silverdaw::bridge::readOptionalNumber;
using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

namespace
{
/** Push the effective audible gain (= user volume × mute × solo
 *  logic) to AudioEngine for every clip on `trackId`. Centralised so
 *  the TRACK_GAIN / TRACK_MUTE / TRACK_SOLO handlers can share the
 *  same fan-out. */
void pushEffectiveTrackGainToEngine(const juce::String& trackId,
                                    silverdaw::AudioEngine& engine,
                                    silverdaw::ProjectState& projectState)
{
    const float effective = projectState.getEffectiveTrackGain(trackId);
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.setClipGain(clipId, effective);
    }
}

/** Re-push every track's effective gain. Called after a TRACK_SOLO
 *  toggle because solo state changes audibility of every other
 *  track too. */
void pushAllEffectiveGainsToEngine(silverdaw::AudioEngine& engine,
                                   silverdaw::ProjectState& projectState)
{
    const auto& tree = projectState.getTree();
    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        const auto track = tree.getChild(i);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        pushEffectiveTrackGainToEngine(track.getProperty(juce::Identifier{"id"}).toString(),
                                       engine, projectState);
    }
}
} // namespace

void handleTrackAdd(const juce::var& payload, silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty())
    {
        return;
    }
    const bool existed = projectState.hasTrack(trackId);
    const bool ok = projectState.addTrack(trackId);
    const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
    if (ok && !existed && name.trim().isNotEmpty())
    {
        projectState.setTrackName(trackId, name);
    }
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", ok);
    bridge.broadcast("TRACK_ADDED", juce::var(p));
}

void handleTrackRemove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                       silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty())
    {
        return;
    }
    const bool existed = projectState.hasTrack(trackId);
    // Tear down every audio source on this track BEFORE dropping the
    // track from ProjectState — otherwise the lookup loses the clip ids.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.removeClip(clipId);
    }
    projectState.removeTrack(trackId);
    auto* p = new juce::DynamicObject();
    p->setProperty("trackId", trackId);
    p->setProperty("ok", existed);
    bridge.broadcast("TRACK_REMOVED", juce::var(p));
}

void handleTrackRename(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const juce::String name = tryGetRequiredString(payload, "name").value_or(juce::String{});
    if (trackId.isEmpty() || name.trim().isEmpty())
    {
        return;
    }
    projectState.setTrackName(trackId, name);
}

void handleTrackGain(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState,
                     silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty())
    {
        return;
    }
    const auto gain = tryGetNumber(payload, "gain");
    if (!gain.has_value())
    {
        return;
    }
    const auto gainF = static_cast<float>(*gain);
    // TRACK_GAIN now carries the USER VOLUME (slider position), NOT
    // the post-mute/solo effective gain. The backend derives the
    // effective audible gain from the stored volume + muted + soloed
    // flags and pushes that to the AudioEngine.
    const bool stored = projectState.setTrackGain(trackId, gainF);
    pushEffectiveTrackGainToEngine(trackId, engine, projectState);
    broadcastApplied(bridge, "TRACK_GAIN_APPLIED",
                     {{"trackId", trackId}, {"gain", gainF}}, stored);
}

void handleTrackMute(const juce::var& payload, silverdaw::AudioEngine& engine,
                     silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const bool muted = static_cast<bool>(payload.getProperty("muted", false));
    const bool stored = projectState.setTrackMuted(trackId, muted);
    pushEffectiveTrackGainToEngine(trackId, engine, projectState);
    broadcastApplied(bridge, "TRACK_MUTE_APPLIED",
                     {{"trackId", trackId}, {"muted", muted}}, stored);
}

void handleTrackSolo(const juce::var& payload, silverdaw::AudioEngine& engine,
                     silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const bool soloed = static_cast<bool>(payload.getProperty("soloed", false));
    const bool stored = projectState.setTrackSoloed(trackId, soloed);
    // Solo affects audibility of every other track — fan out across
    // the whole project.
    pushAllEffectiveGainsToEngine(engine, projectState);
    broadcastApplied(bridge, "TRACK_SOLO_APPLIED",
                     {{"trackId", trackId}, {"soloed", soloed}}, stored);
}

// Persist + push per-track Reverb/Delay sends. Skips ack/dirty/undo when the
// setter reports no change so a 60 Hz drag landing on the same value can't
// pollute undo history or fire redundant wire traffic.
void handleTrackSetSends(const juce::var& payload, silverdaw::AudioEngine& engine,
                         silverdaw::ProjectState& projectState,
                         silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const auto reverbVar = tryGetNumber(payload, "reverbSend");
    const auto delayVar = tryGetNumber(payload, "delaySend");
    if (!reverbVar.has_value() || !delayVar.has_value()) return;

    const auto reverbSend = juce::jlimit(0.0f, 1.0f, static_cast<float>(*reverbVar));
    const auto delaySend = juce::jlimit(0.0f, 1.0f, static_cast<float>(*delayVar));

    const bool changed = projectState.setTrackSends(trackId, reverbSend, delaySend);
    if (!changed) return;

    engine.setTrackSends(trackId, reverbSend, delaySend);

    broadcastApplied(bridge, "TRACK_SENDS_APPLIED",
                     {{"trackId", trackId}, {"reverbSend", reverbSend}, {"delaySend", delaySend}});
}

// Persist + push per-track equal-power pan (engine derives the per-channel
// gains). Skips ack/dirty/undo when unchanged — same 60 Hz-drag guard as Sends.
void handleTrackSetPan(const juce::var& payload, silverdaw::AudioEngine& engine,
                       silverdaw::ProjectState& projectState,
                       silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const auto panVar = tryGetNumber(payload, "pan");
    if (!panVar.has_value()) return;

    const auto pan = juce::jlimit(-1.0f, 1.0f, static_cast<float>(*panVar));

    const bool changed = projectState.setTrackPan(trackId, pan);
    if (!changed) return;

    engine.setTrackPan(trackId, pan);

    broadcastApplied(bridge, "TRACK_PAN_APPLIED",
                     {{"trackId", trackId}, {"pan", pan}});
}

// Persist + push per-track tone (3-band EQ + low/high cut). Partial-update:
// fields absent from the payload fall back to the stored value, and the ack
// carries the canonical re-read so renderer and engine reconcile to one truth.
void handleTrackSetTone(const juce::var& payload, silverdaw::AudioEngine& engine,
                        silverdaw::ProjectState& projectState,
                        silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;

    const float bassDb = static_cast<float>(
        readOptionalNumber(payload, "bassDb").value_or(projectState.getTrackToneBassDb(trackId)));
    const float midDb = static_cast<float>(
        readOptionalNumber(payload, "midDb").value_or(projectState.getTrackToneMidDb(trackId)));
    const float trebleDb = static_cast<float>(
        readOptionalNumber(payload, "trebleDb").value_or(projectState.getTrackToneTrebleDb(trackId)));
    const bool lowCut =
        readOptionalBool(payload, "lowCut").value_or(projectState.getTrackToneLowCut(trackId));
    const bool highCut =
        readOptionalBool(payload, "highCut").value_or(projectState.getTrackToneHighCut(trackId));

    const bool changed = projectState.setTrackTone(trackId, bassDb, midDb, trebleDb, lowCut, highCut);
    if (!changed) return;

    // Re-read the canonical (clamped / default-suppressed) values so the
    // engine and the renderer both reconcile to the persisted truth.
    const float canonBass = projectState.getTrackToneBassDb(trackId);
    const float canonMid = projectState.getTrackToneMidDb(trackId);
    const float canonTreble = projectState.getTrackToneTrebleDb(trackId);
    const bool canonLowCut = projectState.getTrackToneLowCut(trackId);
    const bool canonHighCut = projectState.getTrackToneHighCut(trackId);

    // Live UI gesture → glide (snap=false) to avoid zipper noise.
    engine.setTrackTone(trackId, canonBass, canonMid, canonTreble, canonLowCut,
                        canonHighCut, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_TONE_APPLIED",
                     {{"trackId", trackId},
                      {"bassDb", canonBass},
                      {"midDb", canonMid},
                      {"trebleDb", canonTreble},
                      {"lowCut", canonLowCut},
                      {"highCut", canonHighCut}});
}

// Persist + push the single user-facing "amount" knob (`[0, 1]`) driving the
// curated compressor in `Leveler.h`; raw threshold/ratio/attack/release deferred.
void handleTrackSetLeveler(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState,
                           silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const auto amountVar = tryGetNumber(payload, "amount");
    if (!amountVar.has_value()) return;

    const float amount = juce::jlimit(0.0f, 1.0f, static_cast<float>(*amountVar));
    const bool changed = projectState.setTrackLevelerAmount(trackId, amount);
    if (!changed) return;

    // Re-read the canonical (clamped / default-suppressed) value so the
    // engine and the renderer both reconcile to the persisted truth.
    const float canonAmount = projectState.getTrackLevelerAmount(trackId);

    // Live UI gesture → glide (snap=false) to avoid zipper noise.
    engine.setTrackLeveler(trackId, canonAmount, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_LEVELER_APPLIED",
                     {{"trackId", trackId}, {"amount", canonAmount}});
}

} // namespace silverdaw
