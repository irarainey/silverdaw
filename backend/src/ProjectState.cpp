#include "ProjectState.h"

#include <cmath>
#include <vector>

namespace silverdaw
{

const juce::Identifier ProjectState::kProject{"PROJECT"};
const juce::Identifier ProjectState::kTrack{"TRACK"};
const juce::Identifier ProjectState::kClip{"CLIP"};
const juce::Identifier ProjectState::kId{"id"};
const juce::Identifier ProjectState::kName{"name"};
const juce::Identifier ProjectState::kGain{"gain"};
const juce::Identifier ProjectState::kHeightPx{"heightPx"};
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
const juce::Identifier ProjectState::kMarkers{"MARKERS"};
const juce::Identifier ProjectState::kMarker{"MARKER"};
const juce::Identifier ProjectState::kPositionMs{"positionMs"};
const juce::Identifier ProjectState::kBeats{"beats"};
const juce::Identifier ProjectState::kBeatAnchorSec{"beatAnchorSec"};
const juce::Identifier ProjectState::kPlaybackFilePath{"playbackFilePath"};
const juce::Identifier ProjectState::kVariableTempo{"variableTempo"};
const juce::Identifier ProjectState::kKey{"key"};
const juce::Identifier ProjectState::kKind{"kind"};
const juce::Identifier ProjectState::kSourceItemId{"sourceItemId"};
const juce::Identifier ProjectState::kSourceClipId{"sourceClipId"};
const juce::Identifier ProjectState::kSourceInMs{"sourceInMs"};
const juce::Identifier ProjectState::kSourceDurationMs{"sourceDurationMs"};
const juce::Identifier ProjectState::kDisplayName{"displayName"};
const juce::Identifier ProjectState::kClipName{"clipName"};
const juce::Identifier ProjectState::kCollapsed{"collapsed"};
const juce::Identifier ProjectState::kLibraryItemId{"libraryItemId"};

const juce::String ProjectState::kDefaultName{"Untitled"};

ProjectState::ProjectState() : root(kProject)
{
    // The initial `name=Untitled` write and the empty container children
    // happen BEFORE we attach the listener so they don't count as
    // user-initiated edits. Adding the LIBRARY / MARKERS containers up
    // front means add-then-remove cycles return to byte-identical state
    // (the containers don't appear and disappear with their contents),
    // so the clean-snapshot comparison correctly reports "clean" after
    // a net-zero edit sequence.
    root.setProperty(kName, kDefaultName, nullptr);
    root.appendChild(juce::ValueTree(kLibrary), nullptr);
    root.appendChild(juce::ValueTree(kMarkers), nullptr);
    cleanSnapshot = root.createCopy();
    root.addListener(this);
}

ProjectState::~ProjectState()
{
    root.removeListener(this);
}

void ProjectState::markClean()
{
    // Capture the current tree as the new clean baseline so subsequent
    // mutations are compared against the just-saved state. Any net-zero
    // edit sequence (e.g. add + remove a library item) will then
    // correctly return the project to its clean status.
    cleanSnapshot = root.createCopy();
    if (dirty) setDirty(false);
}

void ProjectState::markDirty()
{
    if (!dirty) setDirty(true);
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

void ProjectState::recomputeDirty()
{
    // Compare the live tree against the last clean snapshot. If they
    // match, the project has effectively returned to its saved state
    // and should be considered clean again — even if individual
    // listener callbacks tried to flip dirty=true along the way.
    if (!cleanSnapshot.isValid())
    {
        setDirty(true);
        return;
    }
    const bool actuallyDirty = !root.isEquivalentTo(cleanSnapshot);
    setDirty(actuallyDirty);
}

void ProjectState::valueTreePropertyChanged(juce::ValueTree& /*tree*/,
                                            const juce::Identifier& /*property*/)
{
    if (suppressDirtyTransitions) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/)
{
    if (suppressDirtyTransitions) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                                         int /*index*/)
{
    if (suppressDirtyTransitions) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                              int /*newIndex*/)
{
    if (suppressDirtyTransitions) return;
    recomputeDirty();
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

// Per-track row height clamps. Must agree with the renderer's
// MIN_TRACK_HEIGHT / MAX_TRACK_HEIGHT in
// `frontend/src/renderer/src/lib/timeline/constants.ts` so the backend
// rejects values outside the resize-handle's range.
static constexpr double kMinTrackHeightPx = 60.0;
static constexpr double kMaxTrackHeightPx = 400.0;

double ProjectState::getTrackHeightPx(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0;
    }
    return static_cast<double>(track.getProperty(kHeightPx, 0.0));
}

bool ProjectState::setTrackHeightPx(const juce::String& trackId, double heightPx)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const auto clamped = juce::jlimit(kMinTrackHeightPx, kMaxTrackHeightPx, heightPx);
    track.setProperty(kHeightPx, clamped, &undoManager);
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
// bridge envelope itself uses two distinct string fields. The parameter
// order is a load-bearing wire-protocol convention; swapping is silenced.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
bool ProjectState::addClip(const juce::String& trackId, const juce::String& clipId, const juce::String& libraryItemId,
                           double offsetMs, double durationMs, double inMs, int colorIndex)
{
    if (trackId.isEmpty() || clipId.isEmpty() || libraryItemId.isEmpty())
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
    clip.setProperty(kLibraryItemId, libraryItemId, &undoManager);
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

juce::String ProjectState::getClipLibraryItemId(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return clip.getProperty(kLibraryItemId, {}).toString();
}

bool ProjectState::setClipLibraryItemId(const juce::String& clipId, const juce::String& libraryItemId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    clip.setProperty(kLibraryItemId, libraryItemId, &undoManager);
    return true;
}

bool ProjectState::setClipName(const juce::String& clipId, const juce::String& name)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    const auto trimmed = name.trim();
    if (trimmed.isEmpty())
    {
        clip.removeProperty(kClipName, &undoManager);
    }
    else
    {
        clip.setProperty(kClipName, trimmed, &undoManager);
    }
    return true;
}

juce::String ProjectState::getClipName(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return clip.getProperty(kClipName, {}).toString();
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
    // Source-of-truth is the linked library item; fall back to a
    // legacy `filePath` property if present (older projects that
    // pre-date the library-item-id refactor).
    const juce::String libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
    if (libraryItemId.isNotEmpty())
    {
        const auto path = getLibraryItemFilePath(libraryItemId);
        if (path.isNotEmpty()) return path;
    }
    return clip.getProperty(kFilePath, {}).toString();
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
    // Tempo is a meaningful project edit; record via the undo manager
    // so Ctrl+Z reverts a tempo change.
    root.setProperty(kBpm, bpm, &undoManager);
}

double ProjectState::getProjectLengthMs() const
{
    return static_cast<double>(root.getProperty(kProjectLengthMs, 0.0));
}

void ProjectState::setProjectLengthMs(double lengthMs)
{
    // Length is a meaningful edit (the user explicitly chose this
    // length via the transport bar) — recorded for undo.
    root.setProperty(kProjectLengthMs, lengthMs, &undoManager);
}

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
    // If an item with the same id already exists, just update its
    // filePath — covers the relink-from-library case and is more
    // forgiving than a hard-fail.
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
    // The properties above are set on the orphan item BEFORE it joins
    // the tree so they don't generate undo actions individually — the
    // single `appendChild` below records one undoable action that
    // covers the entire item insertion (undo removes the whole child).
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
            // Clear the cached playback path — the new source needs to
            // be decoded again before playback can use a WAV cache.
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

bool ProjectState::clearLibraryItemAnalysis(const juce::String& itemId)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            item.removeProperty(kBpm, nullptr);
            item.removeProperty(kBeats, nullptr);
            item.removeProperty(kBeatAnchorSec, nullptr);
            item.removeProperty(kVariableTempo, nullptr);
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

bool ProjectState::addMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    juce::ValueTree markers;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (child.hasType(kMarkers))
        {
            markers = child;
            break;
        }
    }
    if (!markers.isValid())
    {
        markers = juce::ValueTree(kMarkers);
        root.addChild(markers, -1, nullptr);
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return true;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }

    juce::ValueTree marker(kMarker);
    marker.setProperty(kId, markerId, nullptr);
    marker.setProperty(kPositionMs, positionMs, nullptr);
    markers.addChild(marker, -1, &undoManager);
    return true;
}

bool ProjectState::moveMarker(const juce::String& markerId, double positionMs)
{
    if (markerId.isEmpty() || positionMs < 0.0)
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = 0; i < markers.getNumChildren(); ++i)
    {
        auto marker = markers.getChild(i);
        const double markerPositionMs = static_cast<double>(marker.getProperty(kPositionMs, 0.0));
        if (marker.hasType(kMarker) && std::abs(markerPositionMs - positionMs) < 0.5
            && marker.getProperty(kId).toString() != markerId)
        {
            return false;
        }
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            const double current = markerPositionMs;
            if (std::abs(current - positionMs) < 0.01)
            {
                return true;
            }
            marker.setProperty(kPositionMs, positionMs, &undoManager);
            return true;
        }
    }
    return false;
}

bool ProjectState::removeMarker(const juce::String& markerId)
{
    if (markerId.isEmpty())
    {
        return false;
    }

    auto markers = root.getChildWithName(kMarkers);
    if (!markers.isValid())
    {
        return false;
    }

    for (int i = markers.getNumChildren() - 1; i >= 0; --i)
    {
        auto marker = markers.getChild(i);
        if (marker.hasType(kMarker) && marker.getProperty(kId).toString() == markerId)
        {
            markers.removeChild(marker, &undoManager);
            return true;
        }
    }
    return false;
}

juce::var ProjectState::markersAsJson() const
{
    juce::Array<juce::var> markersArray;

    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto markers = root.getChild(i);
        if (!markers.hasType(kMarkers))
        {
            continue;
        }
        for (int m = 0; m < markers.getNumChildren(); ++m)
        {
            const auto marker = markers.getChild(m);
            if (!marker.hasType(kMarker))
            {
                continue;
            }
            auto* obj = new juce::DynamicObject();
            obj->setProperty("id", marker.getProperty(kId).toString());
            obj->setProperty("positionMs", static_cast<double>(marker.getProperty(kPositionMs, 0.0)));
            markersArray.add(juce::var(obj));
        }
    }

    return juce::var(markersArray);
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
        // Only emit heightPx when explicitly set; the renderer falls
        // back to its own default for tracks that have never been
        // resized so older projects survive without backfilling.
        if (track.hasProperty(kHeightPx))
        {
            trackObj->setProperty("heightPx", static_cast<double>(track.getProperty(kHeightPx, 0.0)));
        }

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
            const juce::String libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
            clipObj->setProperty("libraryItemId", libraryItemId);
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
            if (clip.hasProperty(kClipName))
            {
                clipObj->setProperty("name", clip.getProperty(kClipName).toString());
            }
            // Resolve the source file through the linked library item so
            // the renderer can flag clips whose underlying file went
            // missing since the project was last saved. An empty library
            // item id (defensive — shouldn't happen) is also treated as
            // unresolved.
            const juce::String resolvedFilePath = getLibraryItemFilePath(libraryItemId);
            const bool unresolved =
                libraryItemId.isEmpty() || resolvedFilePath.isEmpty() || !juce::File(resolvedFilePath).existsAsFile();
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
    // Ensure the standard container children exist even if the loaded
    // project file pre-dates them, so subsequent add+remove cycles
    // round-trip cleanly against the clean-snapshot baseline.
    if (!root.getChildWithName(kLibrary).isValid())
    {
        root.appendChild(juce::ValueTree(kLibrary), nullptr);
    }
    if (!root.getChildWithName(kMarkers).isValid())
    {
        root.appendChild(juce::ValueTree(kMarkers), nullptr);
    }
    undoManager.clearUndoHistory();
    suppressDirtyTransitions = false;
    // A load is by definition clean (in-memory state matches disk).
    // Emit a single dirty=false transition if we were dirty going in.
    markClean();
    return juce::Result::ok();
}

} // namespace silverdaw
