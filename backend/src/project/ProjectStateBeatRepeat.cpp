#include "ProjectState.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{
const juce::Identifier kBeatRepeat{"BEAT_REPEAT"};
const juce::Identifier kStartBeat{"startBeat"};
const juce::Identifier kLengthBeats{"lengthBeats"};
const juce::Identifier kDivision{"division"};

bool isDivisionValid(const juce::String& division)
{
    return division == "1/4" || division == "1/8" || division == "1/16";
}
} // namespace

bool ProjectState::addBeatRepeatRegion(const juce::String& trackId, const juce::String& regionId,
                                       double startBeat, double lengthBeats,
                                       const juce::String& division)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || regionId.isEmpty() || !std::isfinite(startBeat) || startBeat < 0.0
        || !std::isfinite(lengthBeats) || !isDivisionValid(division))
        return false;

    const double length = juce::jlimit(0.25, 16.0, lengthBeats);
    const double endBeat = startBeat + length;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto child = track.getChild(i);
        if (!child.hasType(kBeatRepeat)) continue;
        if (child.getProperty(kId).toString() == regionId) return false;
        const double existingStart = static_cast<double>(child.getProperty(kStartBeat, -1.0));
        const double existingLength = static_cast<double>(child.getProperty(kLengthBeats, 0.0));
        if (!std::isfinite(existingStart) || !std::isfinite(existingLength) || existingStart < 0.0
            || existingLength <= 0.0)
            continue;
        const double existingEnd = existingStart + existingLength;
        if (startBeat < existingEnd && endBeat > existingStart)
            return false;
    }

    juce::ValueTree region(kBeatRepeat);
    region.setProperty(kId, regionId, &undoManager);
    region.setProperty(kStartBeat, startBeat, &undoManager);
    region.setProperty(kLengthBeats, length, &undoManager);
    region.setProperty(kDivision, division, &undoManager);
    track.appendChild(region, &undoManager);
    return true;
}

bool ProjectState::removeBeatRepeatRegion(const juce::String& trackId, const juce::String& regionId)
{
    auto track = findTrack(trackId);
    if (!track.isValid() || regionId.isEmpty()) return false;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto region = track.getChild(i);
        if (region.hasType(kBeatRepeat) && region.getProperty(kId).toString() == regionId)
        {
            track.removeChild(i, &undoManager);
            return true;
        }
    }
    return false;
}

std::vector<BeatRepeatRegion> ProjectState::getBeatRepeatRegions(const juce::String& trackId) const
{
    std::vector<BeatRepeatRegion> regions;
    const auto track = findTrack(trackId);
    if (!track.isValid()) return regions;
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto child = track.getChild(i);
        if (!child.hasType(kBeatRepeat)) continue;
        BeatRepeatRegion region;
        region.id = child.getProperty(kId).toString();
        region.startBeat = static_cast<double>(child.getProperty(kStartBeat, -1.0));
        region.lengthBeats = static_cast<double>(child.getProperty(kLengthBeats, 0.0));
        region.division = child.getProperty(kDivision, "1/8").toString();
        if (!region.id.isEmpty() && std::isfinite(region.startBeat) && region.startBeat >= 0.0
            && std::isfinite(region.lengthBeats) && region.lengthBeats >= 0.25
            && region.lengthBeats <= 16.0 && isDivisionValid(region.division))
            regions.push_back(std::move(region));
    }
    std::sort(regions.begin(), regions.end(),
              [](const BeatRepeatRegion& a, const BeatRepeatRegion& b) {
                  return a.startBeat < b.startBeat;
              });
    std::vector<BeatRepeatRegion> nonOverlapping;
    nonOverlapping.reserve(regions.size());
    double previousEnd = -1.0;
    for (auto& region : regions)
    {
        if (region.startBeat < previousEnd) continue;
        previousEnd = region.startBeat + region.lengthBeats;
        nonOverlapping.push_back(std::move(region));
    }
    return nonOverlapping;
}

} // namespace silverdaw
