#include "ProjectState.h"

#include <vector>

namespace silverdaw
{

bool ProjectState::addLibraryItem(const juce::String& itemId, const juce::String& filePath, const juce::String& fileName,
                                   double durationMs, int sampleRate, int channelCount,
                                   const juce::String& playbackPath, const juce::String& key,
                                   const juce::String& kind, const juce::String& displayName,
                                   const juce::String& sourceItemId, const juce::String& sourceClipId,
                                   double sourceInMs, double sourceDurationMs,
                                   int collapsedFlag)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return false;
    const auto normalisedKind = kind == "saved-clip" ? juce::String("saved-clip") : juce::String("audio-file");
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid())
    {
        library = juce::ValueTree(kLibrary);
        root.appendChild(library, nullptr);
    }
    // Existing ids update in place to support relink-from-library.
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kFilePath, filePath, &undoManager);
            item.setProperty(kKind, normalisedKind, &undoManager);
            if (displayName.isNotEmpty())
            {
                item.setProperty(kDisplayName, displayName, &undoManager);
            }
            if (fileName.isNotEmpty())
            {
                item.setProperty(kName, fileName, &undoManager);
            }
            if (durationMs > 0.0)
            {
                item.setProperty(kDurationMs, durationMs, &undoManager);
            }
            if (sampleRate > 0)
            {
                item.setProperty(kSampleRate, sampleRate, &undoManager);
            }
            if (channelCount > 0)
            {
                item.setProperty(kChannelCount, channelCount, &undoManager);
            }
            if (playbackPath.isNotEmpty())
            {
                item.setProperty(kPlaybackFilePath, playbackPath, &undoManager);
            }
            if (key.isNotEmpty())
            {
                item.setProperty(kKey, key, &undoManager);
            }
            if (sourceItemId.isNotEmpty())
            {
                item.setProperty(kSourceItemId, sourceItemId, &undoManager);
            }
            if (sourceClipId.isNotEmpty())
            {
                item.setProperty(kSourceClipId, sourceClipId, &undoManager);
            }
            if (sourceInMs >= 0.0)
            {
                item.setProperty(kSourceInMs, sourceInMs, &undoManager);
            }
            if (sourceDurationMs >= 0.0)
            {
                item.setProperty(kSourceDurationMs, sourceDurationMs, &undoManager);
            }
            if (collapsedFlag == 1)
            {
                item.setProperty(kCollapsed, true, &undoManager);
            }
            else if (collapsedFlag == 0)
            {
                item.removeProperty(kCollapsed, &undoManager);
            }
            return true;
        }
    }
    juce::ValueTree item(kLibraryItem);
    item.setProperty(kId, itemId, nullptr);
    item.setProperty(kFilePath, filePath, nullptr);
    item.setProperty(kKind, normalisedKind, nullptr);
    if (displayName.isNotEmpty())
    {
        item.setProperty(kDisplayName, displayName, nullptr);
    }
    if (fileName.isNotEmpty())
    {
        item.setProperty(kName, fileName, nullptr);
    }
    if (durationMs > 0.0)
    {
        item.setProperty(kDurationMs, durationMs, nullptr);
    }
    if (sampleRate > 0)
    {
        item.setProperty(kSampleRate, sampleRate, nullptr);
    }
    if (channelCount > 0)
    {
        item.setProperty(kChannelCount, channelCount, nullptr);
    }
    if (playbackPath.isNotEmpty())
    {
        item.setProperty(kPlaybackFilePath, playbackPath, nullptr);
    }
    if (key.isNotEmpty())
    {
        item.setProperty(kKey, key, nullptr);
    }
    if (sourceItemId.isNotEmpty())
    {
        item.setProperty(kSourceItemId, sourceItemId, nullptr);
    }
    if (sourceClipId.isNotEmpty())
    {
        item.setProperty(kSourceClipId, sourceClipId, nullptr);
    }
    if (sourceInMs >= 0.0)
    {
        item.setProperty(kSourceInMs, sourceInMs, nullptr);
    }
    if (sourceDurationMs >= 0.0)
    {
        item.setProperty(kSourceDurationMs, sourceDurationMs, nullptr);
    }
    if (collapsedFlag == 1)
    {
        item.setProperty(kCollapsed, true, nullptr);
    }
    // Set orphan properties before append so insertion is one undoable action.
    library.appendChild(item, &undoManager);
    return true;
}

bool ProjectState::removeLibraryItem(const juce::String& itemId)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = library.getNumChildren() - 1; i >= 0; --i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            library.removeChild(item, &undoManager);
            return true;
        }
    }
    return false;
}

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

bool ProjectState::setLibraryItemFilePath(const juce::String& itemId, const juce::String& filePath)
{
    if (filePath.isEmpty()) return false;
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kFilePath, filePath, &undoManager);
            // New source invalidates the decoded playback cache path.
            item.removeProperty(kPlaybackFilePath, &undoManager);
            return true;
        }
    }
    return false;
}

juce::String ProjectState::getLibraryItemFilePath(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            return item.getProperty(kFilePath, {}).toString();
        }
    }
    return {};
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
        // Warp defaults are only meaningful on saved-clip items.
        if (item.getProperty(kKind).toString() != "saved-clip") return false;
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
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
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

bool ProjectState::setLibraryItemSampleMode(const juce::String& itemId, const juce::String& mode)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (mode == "sample" || mode == "music")
            {
                item.setProperty(kSampleMode, mode, nullptr);
            }
            else
            {
                item.removeProperty(kSampleMode, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::hasLibraryItemForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
            && item.getProperty(kFilePath).toString() == filePath) return true;
    }
    return false;
}

double ProjectState::getLibraryItemBpmForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kKind, "audio-file").toString() == "audio-file"
            && item.getProperty(kFilePath).toString() == filePath)
        {
            return static_cast<double>(item.getProperty(kBpm, 0.0));
        }
    }
    return 0.0;
}

juce::var ProjectState::libraryAsJson() const
{
    juce::Array<juce::var> arr;
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return juce::var(arr);
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (!item.hasType(kLibraryItem)) continue;
        auto* obj = new juce::DynamicObject();
        obj->setProperty("id", item.getProperty(kId).toString());
        const juce::String filePath = item.getProperty(kFilePath).toString();
        obj->setProperty("filePath", filePath);
        const auto kind = item.getProperty(kKind, "audio-file").toString();
        obj->setProperty("kind", kind);
        if (item.hasProperty(kDisplayName))
        {
            obj->setProperty("name", item.getProperty(kDisplayName).toString());
        }
        if (item.hasProperty(kName))
        {
            obj->setProperty("fileName", item.getProperty(kName).toString());
        }
        obj->setProperty("durationMs", static_cast<double>(item.getProperty(kDurationMs, 0.0)));
        obj->setProperty("sampleRate", static_cast<int>(item.getProperty(kSampleRate, 0)));
        obj->setProperty("channelCount", static_cast<int>(item.getProperty(kChannelCount, 0)));
        if (item.hasProperty(kKey))
        {
            obj->setProperty("key", item.getProperty(kKey).toString());
        }
        if (item.hasProperty(kBpm))
        {
            obj->setProperty("bpm", static_cast<double>(item.getProperty(kBpm, 0.0)));
        }
        if (item.hasProperty(kBeats))
        {
            // Stored beat arrays are already JSON-ready juce::var values.
            obj->setProperty("beats", item.getProperty(kBeats));
        }
        if (item.hasProperty(kBeatAnchorSec))
        {
            obj->setProperty("beatAnchorSec",
                             static_cast<double>(item.getProperty(kBeatAnchorSec, 0.0)));
        }
        if (item.hasProperty(kPlaybackFilePath))
        {
            obj->setProperty("playbackFilePath", item.getProperty(kPlaybackFilePath).toString());
        }
        if (item.hasProperty(kVariableTempo) && bool(item.getProperty(kVariableTempo)))
        {
            obj->setProperty("variableTempo", true);
        }
        if (item.hasProperty(kLowConfidence) && bool(item.getProperty(kLowConfidence)))
        {
            obj->setProperty("lowConfidence", true);
        }
        if (item.hasProperty(kSampleMode))
        {
            const auto mode = item.getProperty(kSampleMode).toString();
            if (mode == "sample" || mode == "music")
            {
                obj->setProperty("sampleMode", mode);
            }
        }
        if (item.hasProperty(kSourceItemId))
        {
            obj->setProperty("sourceItemId", item.getProperty(kSourceItemId).toString());
        }
        if (item.hasProperty(kSourceClipId))
        {
            obj->setProperty("sourceClipId", item.getProperty(kSourceClipId).toString());
        }
        if (item.hasProperty(kSourceInMs))
        {
            obj->setProperty("sourceInMs", static_cast<double>(item.getProperty(kSourceInMs, 0.0)));
        }
        if (item.hasProperty(kSourceDurationMs))
        {
            obj->setProperty("sourceDurationMs", static_cast<double>(item.getProperty(kSourceDurationMs, 0.0)));
        }
        if (item.hasProperty(kCollapsed) && bool(item.getProperty(kCollapsed)))
        {
            obj->setProperty("collapsed", true);
        }
        // Saved-clip warp defaults are copied on drop, not live-linked.
        if (item.hasProperty(kWarpEnabled))
        {
            obj->setProperty("warpEnabled", static_cast<bool>(item.getProperty(kWarpEnabled, false)));
        }
        if (item.hasProperty(kWarpMode))
        {
            obj->setProperty("warpMode", item.getProperty(kWarpMode).toString());
        }
        if (item.hasProperty(kTempoRatio))
        {
            obj->setProperty("tempoRatio", static_cast<double>(item.getProperty(kTempoRatio, 1.0)));
        }
        if (item.hasProperty(kSemitones))
        {
            obj->setProperty("semitones", static_cast<double>(item.getProperty(kSemitones, 0.0)));
        }
        if (item.hasProperty(kCents))
        {
            obj->setProperty("cents", static_cast<double>(item.getProperty(kCents, 0.0)));
        }
        // Mirrors clip unresolved state for missing library sources.
        if (filePath.isEmpty() || !juce::File(filePath).existsAsFile())
        {
            obj->setProperty("unresolved", true);
        }
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

} // namespace silverdaw
