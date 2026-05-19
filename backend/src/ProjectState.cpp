#include "ProjectState.h"

#include <vector>

namespace silverdaw
{

const juce::Identifier ProjectState::kProject{"PROJECT"};
const juce::Identifier ProjectState::kTrack{"TRACK"};
const juce::Identifier ProjectState::kClip{"CLIP"};
const juce::Identifier ProjectState::kId{"id"};
const juce::Identifier ProjectState::kName{"name"};
const juce::Identifier ProjectState::kGain{"gain"};
const juce::Identifier ProjectState::kFilePath{"filePath"};
const juce::Identifier ProjectState::kOffsetMs{"offsetMs"};
const juce::Identifier ProjectState::kInMs{"inMs"};
const juce::Identifier ProjectState::kDurationMs{"durationMs"};
const juce::Identifier ProjectState::kSampleRate{"sampleRate"};
const juce::Identifier ProjectState::kChannelCount{"channelCount"};
const juce::Identifier ProjectState::kColorIndex{"colorIndex"};
const juce::Identifier ProjectState::kViewPxPerSecond{"viewPxPerSecond"};
const juce::Identifier ProjectState::kViewScrollX{"viewScrollX"};
const juce::Identifier ProjectState::kPlayheadMs{"playheadMs"};
const juce::Identifier ProjectState::kBpm{"bpm"};
const juce::Identifier ProjectState::kProjectLengthMs{"projectLengthMs"};
const juce::Identifier ProjectState::kLibrary{"LIBRARY"};
const juce::Identifier ProjectState::kLibraryItem{"ITEM"};
const juce::Identifier ProjectState::kBeats{"beats"};
const juce::Identifier ProjectState::kBeatAnchorSec{"beatAnchorSec"};
const juce::Identifier ProjectState::kPlaybackFilePath{"playbackFilePath"};
const juce::Identifier ProjectState::kVariableTempo{"variableTempo"};

const juce::String ProjectState::kDefaultName{"Untitled"};

ProjectState::ProjectState() : root(kProject)
{
    // The initial `name=Untitled` write happens BEFORE we attach the
    // listener so it doesn't count as a user-initiated edit (it's part
    // of constructing a clean, empty project).
    root.setProperty(kName, kDefaultName, nullptr);
    root.addListener(this);
}

ProjectState::~ProjectState()
{
    root.removeListener(this);
}

void ProjectState::markClean()
{
    if (!dirty) return;
    setDirty(false);
}

void ProjectState::setDirtyChangedCallback(DirtyChangedCallback callback)
{
    onDirtyChanged = std::move(callback);
}

void ProjectState::setDirty(bool d)
{
    if (dirty == d) return;
    dirty = d;
    if (onDirtyChanged)
    {
        onDirtyChanged(d);
    }
}

void ProjectState::valueTreePropertyChanged(juce::ValueTree& /*tree*/,
                                            const juce::Identifier& /*property*/)
{
    if (suppressDirtyTransitions) return;
    setDirty(true);
}

void ProjectState::valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/)
{
    if (suppressDirtyTransitions) return;
    setDirty(true);
}

void ProjectState::valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                                         int /*index*/)
{
    if (suppressDirtyTransitions) return;
    setDirty(true);
}

void ProjectState::valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                              int /*newIndex*/)
{
    if (suppressDirtyTransitions) return;
    setDirty(true);
}

juce::String ProjectState::getName() const
{
    const auto stored = root.getProperty(kName, kDefaultName).toString().trim();
    return stored.isEmpty() ? kDefaultName : stored;
}

void ProjectState::setName(const juce::String& name)
{
    const auto trimmed = name.trim();
    root.setProperty(kName, trimmed.isEmpty() ? kDefaultName : trimmed, &undoManager);
}

juce::ValueTree ProjectState::findTrack(const juce::String& trackId) const
{
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (child.hasType(kTrack) && child.getProperty(kId).toString() == trackId)
        {
            return child;
        }
    }
    return {};
}

juce::ValueTree ProjectState::findClip(const juce::String& clipId) const
{
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (clip.hasType(kClip) && clip.getProperty(kId).toString() == clipId)
            {
                return clip;
            }
        }
    }
    return {};
}

bool ProjectState::addTrack(const juce::String& trackId)
{
    if (trackId.isEmpty())
    {
        return false;
    }
    if (findTrack(trackId).isValid())
    {
        return true; // idempotent
    }
    juce::ValueTree track(kTrack);
    track.setProperty(kId, trackId, &undoManager);
    track.setProperty(kGain, 1.0F, &undoManager);
    root.appendChild(track, &undoManager);
    return true;
}

juce::StringArray ProjectState::removeTrack(const juce::String& trackId)
{
    juce::StringArray removedClipIds;
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return removedClipIds;
    }
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto clip = track.getChild(i);
        if (clip.hasType(kClip))
        {
            removedClipIds.add(clip.getProperty(kId).toString());
        }
    }
    root.removeChild(track, &undoManager);
    return removedClipIds;
}

bool ProjectState::hasTrack(const juce::String& trackId) const
{
    return findTrack(trackId).isValid();
}

float ProjectState::getTrackGain(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 1.0F;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kGain, 1.0)));
}

bool ProjectState::setTrackName(const juce::String& trackId, const juce::String& name)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const auto trimmed = name.trim();
    if (trimmed.isEmpty())
    {
        return false;
    }
    track.setProperty(kName, trimmed, &undoManager);
    return true;
}

bool ProjectState::setTrackGain(const juce::String& trackId, float gain)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    track.setProperty(kGain, gain, &undoManager);
    return true;
}

juce::StringArray ProjectState::getTrackClipIds(const juce::String& trackId) const
{
    juce::StringArray ids;
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return ids;
    }
    for (int i = 0; i < track.getNumChildren(); ++i)
    {
        const auto clip = track.getChild(i);
        if (clip.hasType(kClip))
        {
            ids.add(clip.getProperty(kId).toString());
        }
    }
    return ids;
}

// `addClip` carries multiple adjacent `juce::String` parameters because the
// bridge envelope itself uses three distinct string fields. The parameter
// order is a load-bearing wire-protocol convention; swapping is silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool ProjectState::addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& filePath,
                           double offsetMs, double durationMs, double inMs, int colorIndex)
{
    if (trackId.isEmpty() || clipId.isEmpty())
    {
        return false;
    }
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    if (findClip(clipId).isValid())
    {
        return false; // id collision anywhere in the tree
    }
    juce::ValueTree clip(kClip);
    clip.setProperty(kId, clipId, &undoManager);
    clip.setProperty(kFilePath, filePath, &undoManager);
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    clip.setProperty(kInMs, inMs, &undoManager);
    clip.setProperty(kDurationMs, durationMs, &undoManager);
    if (colorIndex >= 0)
    {
        clip.setProperty(kColorIndex, colorIndex, &undoManager);
    }
    track.appendChild(clip, &undoManager);
    return true;
}

bool ProjectState::removeClip(const juce::String& clipId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    auto parent = clip.getParent();
    parent.removeChild(clip, &undoManager);
    return true;
}

bool ProjectState::setClipOffsetMs(const juce::String& clipId, double offsetMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    return true;
}

bool ProjectState::setClipTrack(const juce::String& clipId, const juce::String& newTrackId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    auto destTrack = findTrack(newTrackId);
    if (!destTrack.isValid())
    {
        return false;
    }
    auto oldParent = clip.getParent();
    if (oldParent == destTrack)
    {
        return true; // already on the destination track
    }
    // ValueTree nodes can only have one parent; removeChild +
    // appendChild on the same ValueTree object preserves the node
    // (including its sub-properties).
    oldParent.removeChild(clip, &undoManager);
    destTrack.appendChild(clip, &undoManager);
    return true;
}

bool ProjectState::setClipTrim(const juce::String& clipId, double offsetMs, double inMs, double durationMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    // Three writes on the same clip node coalesce into a single dirty
    // transition because `setDirty(true)` is a no-op when already true.
    clip.setProperty(kOffsetMs, offsetMs, &undoManager);
    clip.setProperty(kInMs, inMs, &undoManager);
    clip.setProperty(kDurationMs, durationMs, &undoManager);
    return true;
}

double ProjectState::getClipInMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kInMs, 0.0));
}

double ProjectState::getClipDurationMs(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kDurationMs, 0.0));
}

bool ProjectState::setClipColorIndex(const juce::String& clipId, int colorIndex)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (colorIndex < 0)
    {
        // Negative = remove the per-clip override and inherit the
        // host-track colour at render time.
        clip.removeProperty(kColorIndex, &undoManager);
    }
    else
    {
        clip.setProperty(kColorIndex, colorIndex, &undoManager);
    }
    return true;
}

bool ProjectState::setClipFilePath(const juce::String& clipId, const juce::String& filePath)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    clip.setProperty(kFilePath, filePath, &undoManager);
    return true;
}

juce::String ProjectState::getClipTrackId(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return {};
    }
    return clip.getParent().getProperty(kId).toString();
}

juce::String ProjectState::getClipFilePath(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return {};
    }
    return clip.getProperty(kFilePath).toString();
}

double ProjectState::getViewPxPerSecond() const
{
    // 100 px/s default matches the renderer's `DEFAULT_PX_PER_SECOND` so
    // a freshly-created project opens at the same zoom that was used
    // before this preference existed.
    return static_cast<double>(root.getProperty(kViewPxPerSecond, 100.0));
}

void ProjectState::setViewPxPerSecond(double pxPerSecond)
{
    // Zoom is view state, same as scroll — never marks dirty.
    suppressDirtyTransitions = true;
    root.setProperty(kViewPxPerSecond, pxPerSecond, nullptr);
    suppressDirtyTransitions = false;
}

double ProjectState::getViewScrollX() const
{
    return static_cast<double>(root.getProperty(kViewScrollX, 0.0));
}

void ProjectState::setViewScrollX(double scrollX)
{
    // Scroll is a view setting — never marks dirty.
    suppressDirtyTransitions = true;
    root.setProperty(kViewScrollX, scrollX, nullptr);
    suppressDirtyTransitions = false;
}

double ProjectState::getPlayheadMs() const
{
    return static_cast<double>(root.getProperty(kPlayheadMs, 0.0));
}

void ProjectState::setPlayheadMs(double playheadMs)
{
    // Playhead position is a transient transport / view value — never
    // marks dirty. Seeks/stops mirror into this property, and save
    // captures the current engine position immediately before writing.
    suppressDirtyTransitions = true;
    root.setProperty(kPlayheadMs, playheadMs, nullptr);
    suppressDirtyTransitions = false;
}

double ProjectState::getBpm() const
{
    return static_cast<double>(root.getProperty(kBpm, 100.0));
}

void ProjectState::setBpm(double bpm)
{
    // Tempo is a meaningful project edit; let the normal dirty-tracking
    // listener observe the property change.
    root.setProperty(kBpm, bpm, nullptr);
}

double ProjectState::getProjectLengthMs() const
{
    return static_cast<double>(root.getProperty(kProjectLengthMs, 0.0));
}

void ProjectState::setProjectLengthMs(double lengthMs)
{
    // Length is a meaningful edit (the user explicitly chose this
    // length via the transport bar).
    root.setProperty(kProjectLengthMs, lengthMs, nullptr);
}

bool ProjectState::addLibraryItem(const juce::String& itemId, const juce::String& filePath, const juce::String& fileName,
                                  double durationMs, int sampleRate, int channelCount,
                                  const juce::String& playbackPath)
{
    if (itemId.isEmpty() || filePath.isEmpty()) return false;
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid())
    {
        library = juce::ValueTree(kLibrary);
        root.appendChild(library, nullptr);
    }
    // If an item with the same id already exists, just update its
    // filePath — covers the relink-from-library case and is more
    // forgiving than a hard-fail.
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kFilePath, filePath, nullptr);
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
            return true;
        }
    }
    juce::ValueTree item(kLibraryItem);
    item.setProperty(kId, itemId, nullptr);
    item.setProperty(kFilePath, filePath, nullptr);
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
    library.appendChild(item, nullptr);
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
            library.removeChild(item, nullptr);
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemBpm(const juce::String& itemId, double bpm)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (bpm > 0.0)
            {
                item.setProperty(kBpm, bpm, nullptr);
            }
            else
            {
                item.removeProperty(kBpm, nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemBeats(const juce::String& itemId, const std::vector<double>& beatTimesSec)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (beatTimesSec.empty())
            {
                item.removeProperty(kBeats, nullptr);
            }
            else
            {
                juce::Array<juce::var> arr;
                arr.ensureStorageAllocated(static_cast<int>(beatTimesSec.size()));
                for (double t : beatTimesSec) arr.add(juce::var(t));
                item.setProperty(kBeats, juce::var(arr), nullptr);
            }
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemBeatAnchor(const juce::String& itemId, double anchorSec)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.setProperty(kBeatAnchorSec, anchorSec, nullptr);
            return true;
        }
    }
    return false;
}

bool ProjectState::setLibraryItemPlaybackPath(const juce::String& itemId, const juce::String& playbackPath)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (playbackPath.isEmpty())
            {
                item.removeProperty(kPlaybackFilePath, nullptr);
            }
            else
            {
                item.setProperty(kPlaybackFilePath, playbackPath, nullptr);
            }
            return true;
        }
    }
    return false;
}

juce::String ProjectState::getLibraryItemPlaybackPathForSource(const juce::String& sourceFilePath) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kFilePath).toString() == sourceFilePath)
        {
            return item.getProperty(kPlaybackFilePath, {}).toString();
        }
    }
    return {};
}

bool ProjectState::setLibraryItemVariableTempo(const juce::String& itemId, bool variable)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            if (variable)
            {
                item.setProperty(kVariableTempo, true, nullptr);
            }
            else
            {
                item.removeProperty(kVariableTempo, nullptr);
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
        if (item.getProperty(kFilePath).toString() == filePath) return true;
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
        if (item.getProperty(kFilePath).toString() == filePath)
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
        if (item.hasProperty(kName))
        {
            obj->setProperty("fileName", item.getProperty(kName).toString());
        }
        obj->setProperty("durationMs", static_cast<double>(item.getProperty(kDurationMs, 0.0)));
        obj->setProperty("sampleRate", static_cast<int>(item.getProperty(kSampleRate, 0)));
        obj->setProperty("channelCount", static_cast<int>(item.getProperty(kChannelCount, 0)));
        if (item.hasProperty(kBpm))
        {
            obj->setProperty("bpm", static_cast<double>(item.getProperty(kBpm, 0.0)));
        }
        if (item.hasProperty(kBeats))
        {
            // Pass the underlying `juce::var` array straight through —
            // it's already a `juce::var` containing `Array<var>` of
            // numbers, which `JSON::toString` serialises as `[…]`.
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
        // Same unresolved-flag pattern as clips so the renderer can
        // grey-out library cards whose source file has gone missing
        // since the project was last saved.
        if (filePath.isEmpty() || !juce::File(filePath).existsAsFile())
        {
            obj->setProperty("unresolved", true);
        }
        arr.add(juce::var(obj));
    }
    return juce::var(arr);
}

juce::var ProjectState::tracksAsJson() const
{
    juce::Array<juce::var> tracksArray;

    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack))
        {
            continue;
        }

        auto* trackObj = new juce::DynamicObject();
        trackObj->setProperty("id", track.getProperty(kId).toString());
        trackObj->setProperty("name", track.getProperty(kName).toString());
        trackObj->setProperty("gain", static_cast<double>(track.getProperty(kGain, 1.0)));

        juce::Array<juce::var> clipsArray;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip))
            {
                continue;
            }
            auto* clipObj = new juce::DynamicObject();
            clipObj->setProperty("id", clip.getProperty(kId).toString());
            const juce::String filePath = clip.getProperty(kFilePath).toString();
            clipObj->setProperty("filePath", filePath);
            clipObj->setProperty("offsetMs", static_cast<double>(clip.getProperty(kOffsetMs, 0.0)));
            clipObj->setProperty("inMs", static_cast<double>(clip.getProperty(kInMs, 0.0)));
            clipObj->setProperty("durationMs", static_cast<double>(clip.getProperty(kDurationMs, 0.0)));
            // Only emit `colorIndex` when explicitly set so the renderer
            // can distinguish "inherit from track" (property absent)
            // from "user picked a colour".
            if (clip.hasProperty(kColorIndex))
            {
                clipObj->setProperty("colorIndex", static_cast<int>(clip.getProperty(kColorIndex, -1)));
            }
            // Flag clips whose source file is missing from disk so the
            // renderer can render them greyed-out and prompt the user
            // to relink. We test by path: an empty path is also treated
            // as unresolved (defensive — shouldn't happen, but covers
            // the edge case).
            const bool unresolved = filePath.isEmpty() || !juce::File(filePath).existsAsFile();
            if (unresolved)
            {
                clipObj->setProperty("unresolved", true);
            }
            clipsArray.add(juce::var(clipObj));
        }
        trackObj->setProperty("clips", clipsArray);
        tracksArray.add(juce::var(trackObj));
    }

    return tracksArray;
}

juce::Result ProjectState::replaceTree(const juce::ValueTree& newTree)
{
    if (!newTree.isValid() || !newTree.hasType(kProject))
    {
        return juce::Result::fail("Expected root <PROJECT> element");
    }
    // Suppress dirty transitions while we wipe + re-populate `root` —
    // those listener callbacks would otherwise produce a misleading
    // "dirty=true" emission for a freshly-loaded (and therefore clean)
    // project. We restore the listener and explicitly markClean() at
    // the end so the renderer sees a single, correct transition.
    suppressDirtyTransitions = true;
    root.removeAllChildren(nullptr);
    root.removeAllProperties(nullptr);
    root.copyPropertiesAndChildrenFrom(newTree, nullptr);
    undoManager.clearUndoHistory();
    suppressDirtyTransitions = false;
    // A load is by definition clean (in-memory state matches disk).
    // Emit a single dirty=false transition if we were dirty going in.
    markClean();
    return juce::Result::ok();
}

} // namespace silverdaw
