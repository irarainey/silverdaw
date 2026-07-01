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
const juce::Identifier ProjectState::kMuted{"muted"};
const juce::Identifier ProjectState::kSoloed{"soloed"};
const juce::Identifier ProjectState::kHeightPx{"heightPx"};
const juce::Identifier ProjectState::kFilePath{"filePath"};
const juce::Identifier ProjectState::kOffsetMs{"offsetMs"};
const juce::Identifier ProjectState::kInMs{"inMs"};
const juce::Identifier ProjectState::kDurationMs{"durationMs"};
const juce::Identifier ProjectState::kSampleRate{"sampleRate"};
const juce::Identifier ProjectState::kChannelCount{"channelCount"};
const juce::Identifier ProjectState::kColorIndex{"colorIndex"};
const juce::Identifier ProjectState::kLocked{"locked"};
const juce::Identifier ProjectState::kReversed{"reversed"};
const juce::Identifier ProjectState::kBrake{"brake"};
const juce::Identifier ProjectState::kBackspin{"backspin"};
const juce::Identifier ProjectState::kViewPxPerSecond{"viewPxPerSecond"};
const juce::Identifier ProjectState::kViewScrollX{"viewScrollX"};
const juce::Identifier ProjectState::kViewSelectedTrack{"viewSelectedTrack"};
const juce::Identifier ProjectState::kViewFxPanelOpen{"viewFxPanelOpen"};
const juce::Identifier ProjectState::kPlayheadMs{"playheadMs"};
const juce::Identifier ProjectState::kBpm{"bpm"};
const juce::Identifier ProjectState::kBpmSeeded{"bpmSeeded"};
const juce::Identifier ProjectState::kProjectLengthMs{"projectLengthMs"};
const juce::Identifier ProjectState::kAudioOutputTypeName{"audioOutputTypeName"};
const juce::Identifier ProjectState::kAudioOutputDeviceName{"audioOutputDeviceName"};
const juce::Identifier ProjectState::kTargetSampleRate{"targetSampleRate"};
const juce::Identifier ProjectState::kExportSettingsJson{"exportSettingsJson"};
const juce::Identifier ProjectState::kMasterVolume{"masterVolume"};
const juce::Identifier ProjectState::kBarCounterStart{"barCounterStart"};
const juce::Identifier ProjectState::kMixdownStartBar{"mixdownStartBar"};
const juce::Identifier ProjectState::kMetronomeEnabled{"metronomeEnabled"};
const juce::Identifier ProjectState::kLibrary{"LIBRARY"};
const juce::Identifier ProjectState::kLibraryItem{"ITEM"};
const juce::Identifier ProjectState::kMarkers{"MARKERS"};
const juce::Identifier ProjectState::kMarker{"MARKER"};
const juce::Identifier ProjectState::kPositionMs{"positionMs"};
const juce::Identifier ProjectState::kBeats{"beats"};
const juce::Identifier ProjectState::kBeatAnchorSec{"beatAnchorSec"};
const juce::Identifier ProjectState::kPlaybackFilePath{"playbackFilePath"};
const juce::Identifier ProjectState::kVariableTempo{"variableTempo"};
const juce::Identifier ProjectState::kLowConfidence{"lowConfidence"};
const juce::Identifier ProjectState::kAudioType{"audioType"};
const juce::Identifier ProjectState::kKey{"key"};
const juce::Identifier ProjectState::kKind{"kind"};
const juce::Identifier ProjectState::kSourceItemId{"sourceItemId"};
const juce::Identifier ProjectState::kSourceClipId{"sourceClipId"};
const juce::Identifier ProjectState::kSourceInMs{"sourceInMs"};
const juce::Identifier ProjectState::kSourceDurationMs{"sourceDurationMs"};
const juce::Identifier ProjectState::kMediaId{"mediaId"};
const juce::Identifier ProjectState::kDisplayName{"displayName"};
const juce::Identifier ProjectState::kClipName{"clipName"};
const juce::Identifier ProjectState::kCollapsed{"collapsed"};
const juce::Identifier ProjectState::kCoverArtHidden{"coverArtHidden"};
const juce::Identifier ProjectState::kCoverArtOverride{"coverArtOverride"};
const juce::Identifier ProjectState::kLibraryItemId{"libraryItemId"};
const juce::Identifier ProjectState::kWarpEnabled{"warpEnabled"};
const juce::Identifier ProjectState::kWarpMode{"warpMode"};
const juce::Identifier ProjectState::kTempoRatio{"tempoRatio"};
const juce::Identifier ProjectState::kSemitones{"semitones"};
const juce::Identifier ProjectState::kCents{"cents"};
const juce::Identifier ProjectState::kPendingAutoWarp{"pendingAutoWarp"};
const juce::Identifier ProjectState::kSendReverb{"sendReverb"};
const juce::Identifier ProjectState::kSendDelay{"sendDelay"};
const juce::Identifier ProjectState::kPan{"pan"};
const juce::Identifier ProjectState::kToneBassDb{"toneBassDb"};
const juce::Identifier ProjectState::kToneMidDb{"toneMidDb"};
const juce::Identifier ProjectState::kToneTrebleDb{"toneTrebleDb"};
const juce::Identifier ProjectState::kToneFilter{"toneFilter"};
const juce::Identifier ProjectState::kLevelerAmount{"levelerAmount"};
const juce::Identifier ProjectState::kEnvelopePoints{"envelopePoints"};
const juce::Identifier ProjectState::kEnvelopeTimeMs{"timeMs"};
const juce::Identifier ProjectState::kEnvelopeGain{"gain"};
const juce::Identifier ProjectState::kAutomation{"automation"};
const juce::Identifier ProjectState::kAutomationParamId{"paramId"};
const juce::Identifier ProjectState::kAutomationPoints{"points"};
const juce::Identifier ProjectState::kAutomationTimeMs{"timeMs"};
const juce::Identifier ProjectState::kAutomationValue{"value"};
const juce::Identifier ProjectState::kReverbSize{"reverbSize"};
const juce::Identifier ProjectState::kReverbDecay{"reverbDecay"};
const juce::Identifier ProjectState::kReverbTone{"reverbTone"};
const juce::Identifier ProjectState::kReverbMix{"reverbMix"};
const juce::Identifier ProjectState::kDelayNoteValue{"delayNoteValue"};
const juce::Identifier ProjectState::kDelayFeedback{"delayFeedback"};
const juce::Identifier ProjectState::kDelayTone{"delayTone"};
const juce::Identifier ProjectState::kDelayMix{"delayMix"};

const juce::String ProjectState::kDefaultName{"Untitled"};

ProjectState::ProjectState() : root(kProject)
{
    // Initialise before listener attach so defaults don't count as user edits.
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
    // Snapshot the new baseline so later net-zero edits can return to clean.
    cleanSnapshot = root.createCopy();
    if (dirty) setDirty(false);
}

namespace
{
// Recursively rewrite filePath/playbackFilePath properties that live under
// `oldRoot` to the matching relative location under `newRoot`. Operates on the
// shared ValueTree data in place; `node` is taken by value (a reference handle).
int rebasePathProperties(juce::ValueTree node, const juce::File& oldRoot, const juce::File& newRoot)
{
    static const juce::Identifier pathKeys[] = {juce::Identifier{"filePath"},
                                                juce::Identifier{"playbackFilePath"}};
    int rewritten = 0;
    for (const auto& key : pathKeys)
    {
        if (! node.hasProperty(key)) continue;
        const juce::String stored = node.getProperty(key).toString();
        if (stored.isEmpty() || ! juce::File::isAbsolutePath(stored)) continue;
        const juce::File current(stored);
        if (! current.isAChildOf(oldRoot)) continue;
        const auto rel = current.getRelativePathFrom(oldRoot);
        node.setProperty(key, newRoot.getChildFile(rel).getFullPathName(), nullptr);
        ++rewritten;
    }
    for (int i = 0; i < node.getNumChildren(); ++i)
        rewritten += rebasePathProperties(node.getChild(i), oldRoot, newRoot);
    return rewritten;
}
} // namespace

int ProjectState::rebaseArtifactPaths(const juce::File& oldRoot, const juce::File& newRoot)
{
    if (oldRoot.getFullPathName().isEmpty() || newRoot.getFullPathName().isEmpty())
        return 0;
    const SuppressDirtyScope suppress(*this);
    return rebasePathProperties(root, oldRoot, newRoot);
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
    // Equivalence against the clean snapshot lets net-zero edits clear dirty.
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
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildAdded(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildRemoved(juce::ValueTree& /*parent*/, juce::ValueTree& /*child*/,
                                         int /*index*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::valueTreeChildOrderChanged(juce::ValueTree& /*parent*/, int /*oldIndex*/,
                                              int /*newIndex*/)
{
    if (suppressDirtyDepth > 0) return;
    recomputeDirty();
}

void ProjectState::setNonDirtyRootProperty(const juce::Identifier& id, const juce::var& value)
{
    // Mirror into cleanSnapshot so non-edit state cannot create phantom dirty deltas.
    const SuppressDirtyScope suppress(*this);
    root.setProperty(id, value, nullptr);
    if (cleanSnapshot.isValid())
        cleanSnapshot.setProperty(id, value, nullptr);
}

bool ProjectState::mutateDerivedLibraryItem(
    const juce::String& itemId,
    const std::function<void(juce::ValueTree&)>& mutator)
{
    auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return false;

    juce::ValueTree liveItem;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            liveItem = item;
            break;
        }
    }
    if (!liveItem.isValid()) return false;

    // Suppress both live and mirror writes because descendant listeners mark dirty.
    const SuppressDirtyScope suppress(*this);
    mutator(liveItem);

    if (cleanSnapshot.isValid())
    {
        auto snapLibrary = cleanSnapshot.getChildWithName(kLibrary);
        if (snapLibrary.isValid())
        {
            for (int i = 0; i < snapLibrary.getNumChildren(); ++i)
            {
                auto snapItem = snapLibrary.getChild(i);
                if (snapItem.getProperty(kId).toString() == itemId)
                {
                    mutator(snapItem);
                    break;
                }
            }
        }
    }
    return true;
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

} // namespace silverdaw
