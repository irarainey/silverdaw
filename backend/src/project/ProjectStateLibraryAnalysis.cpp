#include "ProjectState.h"

#include <vector>

namespace silverdaw
{

bool ProjectState::setLibraryItemBpm(const juce::String& itemId, double bpm)
{
    return mutateDerivedLibraryItem(itemId,
                                    [bpm](juce::ValueTree& item)
                                    {
                                        if (bpm > 0.0)
                                            item.setProperty(kBpm, bpm, nullptr);
                                        else
                                            item.removeProperty(kBpm, nullptr);
                                    });
}

bool ProjectState::setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec)
{
    return mutateDerivedLibraryItem(itemId,
                                    [&beatTimesSec](juce::ValueTree& item)
                                    {
                                        if (beatTimesSec.empty())
                                        {
                                            item.removeProperty(kBeats, nullptr);
                                            return;
                                        }
                                        juce::Array<juce::var> arr;
                                        arr.ensureStorageAllocated(static_cast<int>(beatTimesSec.size()));
                                        for (double t : beatTimesSec) arr.add(juce::var(t));
                                        item.setProperty(kBeats, juce::var(arr), nullptr);
                                    });
}

bool ProjectState::setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec)
{
    return mutateDerivedLibraryItem(itemId,
                                    [anchorSec](juce::ValueTree& item)
                                    { item.setProperty(kBeatAnchorSec, anchorSec, nullptr); });
}

bool ProjectState::setLibraryItemManualTempo(const juce::String& itemId, double bpm,
                                             const std::vector<double>& beatTimesSec, double beatAnchorSec)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() != itemId) continue;

        // Undoable, dirtying user edit — written through the UndoManager, and
        // deliberately NOT routed through mutateDerivedLibraryItem (which suppresses
        // dirty and mirrors the clean snapshot for automatic, non-undoable analysis).
        if (bpm > 0.0)
            item.setProperty(kBpm, bpm, &undoManager);
        else
            item.removeProperty(kBpm, &undoManager);

        if (beatTimesSec.empty())
        {
            item.removeProperty(kBeats, &undoManager);
        }
        else
        {
            juce::Array<juce::var> arr;
            arr.ensureStorageAllocated(static_cast<int>(beatTimesSec.size()));
            for (double t : beatTimesSec) arr.add(juce::var(t));
            item.setProperty(kBeats, juce::var(arr), &undoManager);
        }

        item.setProperty(kBeatAnchorSec, beatAnchorSec, &undoManager);
        // A hand-set grid is a fixed, confident tempo.
        item.removeProperty(kVariableTempo, &undoManager);
        item.removeProperty(kLowConfidence, &undoManager);
        return true;
    }
    return false;
}

bool ProjectState::setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath)
{
    return mutateDerivedLibraryItem(itemId,
                                    [&playbackPath](juce::ValueTree& item)
                                    {
                                        if (playbackPath.isEmpty())
                                            item.removeProperty(kPlaybackFilePath, nullptr);
                                        else
                                            item.setProperty(kPlaybackFilePath, playbackPath, nullptr);
                                    });
}

juce::String ProjectState::getLibraryItemPlaybackPath(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            return item.getProperty(kPlaybackFilePath, {}).toString();
        }
    }
    return {};
}

bool ProjectState::setLibraryItemKey(const juce::String& itemId, const juce::String& key)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (key.isEmpty())
            {
                item.removeProperty(kKey, nullptr);
            }
            else
            {
                item.setProperty(kKey, key, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemWarp(const juce::String& itemId,
                                      std::optional<bool> warpEnabled,
                                      std::optional<juce::String> warpMode,
                                      std::optional<double> tempoRatio,
                                      bool tempoRatioClear,
                                      std::optional<double> semitones,
                                      std::optional<double> cents)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() != itemId) continue;
        // Warp defaults are only meaningful on clip items.
        if (item.getProperty(kKind).toString() != "clip") return false;
        if (warpEnabled.has_value())
            item.setProperty(kWarpEnabled, *warpEnabled, &undoManager);
        if (warpMode.has_value() && warpMode->isNotEmpty())
            item.setProperty(kWarpMode, *warpMode, &undoManager);
        if (tempoRatioClear)
            item.removeProperty(kTempoRatio, &undoManager);
        else if (tempoRatio.has_value())
            item.setProperty(kTempoRatio, juce::jlimit(0.25, 4.0, *tempoRatio), &undoManager);
        if (semitones.has_value())
            item.setProperty(kSemitones, juce::jlimit(-24.0, 24.0, *semitones), &undoManager);
        if (cents.has_value())
            item.setProperty(kCents, juce::jlimit(-100.0, 100.0, *cents), &undoManager);
        return true;
    }
    return false;
}

bool ProjectState::clearLibraryItemAnalysis(const juce::String& itemId)
{
    return mutateDerivedLibraryItem(itemId,
                                    [](juce::ValueTree& item)
                                    {
                                        item.removeProperty(kBpm, nullptr);
                                        item.removeProperty(kBeats, nullptr);
                                        item.removeProperty(kBeatAnchorSec, nullptr);
                                        item.removeProperty(kVariableTempo, nullptr);
                                    });
}

juce::String ProjectState::getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "source").toString() != "clip"
            && item.getProperty(kFilePath).toString() == sourceFilePath)
        {
            return item.getProperty(kPlaybackFilePath, {}).toString();
        }
    }
    return {};
}

bool ProjectState::setLibraryItemVariableTempo(const juce::String& itemId, bool variable)
{
    return mutateDerivedLibraryItem(itemId,
                                    [variable](juce::ValueTree& item)
                                    {
                                        if (variable)
                                            item.setProperty(kVariableTempo, true, nullptr);
                                        else
                                            item.removeProperty(kVariableTempo, nullptr);
                                    });
}

bool ProjectState::setLibraryItemLowConfidence(const juce::String& itemId, bool lowConfidence)
{
    return mutateDerivedLibraryItem(itemId,
                                    [lowConfidence](juce::ValueTree& item)
                                    {
                                        if (lowConfidence)
                                            item.setProperty(kLowConfidence, true, nullptr);
                                        else
                                            item.removeProperty(kLowConfidence, nullptr);
                                    });
}

bool ProjectState::setLibraryItemAudioType(const juce::String& itemId, const juce::String& audioType)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (audioType == "simple" || audioType == "music")
            {
                item.setProperty(kAudioType, audioType, nullptr);
            }
            else
            {
                item.removeProperty(kAudioType, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemCoverArtHidden(const juce::String& itemId, bool hidden)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            // Suppressed when off so the flag is absent from the saved file by default.
            if (hidden)
                item.setProperty(kCoverArtHidden, true, nullptr);
            else
                item.removeProperty(kCoverArtHidden, nullptr);
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemCoverArtOverride(const juce::String& itemId, const juce::String& coverFile)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (coverFile.isNotEmpty())
                item.setProperty(kCoverArtOverride, coverFile, nullptr);
            else
                item.removeProperty(kCoverArtOverride, nullptr);
            return true;
        }
    }
    return false;
}

double ProjectState::getLibraryItemDurationMs(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
            return static_cast<double>(item.getProperty(kDurationMs, 0.0));
    }
    return 0.0;
}

double ProjectState::getLibraryItemBpmForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "source").toString() != "clip"
            && item.getProperty(kFilePath).toString() == filePath)
        {
            return static_cast<double>(item.getProperty(kBpm, 0.0));
        }
    }
    return 0.0;
}

} // namespace silverdaw
