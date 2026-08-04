#include "ProjectState.h"
#include "Log.h"

#include <vector>

namespace silverdaw
{

bool ProjectState::addLibraryItem(const juce::String& itemId, const juce::String& filePath, const juce::String& fileName,
                                   double durationMs, int sampleRate, int channelCount,
                                   const juce::String& playbackPath, const juce::String& key,
                                   const juce::String& kind, const juce::String& displayName,
                                   const juce::String& sourceItemId, const juce::String& sourceClipId,
                                   double sourceInMs, double sourceDurationMs,
                                   int collapsedFlag, const juce::String& mediaId)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return false;
    // A recognised kind is explicit; anything else (including empty) means "not supplied".
    const bool kindSupplied = (kind == "clip" || kind == "stem" || kind == "sample" || kind == "source");
    const auto normalisedKind = kindSupplied ? kind : juce::String("source");
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
            // Reanalyse and relink pass no kind; only an explicit one may re-classify an
            // existing item, or a sample/stem/clip would silently demote to a plain source.
            if (kindSupplied)
            {
                item.setProperty(kKind, normalisedKind, &undoManager);
            }
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
            if (mediaId.isNotEmpty())
            {
                item.setProperty(kMediaId, mediaId, &undoManager);
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
    if (mediaId.isNotEmpty())
    {
        item.setProperty(kMediaId, mediaId, nullptr);
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

bool ProjectState::removeLibraryItemNonDirty(const juce::String& itemId)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;

    // Suppress the dirty listeners and remove without the undo manager, then mirror the
    // removal into the clean snapshot so root stays equivalent to it (no pending change).
    const SuppressDirtyScope suppress(*this);
    bool removed = false;
    for (int i = library.getNumChildren() - 1; i >= 0; --i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            library.removeChild(item, nullptr);
            removed = true;
            break;
        }
    }
    if (!removed) return false;

    if (cleanSnapshot.isValid())
    {
        auto snapLibrary = cleanSnapshot.getChildWithName(kLibrary);
        if (snapLibrary.isValid())
        {
            for (int i = snapLibrary.getNumChildren() - 1; i >= 0; --i)
            {
                auto snapItem = snapLibrary.getChild(i);
                if (snapItem.getProperty(kId).toString() == itemId)
                {
                    snapLibrary.removeChild(snapItem, nullptr);
                    break;
                }
            }
        }
    }
    return true;
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

juce::String ProjectState::getLibraryItemSourceItemId(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
            return item.getProperty(kSourceItemId, {}).toString();
    }
    return {};
}

juce::String ProjectState::getTempoInheritanceSourceId(const juce::String& itemId) const
{
    const auto sourceItemId = getLibraryItemSourceItemId(itemId);
    if (sourceItemId.isEmpty()) return {};
    // getLibraryItemBpm is the single resolver: it returns 0 for a one-shot (which may
    // never hold a tempo) and otherwise falls back to the source, so a positive value
    // here means there is a real tempo to inherit and this item may hold it.
    if (getLibraryItemBpm(itemId) <= 0.0) return {};
    return sourceItemId;
}

juce::String ProjectState::getLibraryItemMediaId(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    // Walk the derived-from chain (a sample saved from a clip region, etc.) back
    // to the origin that actually carries a media GUID.
    juce::String currentId = itemId;
    juce::StringArray seen;
    while (currentId.isNotEmpty() && ! seen.contains(currentId))
    {
        seen.add(currentId);
        juce::ValueTree found;
        for (int i = 0; i < library.getNumChildren(); ++i)
        {
            const auto item = library.getChild(i);
            if (item.getProperty(kId).toString() == currentId)
            {
                found = item;
                break;
            }
        }
        if (! found.isValid()) break;
        const auto mid = found.getProperty(kMediaId, {}).toString();
        if (mid.isNotEmpty()) return mid;
        currentId = found.getProperty(kSourceItemId, {}).toString();
    }
    return {};
}

int ProjectState::repairLegacyLibraryItemKinds(const juce::File& projectDir)
{
    auto library = root.getChildWithName(kLibrary);
    return repairLibraryItemKinds(library, projectDir);
}

int ProjectState::repairLibraryItemKinds(juce::ValueTree& library, const juce::File& projectDir)
{
    // Two ways a library item could end up mis-typed in an older project file:
    //
    //  * Saved samples were persisted as plain sources before saving a sample
    //    stopped normalising `kind`. Every sample id is minted as "sample-<uuid>"
    //    by all three creation paths (save clip as sample, save library clip as
    //    sample, slice to samples), so the prefix identifies them exactly.
    //  * Reanalysing a stem or sample demoted it to a plain source, because the
    //    reanalyse command re-added the item without a kind. A demoted stem then
    //    vanished from the cross-project import, which only offers "stem" and
    //    "sample" items. Generated artifacts live in a project-relative folder per
    //    category, so the folder the file sits in says what the item is.
    //
    // Membership is decided by containment under the project folder, not by the path
    // string: a loaded tree always holds absolute paths (they are resolved out of
    // their portable form at the JSON boundary), so testing for a relative path here
    // would never match anything a real load produces.
    //
    // Repaired in place wherever a project tree is read, so an old file both opens
    // and imports correctly, and persists correctly on its next save.
    if (!library.isValid()) return 0;

    // Category folder → the kind an item stored under it must have. Channel splits
    // reuse the stem kind (badge, cleanup, serialisation); scratch bakes are samples.
    struct ArtifactKind { const char* folder; const char* kind; };
    static const ArtifactKind kArtifactKinds[] = {
        {"stems", "stem"}, {"channels", "stem"}, {"samples", "sample"}, {"scratches", "sample"}};

    int repaired = 0;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        const auto kind = item.getProperty(kKind, "source").toString();

        if (item.getProperty(kId).toString().startsWith("sample-"))
        {
            if (kind == "sample") continue;
            item.setProperty(kKind, "sample", nullptr);
            ++repaired;
            continue;
        }

        // Only a plain source is ambiguous; an explicit stem/sample/clip is trusted.
        if (kind != "source") continue;
        const auto path = item.getProperty(kFilePath, {}).toString();
        if (path.isEmpty() || projectDir.getFullPathName().isEmpty()) continue;
        // Generated artifacts live under the project folder. An external import that
        // merely sits in a same-named folder somewhere else is not one, and a path
        // that escapes the folder comes back from getRelativePathFrom with "..".
        // Compared as paths rather than by touching the disk: the repair must reach
        // the same verdict for an item whose file has since been moved or deleted.
        const juce::File itemFile(path);
        if (!itemFile.isAChildOf(projectDir)) continue;
        const auto relative = itemFile.getRelativePathFrom(projectDir);
        if (relative.startsWith("..")) continue;
        const auto firstSegment = relative.upToFirstOccurrenceOf("\\", false, false)
                                      .upToFirstOccurrenceOf("/", false, false);
        for (const auto& mapping : kArtifactKinds)
        {
            if (firstSegment != mapping.folder) continue;
            item.setProperty(kKind, mapping.kind, nullptr);
            ++repaired;
            break;
        }
    }
    if (repaired > 0)
    {
        silverdaw::log::info("project",
                             "repaired kind on " + juce::String(repaired) + " library item(s)");
    }
    return repaired;
}

bool ProjectState::hasLibraryItemForPath(const juce::String& filePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        const auto kind = item.getProperty(kKind, "source").toString();
        if ((kind == "source" || kind == "sample")
            && item.getProperty(kFilePath).toString() == filePath) return true;
    }
    return false;
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
        const auto kind = item.getProperty(kKind, "source").toString();
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
        if (item.hasProperty(kMusicalBeats))
        {
            obj->setProperty("musicalBeats", static_cast<int>(item.getProperty(kMusicalBeats, 0)));
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
        if (item.hasProperty(kAudioType))
        {
            const auto audioType = item.getProperty(kAudioType).toString();
            if (audioType == "simple" || audioType == "music")
            {
                obj->setProperty("audioType", audioType);
            }
        }
        if (item.hasProperty(kScratchPatternId))
        {
            const auto scratchPatternId = item.getProperty(kScratchPatternId).toString();
            if (scratchPatternId.isNotEmpty())
            {
                obj->setProperty("scratchPatternId", scratchPatternId);
                obj->setProperty("scratchOrigin", true);
            }
        }
        if (item.hasProperty(kScratchSourcePath))
        {
            obj->setProperty("scratchSourcePath",
                             item.getProperty(kScratchSourcePath).toString());
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
        if (item.hasProperty(kMediaId))
        {
            obj->setProperty("mediaId", item.getProperty(kMediaId).toString());
        }
        if (item.hasProperty(kCollapsed) && bool(item.getProperty(kCollapsed)))
        {
            obj->setProperty("collapsed", true);
        }
        if (item.hasProperty(kCoverArtHidden) && bool(item.getProperty(kCoverArtHidden)))
        {
            obj->setProperty("coverArtHidden", true);
        }
        if (item.hasProperty(kCoverArtOverride))
        {
            const auto coverFile = item.getProperty(kCoverArtOverride).toString();
            if (coverFile.isNotEmpty()) obj->setProperty("coverArtOverride", coverFile);
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
