#include "ClipCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "CommandHelpers.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;
using silverdaw::bridge::tryGetRequiredString;

void handleClipMove(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    const auto positionMs = tryGetNumber(payload, "positionMs");
    if (positionMs.has_value())
    {
        engine.setClipOffsetMs(clipId, *positionMs);
        projectState.setClipOffsetMs(clipId, *positionMs);
    }
    if (static_cast<bool>(payload.getProperty("commit", false)))
    {
        engine.commitClipOffset(clipId);
    }
    // Optional cross-track re-parent. Each clip is its own playable source,
    // so the move updates ProjectState and reapplies the destination track's
    // effective gain to keep mute / solo audibility correct.
    const juce::String newTrackId = tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    if (newTrackId.isNotEmpty())
    {
        if (projectState.setClipTrack(clipId, newTrackId))
        {
            engine.setClipGain(clipId, projectState.getEffectiveTrackGain(newTrackId));
        }
    }
}

void handleClipTrim(const juce::var& payload, silverdaw::AudioEngine& engine, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    const auto startMs = tryGetNumber(payload, "startMs");
    const auto inMs = tryGetNumber(payload, "inMs");
    const auto durationMs = tryGetNumber(payload, "durationMs");
    if (!startMs.has_value() || !inMs.has_value() || !durationMs.has_value())
    {
        return;
    }
    engine.setClipTrim(clipId, *startMs, *inMs, *durationMs);
    projectState.setClipTrim(clipId, *startMs, *inMs, *durationMs);
}

void handleClipColor(const juce::var& payload, silverdaw::ProjectState& projectState)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // colorIndex omitted or negative = clear the per-clip override.
    const juce::var idxVar = payload.getProperty("colorIndex", juce::var());
    const int colorIndex =
        (idxVar.isInt() || idxVar.isInt64()) ? static_cast<int>(idxVar) : -1;
    projectState.setClipColorIndex(clipId, colorIndex);
}

void handleClipRemove(const juce::var& payload, silverdaw::AudioEngine& engine,
                      silverdaw::ProjectState& projectState, silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty())
    {
        return;
    }
    // Drop the engine's audio source first so the next audio callback
    // doesn't try to pull from a source that's about to leave the
    // project tree. `removeClip` is idempotent so calling it for a
    // clip the engine never had is harmless.
    engine.removeClip(clipId);
    const bool existed = projectState.removeClip(clipId);
    auto* p = new juce::DynamicObject();
    p->setProperty("clipId", clipId);
    p->setProperty("ok", existed);
    bridge.broadcast("CLIP_REMOVED", juce::var(p));
}

// Phase 5 — per-clip volume envelope. `points` is a `juce::var` array
// of `{ timeMs, gain }` objects. An empty array clears the envelope
// entirely.
void handleClipSetEnvelope(const juce::var& payload, silverdaw::AudioEngine& engine,
                           silverdaw::ProjectState& projectState,
                           silverdaw::BridgeServer& bridge)
{
    const juce::String clipId = tryGetRequiredString(payload, "clipId").value_or(juce::String{});
    if (clipId.isEmpty()) return;

    juce::Array<juce::var> points;
    const auto& pointsVar = payload.getProperty("points", juce::var());
    if (pointsVar.isArray())
    {
        points = *pointsVar.getArray();
    }

    const bool changed = projectState.setClipEnvelope(clipId, points);
    if (!changed) return;

    // Push the normalised, persisted shape onto the audio engine so the
    // change is audible on the next block, then ack with the stored form.
    const auto stored = projectState.getClipEnvelope(clipId);
    engine.setClipEnvelope(clipId, stored);

    broadcastApplied(bridge, "CLIP_ENVELOPE_APPLIED",
                     {{"clipId", clipId}, {"points", juce::var(stored)}});
}

} // namespace silverdaw