#include "ProjectState.h"

#include <vector>

namespace silverdaw
{

// A one-shot has no pulse, so it may not carry a tempo grid. Guarding every tempo
// writer here (rather than at each caller) means detection, reanalysis and grid
// inheritance all fail closed: a stale bpm would otherwise keep seeding the project
// tempo, warping on drop and inheriting into anything cut from the sample. Key and
// pitch are untouched — a one-shot can perfectly well be in a key.
bool ProjectState::isOneShotItem(const juce::ValueTree& item)
{
    return item.getProperty(kAudioType).toString() == "simple";
}

// The classification is inherited: an item that says nothing about itself is a
// one-shot when the item it was cut from is one. Mirrors the renderer's
// `libraryItemIsSimple` exactly, so both processes answer this the same way before
// either resolves a tempo (ADR 0024).
bool ProjectState::isOneShotItemInherited(const juce::ValueTree& item,
                                          const juce::ValueTree& library)
{
    const auto own = item.getProperty(kAudioType).toString();
    if (own == "simple") return true;
    if (own == "music") return false;
    const auto sourceItemId = item.getProperty(kSourceItemId, {}).toString();
    if (sourceItemId.isEmpty() || !library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto candidate = library.getChild(i);
        if (candidate.getProperty(kId).toString() == sourceItemId)
            return candidate.getProperty(kAudioType).toString() == "simple";
    }
    return false;
}

// Beats and duration both describe the file on disk, so this stays correct even for
// a sample exported with its warp baked in: the export stretches the duration and the
// beat count is unchanged, which is exactly the ratio that lands it back on the grid.
// A one-shot is excluded by every caller before it reaches here.
double ProjectState::musicalLengthBpm(const juce::ValueTree& item)
{
    const auto beats = static_cast<int>(item.getProperty(kMusicalBeats, 0));
    const auto durationMs = static_cast<double>(item.getProperty(kDurationMs, 0.0));
    if (beats <= 0 || durationMs <= 0.0) return 0.0;
    return (static_cast<double>(beats) * 60000.0) / durationMs;
}

bool ProjectState::setLibraryItemBpm(const juce::String& itemId, double bpm){
    return mutateDerivedLibraryItem(itemId,
                                    [bpm](juce::ValueTree& item)
                                    {
                                        if (isOneShotItem(item)) return;
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
                                        if (isOneShotItem(item)) return;
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

bool ProjectState::setLibraryItemMusicalBeats(const juce::String& itemId, int beats)
{
    return mutateDerivedLibraryItem(itemId,
                                    [beats](juce::ValueTree& item)
                                    {
                                        if (isOneShotItem(item)) return;
                                        if (beats > 0)
                                            item.setProperty(kMusicalBeats, beats, nullptr);
                                        else
                                            item.removeProperty(kMusicalBeats, nullptr);
                                    });
}

int ProjectState::getLibraryItemMusicalBeats(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() != itemId) continue;
        return static_cast<int>(item.getProperty(kMusicalBeats, 0));
    }
    return 0;
}

double ProjectState::getLibraryItemBeatAnchorSec(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() != itemId) continue;
        const double anchor = static_cast<double>(item.getProperty(kBeatAnchorSec, 0.0));
        return std::isfinite(anchor) && anchor >= 0.0 ? anchor : 0.0;
    }
    return 0.0;
}

bool ProjectState::setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec){
    return mutateDerivedLibraryItem(itemId,
                                    [anchorSec](juce::ValueTree& item)
                                    {
                                        if (isOneShotItem(item)) return;
                                        item.setProperty(kBeatAnchorSec, anchorSec, nullptr);
                                    });
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

        // A one-shot has no pulse — there is no grid to hand-tune.
        if (isOneShotItem(item)) return false;

        // Undoable, dirtying user edit — written through the UndoManager, and
        // deliberately NOT routed through mutateDerivedLibraryItem (which suppresses
        // dirty and mirrors the clean snapshot for automatic, non-undoable analysis).
        //
        // A hand-set tempo is the one instruction that outranks a recorded musical
        // length, so it drops it: keeping the length would silently ignore the number
        // the user just typed. This branch is manual tempo only — detection,
        // reanalysis and grid inheritance all take the automatic path and preserve it.
        item.removeProperty(kMusicalBeats, &undoManager);

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
    // `musicalBeats` deliberately survives a reanalysis: a clip cut to a number of bars
    // stays that number of bars whatever the reanalysis detects. Only a hand-set tempo
    // drops it — see setLibraryItemManualTempo.
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
            // A one-shot has no pulse, so it may not carry a tempo grid: a stale bpm
            // would keep seeding the project tempo, warping on drop and inheriting
            // into anything cut from it, all for material with no beat. Key/pitch is
            // unaffected — a one-shot can be in a key.
            if (audioType == "simple")
            {
                item.removeProperty(kBpm, nullptr);
                item.removeProperty(kBeats, nullptr);
                item.removeProperty(kBeatAnchorSec, nullptr);
                item.removeProperty(kMusicalBeats, nullptr);
                item.removeProperty(kVariableTempo, nullptr);
                item.removeProperty(kLowConfidence, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemScratchMeta(const juce::String& itemId,
                                             const juce::String& scratchPatternId,
                                             const juce::String& scratchSourcePath,
                                             bool undoable)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            auto* undo = undoable ? &undoManager : nullptr;
            if (scratchPatternId.isNotEmpty())
                item.setProperty(kScratchPatternId, scratchPatternId, undo);
            else
                item.removeProperty(kScratchPatternId, undo);
            if (scratchSourcePath.isNotEmpty())
                item.setProperty(kScratchSourcePath, scratchSourcePath, undo);
            else
                item.removeProperty(kScratchSourcePath, undo);
            return true;
        }
    }
    return false;
}

juce::String ProjectState::getLibraryItemScratchPatternId(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
            return item.getProperty(kScratchPatternId, {}).toString();
    }
    return {};
}

juce::String ProjectState::getLibraryItemScratchSourcePath(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
            return item.getProperty(kScratchSourcePath, {}).toString();
    }
    return {};
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
