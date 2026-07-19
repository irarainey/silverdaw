#include "BeatRepeatCommands.h"

#include "AudioEngine.h"
#include "BridgeServer.h"
#include "PayloadHelpers.h"
#include "ProjectSession.h"
#include "ProjectState.h"

#include <cmath>

namespace silverdaw
{

bool applyBeatRepeatAdd(const juce::var& payload, ProjectState& projectState)
{
    const auto trackId = bridge::tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const auto startBeat = bridge::tryGetNumber(payload, "startBeat");
    const auto lengthBeats = bridge::tryGetNumber(payload, "lengthBeats");
    const auto division = bridge::tryGetString(payload, "division").value_or("1/8");
    if (trackId.isEmpty() || !startBeat.has_value() || !lengthBeats.has_value()
        || !std::isfinite(*startBeat) || !std::isfinite(*lengthBeats))
        return false;
    return projectState.addBeatRepeatRegion(trackId, juce::Uuid().toDashedString(),
                                            *startBeat, *lengthBeats, division);
}

bool applyBeatRepeatDelete(const juce::var& payload, ProjectState& projectState)
{
    const auto trackId = bridge::tryGetRequiredString(payload, "trackId").value_or(juce::String{});
    const auto regionId = bridge::tryGetRequiredString(payload, "regionId").value_or(juce::String{});
    return !trackId.isEmpty() && !regionId.isEmpty()
        && projectState.removeBeatRepeatRegion(trackId, regionId);
}

void syncBeatRepeatRegions(AudioEngine& engine, const ProjectState& projectState)
{
    const auto& root = projectState.getTree();
    juce::StringArray trackIds;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto track = root.getChild(i);
        if (!track.hasType(juce::Identifier{"TRACK"})) continue;
        const auto trackId = track.getProperty("id").toString();
        trackIds.add(trackId);
        engine.setTrackBeatRepeatRegions(trackId, projectState.getBeatRepeatRegions(trackId),
                                         projectState.getBpm());
    }
    engine.retainBeatRepeatRegionsForTracks(trackIds);
}

void finishBeatRepeatEdit(AudioEngine& engine, ProjectState& projectState,
                          BridgeServer& bridge, ProjectSession& session)
{
    syncBeatRepeatRegions(engine, projectState);
    bridge.broadcast("PROJECT_STATE", buildProjectStateEnvelope(session, projectState, false));
}

} // namespace silverdaw
