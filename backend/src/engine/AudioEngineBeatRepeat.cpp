#include "AudioEngine.h"

namespace silverdaw
{
void AudioEngine::setTrackBeatRepeatRegions(const juce::String& trackId,
                                            const std::vector<BeatRepeatRegion>& regions,
                                            double bpm)
{
    if (trackId.isEmpty()) return;
    if (regions.empty())
    {
        clearTrackBeatRepeatRegions(trackId);
        return;
    }

    beatRepeatDefinitions[trackId] = {regions, bpm};
    const double rate = master.getSampleRate() > 0.0 ? master.getSampleRate() : 44100.0;
    auto next = makeBeatRepeatSnapshot(regions, rate, bpm);

    busGraph.setTrackBeatRepeatPtr(trackId, next.get());
    auto existing = beatRepeatCurrent.find(trackId);
    if (existing != beatRepeatCurrent.end())
    {
        retiredBeatRepeats.push_back(std::move(existing->second));
        existing->second = std::move(next);
    }
    else
    {
        beatRepeatCurrent.emplace(trackId, std::move(next));
    }
}

void AudioEngine::clearTrackBeatRepeatRegions(const juce::String& trackId)
{
    if (trackId.isEmpty()) return;
    busGraph.setTrackBeatRepeatPtr(trackId, nullptr);
    beatRepeatDefinitions.erase(trackId);
    auto existing = beatRepeatCurrent.find(trackId);
    if (existing != beatRepeatCurrent.end())
    {
        retiredBeatRepeats.push_back(std::move(existing->second));
        beatRepeatCurrent.erase(existing);
    }
}

void AudioEngine::retainBeatRepeatRegionsForTracks(const juce::StringArray& trackIds)
{
    std::vector<juce::String> removed;
    for (const auto& [trackId, snapshot] : beatRepeatCurrent)
        if (!trackIds.contains(trackId)) removed.push_back(trackId);
    for (const auto& trackId : removed)
        clearTrackBeatRepeatRegions(trackId);
}

void AudioEngine::rebuildBeatRepeatSnapshotsForCurrentSampleRate()
{
    const double rate = master.getSampleRate() > 0.0 ? master.getSampleRate() : 44100.0;
    for (const auto& [trackId, definition] : beatRepeatDefinitions)
    {
        auto next = makeBeatRepeatSnapshot(definition.regions, rate, definition.bpm);
        busGraph.setTrackBeatRepeatPtr(trackId, next.get());
        auto existing = beatRepeatCurrent.find(trackId);
        if (existing != beatRepeatCurrent.end())
        {
            retiredBeatRepeats.push_back(std::move(existing->second));
            existing->second = std::move(next);
        }
        else
        {
            beatRepeatCurrent.emplace(trackId, std::move(next));
        }
    }
}

} // namespace silverdaw
