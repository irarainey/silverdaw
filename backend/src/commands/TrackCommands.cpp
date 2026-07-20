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
// Centralised so gain, mute, and solo share one effective-gain fan-out.
float applyEffectiveClipGains(const juce::String& trackId,
                              silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState)
{
    const float effective = projectState.getEffectiveTrackGain(trackId);
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.setClipGain(clipId, effective);
    }
    return effective;
}

void applyEffectiveTrackState(const juce::String& trackId,
                              silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState)
{
    const float effective =
        applyEffectiveClipGains(trackId, engine, projectState);
    engine.setTrackAudible(trackId, effective > 0.0F);
}

// Solo state changes audibility of every track.
void pushAllEffectiveGainsToEngine(silverdaw::AudioEngine& engine,
                                   silverdaw::ProjectState& projectState)
{
    const auto& tree = projectState.getTree();
    std::vector<std::pair<juce::String, bool>> audibility;
    audibility.reserve(static_cast<std::size_t>(tree.getNumChildren()));
    for (int i = 0; i < tree.getNumChildren(); ++i)
    {
        const auto track = tree.getChild(i);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        const auto trackId =
            track.getProperty(juce::Identifier{"id"}).toString();
        const float effective =
            applyEffectiveClipGains(trackId, engine, projectState);
        audibility.emplace_back(trackId, effective > 0.0F);
    }
    engine.setTracksAudible(audibility);
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
    const juce::var idxVar = payload.getProperty("colorIndex", juce::var());
    const int colorIndex = (idxVar.isInt() || idxVar.isInt64()) ? static_cast<int>(idxVar) : -1;
    const bool ok = projectState.addTrack(trackId, colorIndex);
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
    // Remove audio sources before ProjectState loses this track's clip ids.
    const auto clipIds = projectState.getTrackClipIds(trackId);
    for (const auto& clipId : clipIds)
    {
        engine.removeClip(clipId);
    }
    engine.clearTrackBeatRepeatRegions(trackId);
    projectState.removeTrack(trackId);
    engine.retireTrackFxState(trackId);
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
    // Track gain stores user volume; backend derives mute/solo effective gain.
    const bool stored = projectState.setTrackGain(trackId, gainF);
    applyEffectiveTrackState(trackId, engine, projectState);
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
    applyEffectiveTrackState(trackId, engine, projectState);
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
    // Solo affects every track's audibility.
    pushAllEffectiveGainsToEngine(engine, projectState);
    broadcastApplied(bridge, "TRACK_SOLO_APPLIED",
                     {{"trackId", trackId}, {"soloed", soloed}}, stored);
}

// Skip no-op sends during 60 Hz drags to avoid undo and wire churn.
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

// Skip no-op pan updates during 60 Hz drags.
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

// Ack uses canonical re-read so renderer and engine reconcile to persisted tone.
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
    const float filter = static_cast<float>(
        readOptionalNumber(payload, "filter").value_or(projectState.getTrackToneFilter(trackId)));

    const bool changed = projectState.setTrackTone(trackId, bassDb, midDb, trebleDb, filter);
    if (!changed) return;

    // Re-read canonical values so renderer and engine match persisted truth.
    const float canonBass = projectState.getTrackToneBassDb(trackId);
    const float canonMid = projectState.getTrackToneMidDb(trackId);
    const float canonTreble = projectState.getTrackToneTrebleDb(trackId);
    const float canonFilter = projectState.getTrackToneFilter(trackId);

    // Live UI gesture → glide (snap=false) to avoid zipper noise.
    engine.setTrackTone(trackId, canonBass, canonMid, canonTreble, canonFilter, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_TONE_APPLIED",
                     {{"trackId", trackId},
                      {"bassDb", canonBass},
                      {"midDb", canonMid},
                      {"trebleDb", canonTreble},
                      {"filter", canonFilter}});
}

// Leveler exposes one curated amount knob; raw compressor controls stay hidden.
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

    // Re-read canonical value so renderer and engine match persisted truth.
    const float canonAmount = projectState.getTrackLevelerAmount(trackId);

    // Live UI gesture → glide (snap=false) to avoid zipper noise.
    engine.setTrackLeveler(trackId, canonAmount, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_LEVELER_APPLIED",
                     {{"trackId", trackId}, {"amount", canonAmount}});
}

void handleTrackSetPunch(const juce::var& payload, silverdaw::AudioEngine& engine,
                         silverdaw::ProjectState& projectState,
                         silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const auto amountVar = tryGetNumber(payload, "amount");
    if (!amountVar.has_value()) return;

    const float amount = juce::jlimit(0.0F, 1.0F, static_cast<float>(*amountVar));
    if (!projectState.setTrackPunchAmount(trackId, amount)) return;

    const float canonAmount = projectState.getTrackPunchAmount(trackId);
    engine.setTrackPunch(trackId, canonAmount, /*snap*/ false);
    broadcastApplied(bridge, "TRACK_PUNCH_APPLIED",
                     {{"trackId", trackId}, {"amount", canonAmount}});
}

void handleTrackSetSaturation(const juce::var& payload, silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState,
                              silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;

    const float drive = static_cast<float>(
        readOptionalNumber(payload, "drive").value_or(projectState.getTrackSaturationDrive(trackId)));
    const float mix = static_cast<float>(
        readOptionalNumber(payload, "mix").value_or(projectState.getTrackSaturationMix(trackId)));

    if (!projectState.setTrackSaturation(trackId, drive, mix)) return;

    const float canonDrive = projectState.getTrackSaturationDrive(trackId);
    const float canonMix = projectState.getTrackSaturationMix(trackId);
    engine.setTrackSaturation(trackId, canonDrive, canonMix, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_SATURATION_APPLIED",
                     {{"trackId", trackId}, {"drive", canonDrive}, {"mix", canonMix}});
}

void handleTrackSetBitCrusher(const juce::var& payload, silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState,
                              silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;

    const float rate = static_cast<float>(
        readOptionalNumber(payload, "rate").value_or(projectState.getTrackBitCrusherRate(trackId)));
    const double requestedBits =
        readOptionalNumber(payload, "bits").value_or(projectState.getTrackBitCrusherBits(trackId));
    const float clampedBits = juce::jlimit(
        1.0F, 16.0F,
        std::isfinite(requestedBits) ? static_cast<float>(requestedBits) : 16.0F);
    const int bits = static_cast<int>(std::lround(clampedBits));
    const float boost = static_cast<float>(
        readOptionalNumber(payload, "boost").value_or(projectState.getTrackBitCrusherBoost(trackId)));
    const float mix = static_cast<float>(
        readOptionalNumber(payload, "mix").value_or(projectState.getTrackBitCrusherMix(trackId)));

    if (!projectState.setTrackBitCrusher(trackId, rate, bits, boost, mix)) return;

    const float canonRate = projectState.getTrackBitCrusherRate(trackId);
    const int canonBits = projectState.getTrackBitCrusherBits(trackId);
    const float canonBoost = projectState.getTrackBitCrusherBoost(trackId);
    const float canonMix = projectState.getTrackBitCrusherMix(trackId);
    engine.setTrackBitCrusher(trackId, canonRate, canonBits, canonBoost, canonMix, /*snap*/ false);

    broadcastApplied(bridge, "TRACK_BIT_CRUSHER_APPLIED",
                     {{"trackId", trackId},
                      {"rate", canonRate},
                      {"bits", canonBits},
                      {"boost", canonBoost},
                      {"mix", canonMix}});
}

// Per-track effect automation curve for one parameter. Stores/normalises the
// curve, acks with the persisted points, and (P1b) publishes it to the engine.
void handleTrackSetAutomation(const juce::var& payload, silverdaw::AudioEngine& engine,
                              silverdaw::ProjectState& projectState,
                              silverdaw::BridgeServer& bridge)
{
    const juce::String trackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (trackId.isEmpty()) return;
    const juce::String paramId = tryGetRequiredString(payload, "paramId").value_or(juce::String{});
    if (paramId.isEmpty()) return;

    juce::Array<juce::var> points;
    const auto& pointsVar = payload.getProperty("points", juce::var());
    if (pointsVar.isArray())
    {
        points = *pointsVar.getArray();
    }

    const bool changed = projectState.setTrackAutomation(trackId, paramId, points);
    if (!changed) return;

    // Ack with the normalised persisted shape the engine receives.
    const auto stored = projectState.getTrackAutomation(trackId, paramId);
    engine.setTrackAutomation(trackId, paramId, stored);

    broadcastApplied(bridge, "TRACK_AUTOMATION_APPLIED",
                     {{"trackId", trackId}, {"paramId", paramId}, {"points", juce::var(stored)}});
}

} // namespace silverdaw
