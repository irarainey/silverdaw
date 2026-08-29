#include "ProjectState.h"
#include "Log.h"

#include <cmath>
#include <algorithm>
#include <functional>
#include <set>

namespace silverdaw
{

// Parameter order follows the bridge envelope, so the swappable-string warning is intentional.
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
    // Re-parenting preserves the same ValueTree node and sub-properties.
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
    // Repeated dirty writes coalesce because setDirty(true) is idempotent.
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
        // Negative restores host-track colour inheritance.
        clip.removeProperty(kColorIndex, &undoManager);
    }
    else
    {
        clip.setProperty(kColorIndex, colorIndex, &undoManager);
    }
    return true;
}

bool ProjectState::setClipLocked(const juce::String& clipId, bool locked)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (locked)
    {
        clip.setProperty(kLocked, true, &undoManager);
    }
    else
    {
        // Absent means unlocked on disk and wire.
        clip.removeProperty(kLocked, &undoManager);
    }
    return true;
}

bool ProjectState::isClipLocked(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    return static_cast<bool>(clip.getProperty(kLocked, false));
}

bool ProjectState::setClipReversed(const juce::String& clipId, bool reversed)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (reversed)
    {
        clip.setProperty(kReversed, true, &undoManager);
    }
    else
    {
        // Absent means forward on disk and wire.
        clip.removeProperty(kReversed, &undoManager);
    }
    return true;
}

bool ProjectState::isClipReversed(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    return static_cast<bool>(clip.getProperty(kReversed, false));
}

bool ProjectState::setClipBeatOffset(const juce::String& clipId, double beatOffsetMs)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (std::isfinite(beatOffsetMs) && std::abs(beatOffsetMs) > 1.0e-6)
    {
        clip.setProperty(kBeatOffsetMs, beatOffsetMs, &undoManager);
    }
    else
    {
        // Absent means the unshifted source grid on disk and wire.
        clip.removeProperty(kBeatOffsetMs, &undoManager);
    }
    return true;
}

double ProjectState::getClipBeatOffset(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return 0.0;
    return static_cast<double>(clip.getProperty(kBeatOffsetMs, 0.0));
}

bool ProjectState::setClipBrake(const juce::String& clipId, bool brake)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (brake)
    {
        clip.setProperty(kBrake, true, &undoManager);
        clip.removeProperty(kBackspin, &undoManager);
    }
    else
    {
        // Absent means no brake on disk and wire.
        clip.removeProperty(kBrake, &undoManager);
    }
    return true;
}

bool ProjectState::isClipBrake(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    return static_cast<bool>(clip.getProperty(kBrake, false));
}

bool ProjectState::setClipBackspin(const juce::String& clipId, bool backspin)
{
    auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return false;
    }
    if (backspin)
    {
        clip.setProperty(kBackspin, true, &undoManager);
        clip.removeProperty(kBrake, &undoManager);
    }
    else
    {
        clip.removeProperty(kBackspin, &undoManager);
    }
    return true;
}

bool ProjectState::isClipBackspin(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    return static_cast<bool>(clip.getProperty(kBackspin, false));
}

bool ProjectState::setClipScratchPatternId(const juce::String& clipId, const juce::String& patternId)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;

    if (patternId.isEmpty())
    {
        clip.removeProperty(kScratchPatternId, &undoManager);
    }
    else
    {
        clip.setProperty(kScratchPatternId, patternId, &undoManager);
    }
    return true;
}

juce::String ProjectState::getClipScratchPatternId(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return clip.getProperty(kScratchPatternId, {}).toString();
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

void ProjectState::forEachWarpClip(const std::function<void(const WarpClipInfo&)>& visitor) const
{
    if (!visitor) return;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip)) continue;
            WarpClipInfo info;
            info.clipId = clip.getProperty(kId).toString();
            info.libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
            info.warpEnabled = static_cast<bool>(clip.getProperty(kWarpEnabled, false));
            info.tempoRatioPinned = clip.hasProperty(kTempoRatio);
            info.tempoRatio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
            info.semitones = static_cast<double>(clip.getProperty(kSemitones, 0.0));
            info.cents = static_cast<double>(clip.getProperty(kCents, 0.0));
            info.warpMode = clip.getProperty(kWarpMode, "rhythmic").toString();
            info.pendingAutoWarp = static_cast<bool>(clip.getProperty(kPendingAutoWarp, false));
            visitor(info);
        }
    }
}

int ProjectState::retimeClipsForTempoChange(double previousBpm, double newBpm,
                                            const std::function<void(const juce::String&, double)>& moved)
{
    if (previousBpm <= 0.0 || newBpm <= 0.0 || previousBpm == newBpm) return 0;
    const double scale = previousBpm / newBpm;
    int count = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            auto clip = track.getChild(c);
            if (!clip.hasType(kClip)) continue;
            const double offsetMs = static_cast<double>(clip.getProperty(kOffsetMs, 0.0));
            // A clip at zero is already on bar 1; scaling it is a no-op either way.
            if (offsetMs <= 0.0) continue;
            const double next = offsetMs * scale;
            // Part of the same undoable "Change tempo" transaction as the BPM itself,
            // so one undo restores both the tempo and the arrangement.
            clip.setProperty(kOffsetMs, next, &undoManager);
            ++count;
            if (moved) moved(clip.getProperty(kId).toString(), next);
        }
    }
    if (count > 0) markDirty();
    return count;
}

ProjectState::EffectiveClipTiming ProjectState::getClipEffectiveTiming(const juce::String& clipId) const
{
    EffectiveClipTiming out;
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return out;

    out.durationMs = static_cast<double>(clip.getProperty(kDurationMs, 0.0));
    if (!static_cast<bool>(clip.getProperty(kWarpEnabled, false)))
    {
        return out;
    }

    double ratio = 1.0;
    if (clip.hasProperty(kTempoRatio))
    {
        ratio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
    }
    else
    {
        const auto libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
        const double sourceBpm = getLibraryItemBpm(libraryItemId);
        const double projectBpm = getBpm();
        if (sourceBpm > 0.0 && projectBpm > 0.0)
        {
            ratio = projectBpm / sourceBpm;
        }
    }

    out.tempoRatio = ratio > 0.0 ? ratio : 1.0;
    // Whether a warp is doing anything is a question about this clip, not about the
    // ratio: a flat epsilon is duration-blind, so a stem warped from 94.0446 to 94.05
    // BPM read as inactive while the engine was already stretching it, and the timeline
    // then drew it at native length, hid the WARP badge, and spaced its beat markers to
    // the wrong grid. Judge it on the drift the ratio produces across the clip instead.
    // Mirrored by the renderer's `isWarpActive` (ADR 0024).
    const double stretchedMs = out.durationMs / out.tempoRatio;
    out.warpActive = out.durationMs > 0.0
                         ? std::abs(stretchedMs - out.durationMs) >= kWarpNegligibleDriftMs
                         // Length not known yet (a clip warped before its audio landed):
                         // fall back to the ratio, matching the renderer's "can't tell, so
                         // treat it as warped" rather than reporting a stretch as inactive.
                         : std::abs(out.tempoRatio - 1.0) > 1.0e-9;
    if (out.warpActive)
    {
        out.durationMs = stretchedMs;
    }
    return out;
}

std::optional<ProjectState::ClipPreparationInfo>
ProjectState::getClipPreparationInfo(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid())
    {
        return std::nullopt;
    }

    ClipPreparationInfo result;
    result.clipId = clipId;
    result.libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
    result.sourcePath = getLibraryItemPlaybackPath(result.libraryItemId);
    if (result.sourcePath.isEmpty())
    {
        result.sourcePath = clip.getProperty(kFilePath, {}).toString();
    }
    result.inMs = static_cast<double>(clip.getProperty(kInMs, 0.0));
    result.durationMs = static_cast<double>(clip.getProperty(kDurationMs, 0.0));
    result.reversed = static_cast<bool>(clip.getProperty(kReversed, false));
    result.warpEnabled = static_cast<bool>(clip.getProperty(kWarpEnabled, false));
    result.warpMode = clip.getProperty(kWarpMode, "rhythmic").toString();
    result.semitones = static_cast<double>(clip.getProperty(kSemitones, 0.0));
    result.cents = static_cast<double>(clip.getProperty(kCents, 0.0));
    if (clip.hasProperty(kTempoRatio))
    {
        result.tempoRatio = static_cast<double>(clip.getProperty(kTempoRatio, 1.0));
    }
    else if (result.warpEnabled)
    {
        const auto sourceBpm = getLibraryItemBpm(result.libraryItemId);
        const auto projectBpm = getBpm();
        if (sourceBpm > 0.0 && projectBpm > 0.0)
        {
            result.tempoRatio = projectBpm / sourceBpm;
        }
    }
    if (result.sourcePath.isEmpty() || result.durationMs <= 0.0)
    {
        return std::nullopt;
    }
    return result;
}

std::optional<ProjectState::ClipPreparationInfo>
ProjectState::getLibraryItemPreparationInfo(const juce::String& libraryItemId) const
{
    if (libraryItemId.isEmpty())
    {
        return std::nullopt;
    }
    ClipPreparationInfo result;
    result.clipId = libraryItemId;
    result.libraryItemId = libraryItemId;
    result.sourcePath = getLibraryItemPlaybackPath(libraryItemId);
    if (result.sourcePath.isEmpty())
    {
        result.sourcePath = getLibraryItemFilePath(libraryItemId);
    }
    result.inMs = 0.0;
    result.durationMs = getLibraryItemDurationMs(libraryItemId);
    // Saved clips carry no audio of their own: their playback path is the source
    // file, windowed by sourceInMs/sourceDurationMs. Scratch that same window so
    // the prepared audio matches the clip rather than the head of the source.
    const auto library = root.getChildWithName(kLibrary);
    if (library.isValid())
    {
        for (int i = 0; i < library.getNumChildren(); ++i)
        {
            const auto item = library.getChild(i);
            if (item.getProperty(kId).toString() != libraryItemId) continue;
            if (item.getProperty(kKind).toString() == "clip")
            {
                result.inMs = static_cast<double>(item.getProperty(kSourceInMs, 0.0));
                const auto windowMs =
                    static_cast<double>(item.getProperty(kSourceDurationMs, 0.0));
                if (windowMs > 0.0) result.durationMs = windowMs;
            }
            break;
        }
    }
    result.reversed = false;
    result.warpEnabled = false;
    result.warpMode = "rhythmic";
    result.tempoRatio = 1.0;
    result.semitones = 0.0;
    result.cents = 0.0;
    if (result.sourcePath.isEmpty() || result.durationMs <= 0.0)
    {
        return std::nullopt;
    }
    return result;
}

// The single backend resolver for an item's ORIGINAL BPM, mirroring the renderer's
// `libraryItemSourceBpm`. An item has exactly one original tempo and the two
// processes must never derive their own version: when they drifted, a clip could be
// drawn stretched while the engine played it unwarped.
//
// Delegates to `resolveTempoOwner` so the rules live in exactly one place; this
// overload is the hot, "what tempo?" question that playback and drawing ask.
double ProjectState::getLibraryItemBpm(const juce::String& itemId) const
{
    return resolveTempoOwner(itemId).bpm;
}

// Resolves ADR 0024's rules in order, and records which one answered. See the header
// for why the owner and the reason are needed alongside the value.
ProjectState::TempoOwner ProjectState::resolveTempoOwner(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return {};

    // A chain is normally one or two links (import -> saved clip -> sample), but a
    // corrupt or hand-edited project could close it into a loop. Walking a cycle here
    // would hang the message thread, so every visited id is remembered.
    std::set<juce::String> visited;
    juce::String currentId = itemId;
    bool isOriginalItem = true;

    while (currentId.isNotEmpty())
    {
        if (!visited.insert(currentId).second)
        {
            silverdaw::log::warn("project",
                                 "resolveTempoOwner found a derivation cycle at itemId=" + currentId
                                     + " — treating the item as having no tempo");
            return {};
        }

        juce::ValueTree item;
        for (int i = 0; i < library.getNumChildren(); ++i)
        {
            const auto candidate = library.getChild(i);
            if (candidate.getProperty(kId).toString() == currentId)
            {
                item = candidate;
                break;
            }
        }
        // A broken link is not an error: the chain simply has no owner to reach.
        if (!item.isValid()) return {};

        // Answer "is this a one-shot?" before resolving any tempo, and answer it the way
        // the renderer's `libraryItemIsSimple` does — by inheritance. Left to the
        // fallback below, an unclassified cut of a one-shot that carries a detected BPM
        // of its own would resolve to that BPM here while the renderer resolved to
        // nothing: the clip played stretched and drawn native, which is exactly the split
        // ADR 0024 exists to prevent. A one-shot anywhere in the chain ends the walk,
        // because an ancestor with no tempo has none to pass down.
        if (isOneShotItemInherited(item, library)) return {{}, TempoReason::oneShot, 0.0};

        // A recorded musical length is a measurement of the audio itself ("this file is
        // exactly N beats"), so it outranks any tempo opinion — including a reanalysis,
        // whose few seconds of audio are exactly what makes short saved samples
        // mis-detect. Keeping the grid and the warp on the same number is what stops a
        // clip being drawn to one tempo and played at another (ADR 0024).
        //
        // Only the item the caller asked about may answer this way. An ancestor's
        // musical length describes the ancestor's file, not this one, and the pre-existing
        // single-hop lookup likewise read only the parent's raw `bpm`.
        if (isOriginalItem)
        {
            if (const auto fromLength = musicalLengthBpm(item); fromLength > 0.0)
            {
                return {currentId, TempoReason::musicalLength, fromLength};
            }
        }

        if (const auto bpm = static_cast<double>(item.getProperty(kBpm, 0.0)); bpm > 0.0)
        {
            return {currentId, isOriginalItem ? TempoReason::ownBpm : TempoReason::inheritedBpm, bpm};
        }

        currentId = item.getProperty(kSourceItemId, {}).toString();
        isOriginalItem = false;
    }

    return {};
}

bool ProjectState::setClipWarp(const juce::String& clipId,
                               std::optional<bool> warpEnabled,
                               std::optional<juce::String> warpMode,
                               std::optional<double> tempoRatio,
                               bool tempoRatioClear,
                               std::optional<double> semitones,
                               std::optional<double> cents,
                               std::optional<bool> pendingAutoWarp)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;
    if (warpEnabled.has_value())
    {
        clip.setProperty(kWarpEnabled, *warpEnabled, &undoManager);
    }
    if (warpMode.has_value() && warpMode->isNotEmpty())
    {
        // Bridge validation makes mode strings trustworthy here.
        clip.setProperty(kWarpMode, *warpMode, &undoManager);
    }
    if (tempoRatioClear)
    {
        clip.removeProperty(kTempoRatio, &undoManager);
    }
    else if (tempoRatio.has_value())
    {
        // Clamp tempo ratio so hostile payloads cannot ask Rubber Band for extreme stretches.
        const auto clamped = juce::jlimit(0.25, 4.0, *tempoRatio);
        clip.setProperty(kTempoRatio, clamped, &undoManager);
    }
    if (semitones.has_value())
    {
        const auto clamped = juce::jlimit(-24.0, 24.0, *semitones);
        clip.setProperty(kSemitones, clamped, &undoManager);
    }
    if (cents.has_value())
    {
        const auto clamped = juce::jlimit(-100.0, 100.0, *cents);
        clip.setProperty(kCents, clamped, &undoManager);
    }
    if (pendingAutoWarp.has_value())
    {
        if (*pendingAutoWarp)
        {
            clip.setProperty(kPendingAutoWarp, true, &undoManager);
        }
        else
        {
            clip.removeProperty(kPendingAutoWarp, &undoManager);
        }
    }
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
    // Linked library item is authoritative; legacy clips may still carry filePath.
    const juce::String libraryItemId = clip.getProperty(kLibraryItemId, {}).toString();
    if (libraryItemId.isNotEmpty())
    {
        const auto path = getLibraryItemFilePath(libraryItemId);
        if (path.isNotEmpty()) return path;
    }
    return clip.getProperty(kFilePath, {}).toString();
}


static juce::Array<juce::var> readEnvelopeArray(const juce::ValueTree& clip,
                                                const juce::Identifier& id)
{
    if (!clip.hasProperty(id)) return {};
    const auto& v = clip.getProperty(id);
    if (!v.isArray()) return {};
    return *v.getArray();
}

static bool envelopeArraysSemanticallyEqual(const juce::Array<juce::var>& a,
                                            const juce::Array<juce::var>& b,
                                            const juce::Identifier& timeId,
                                            const juce::Identifier& gainId)
{
    if (a.size() != b.size()) return false;
    for (int i = 0; i < a.size(); ++i)
    {
        const double ta = static_cast<double>(a.getReference(i).getProperty(timeId, 0.0));
        const double tb = static_cast<double>(b.getReference(i).getProperty(timeId, 0.0));
        const double ga = static_cast<double>(a.getReference(i).getProperty(gainId, 1.0));
        const double gb = static_cast<double>(b.getReference(i).getProperty(gainId, 1.0));
        if (std::abs(ta - tb) > 1.0e-3 || std::abs(ga - gb) > 1.0e-4) return false;
    }
    return true;
}

bool ProjectState::setClipEnvelope(const juce::String& clipId,
                                   const juce::Array<juce::var>& points)
{
    auto clip = findClip(clipId);
    if (!clip.isValid()) return false;

    // Normalise envelopes so default/duplicate shapes do not pollute persisted state.
    juce::Array<juce::var> normalised;
    normalised.ensureStorageAllocated(points.size());
    for (const auto& p : points)
    {
        if (!p.isObject()) return false;
        const double t = static_cast<double>(p.getProperty(kEnvelopeTimeMs, 0.0));
        const double g = static_cast<double>(p.getProperty(kEnvelopeGain, 1.0));
        const double clampedTime = juce::jmax(0.0, t);
        const double clampedGain = juce::jlimit(0.0, 4.0, g);
        auto* obj = new juce::DynamicObject();
        obj->setProperty(kEnvelopeTimeMs, clampedTime);
        obj->setProperty(kEnvelopeGain, clampedGain);
        normalised.add(juce::var(obj));
    }
    std::sort(normalised.begin(), normalised.end(),
              [](const juce::var& a, const juce::var& b) {
                  return static_cast<double>(a.getProperty("timeMs", 0.0)) <
                         static_cast<double>(b.getProperty("timeMs", 0.0));
              });
    for (int i = 1; i < normalised.size(); ++i)
    {
        const double prev = static_cast<double>(normalised.getReference(i - 1).getProperty(kEnvelopeTimeMs, 0.0));
        const double curr = static_cast<double>(normalised.getReference(i).getProperty(kEnvelopeTimeMs, 0.0));
        if (std::abs(curr - prev) < 1.0e-3) return false; // duplicate timeMs
    }

    const auto existing = readEnvelopeArray(clip, kEnvelopePoints);
    if (normalised.isEmpty())
    {
        if (!clip.hasProperty(kEnvelopePoints)) return false;
        clip.removeProperty(kEnvelopePoints, &undoManager);
        return true;
    }
    if (envelopeArraysSemanticallyEqual(existing, normalised, kEnvelopeTimeMs, kEnvelopeGain))
    {
        return false;
    }
    clip.setProperty(kEnvelopePoints, juce::var(normalised), &undoManager);
    return true;
}

juce::Array<juce::var> ProjectState::getClipEnvelope(const juce::String& clipId) const
{
    const auto clip = findClip(clipId);
    if (!clip.isValid()) return {};
    return readEnvelopeArray(clip, kEnvelopePoints);
}

// Counted from effective (warp-scaled) length, not stored duration: a correction changes
// exactly that scaling, so a clip can end past the project length without any stored
// property of it having moved. The project length is independent and deliberately not
// auto-updated, so this is reported rather than fixed (ADR 0027).
int ProjectState::countClipsEndingAfter(double lengthMs) const
{
    if (lengthMs <= 0.0) return 0;
    int count = 0;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip)) continue;
            const auto clipId = clip.getProperty(kId).toString();
            const double startMs = static_cast<double>(clip.getProperty(kOffsetMs, 0.0));
            if (startMs + getClipEffectiveTiming(clipId).durationMs > lengthMs) ++count;
        }
    }
    return count;
}

std::unordered_map<juce::String, double> ProjectState::snapshotClipFootprints() const
{
    std::unordered_map<juce::String, double> out;
    for (int t = 0; t < root.getNumChildren(); ++t)
    {
        const auto track = root.getChild(t);
        if (!track.hasType(kTrack)) continue;
        for (int c = 0; c < track.getNumChildren(); ++c)
        {
            const auto clip = track.getChild(c);
            if (!clip.hasType(kClip)) continue;
            // Only clips carrying a shape can need retiming, and the map is only ever
            // read for those, so skip the rest rather than measure the whole timeline.
            if (!clip.hasProperty(kEnvelopePoints)) continue;
            const auto clipId = clip.getProperty(kId).toString();
            out[clipId] = getClipEffectiveTiming(clipId).durationMs;
        }
    }
    return out;
}

int ProjectState::retimeClipEnvelopesForFootprintChange(
    const std::unordered_map<juce::String, double>& previousFootprints,
    const std::function<void(const juce::String&, const juce::Array<juce::var>&)>& visitor)
{
    if (previousFootprints.empty()) return 0;
    int count = 0;
    for (const auto& [clipId, before] : previousFootprints)
    {
        if (before <= 0.0) continue;
        auto clip = findClip(clipId);
        if (!clip.isValid()) continue;
        const auto points = readEnvelopeArray(clip, kEnvelopePoints);
        if (points.size() < 2) continue;

        const double after = getClipEffectiveTiming(clipId).durationMs;
        if (after <= 0.0) continue;
        const double scale = after / before;
        // Below this the shape has not measurably moved; rewriting it would only churn
        // the tree and the engine snapshot.
        if (std::abs(scale - 1.0) <= 1.0e-9) continue;

        juce::Array<juce::var> scaled;
        scaled.ensureStorageAllocated(points.size());
        for (const auto& p : points)
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty(kEnvelopeTimeMs,
                             juce::jmax(0.0, static_cast<double>(
                                                 p.getProperty(kEnvelopeTimeMs, 0.0)) * scale));
            obj->setProperty(kEnvelopeGain,
                             static_cast<double>(p.getProperty(kEnvelopeGain, 1.0)));
            scaled.add(juce::var(obj));
        }
        // Part of the same undoable "Change tempo" transaction as the BPM itself.
        clip.setProperty(kEnvelopePoints, juce::var(scaled), &undoManager);
        ++count;
        if (visitor) visitor(clipId, getClipEnvelope(clipId));
    }
    if (count > 0) markDirty();
    return count;
}
} // namespace silverdaw
