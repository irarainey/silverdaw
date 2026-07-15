#include "AudioEngine.h"

#include "Log.h"
#include "ProjectState.h"
#include "scratch/ScratchPatternEvaluator.h"

namespace silverdaw
{

bool AudioEngine::startScratchPatternReplay(const scratch::Pattern& pattern)
{
    if (!scratchController.hasActiveSession())
    {
        silverdaw::log::warn("scratch-replay", "no active scratch session for pattern replay");
        return false;
    }

    if (!scratchSource.isActive())
    {
        silverdaw::log::warn("scratch-replay", "scratch source not active");
        return false;
    }

    // Build the replay snapshot and start replay playback.
    auto snapshot = scratch::ScratchPatternEvaluator::buildSnapshot(pattern);
    if (snapshot.empty())
    {
        silverdaw::log::warn("scratch-replay", "empty pattern snapshot");
        return false;
    }

    // Pattern replay is driven directly by the scratch source over the loaded
    // scratch clip. A take is recorded with the backing bed running from its
    // head, so when a bed is prepared, replay starts it in time with the
    // notation (ADR 0021, Amendment 17, superseding Amendment 15). With no bed
    // prepared, replay still plays scratch-only and never touches the transport.
    scratchSource.endPatternReplay();
    patternReplaySnapshot = std::make_shared<const scratch::PatternReplaySnapshot>(std::move(snapshot));
    scratchSource.beginPatternReplay(patternReplaySnapshot.get());
    scratchController.beginReplayBacking();
    patternReplayActive.store(true, std::memory_order_release);
    patternReplayPositionUs.store(0, std::memory_order_release);

    silverdaw::log::info("scratch-replay", "pattern replay started");
    return true;
}

void AudioEngine::stopScratchPatternReplay()
{
    patternReplayActive.store(false, std::memory_order_release);
    scratchSource.endPatternReplay();
    scratchController.endReplayBacking();
    patternReplaySnapshot = nullptr;
    patternReplayPositionUs.store(0, std::memory_order_release);
    // Replay only ran the backing bed for the audition; stop and rewind it.
    silverdaw::log::info("scratch-replay", "pattern replay stopped");
}

bool AudioEngine::isScratchPatternReplaying() const noexcept
{
    return patternReplayActive.load(std::memory_order_acquire);
}

void AudioEngine::rebuildClipPatternSnapshot(const juce::String& clipId,
                                             const ProjectState& projectState)
{
    const auto patternId = projectState.getClipScratchPatternId(clipId);
    if (patternId.isEmpty())
    {
        clearClipPatternSnapshot(clipId);
        return;
    }

    // Retrieve the pattern from project state.
    const auto patternsJson = projectState.scratchPatternsAsJson();
    const auto* arr = patternsJson.getArray();
    if (arr == nullptr)
    {
        clearClipPatternSnapshot(clipId);
        return;
    }

    std::optional<scratch::Pattern> foundPattern;
    for (const auto& item : *arr)
    {
        if (item.getProperty("id", {}).toString() == patternId)
        {
            foundPattern = scratch::parsePattern(item);
            break;
        }
    }

    if (!foundPattern)
    {
        // Referenced pattern missing — clear gracefully per project conventions.
        silverdaw::log::warn("scratch-replay",
            "clip " + clipId + " references missing pattern " + patternId + ", clearing");
        clearClipPatternSnapshot(clipId);
        return;
    }

    auto snapshot = std::make_shared<const scratch::PatternReplaySnapshot>(
        scratch::ScratchPatternEvaluator::buildSnapshot(*foundPattern));

    auto it = tracks.find(clipId);
    if (it != tracks.end() && it->second != nullptr)
    {
        it->second->patternSnapshot = std::move(snapshot);
        if (it->second->offsetSource != nullptr)
        {
            it->second->offsetSource->setPatternSnapshot(it->second->patternSnapshot.get());
        }
    }
}

void AudioEngine::clearClipPatternSnapshot(const juce::String& clipId)
{
    auto it = tracks.find(clipId);
    if (it != tracks.end() && it->second != nullptr)
    {
        it->second->patternSnapshot = nullptr;
        if (it->second->offsetSource != nullptr)
        {
            it->second->offsetSource->setPatternSnapshot(nullptr);
        }
    }
}

void AudioEngine::rebuildAllClipPatternSnapshots(const ProjectState& projectState)
{
    const auto allClipIds = projectState.getAllClipIds();
    for (const auto& clipId : allClipIds)
    {
        const auto patternId = projectState.getClipScratchPatternId(clipId);
        if (patternId.isNotEmpty())
        {
            rebuildClipPatternSnapshot(clipId, projectState);
        }
    }
}

} // namespace silverdaw
