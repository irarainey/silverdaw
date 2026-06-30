#include "ProjectState.h"

#include <cmath>
#include <algorithm>
#include <functional>

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
    out.warpActive = std::abs(out.tempoRatio - 1.0) > 1.0e-4;
    if (out.warpActive)
    {
        out.durationMs = out.durationMs / out.tempoRatio;
    }
    return out;
}

double ProjectState::getLibraryItemBpm(const juce::String& itemId) const
{
    const auto library = root.getChildWithName(kLibrary);
    if (!library.isValid()) return 0.0;
    juce::String sourceItemId;
    for (int i = 0; i < library.getNumChildren(); ++i)
    {
        const auto item = library.getChild(i);
        if (item.getProperty(kId).toString() == itemId)
        {
            const auto bpm = static_cast<double>(item.getProperty(kBpm, 0.0));
            if (bpm > 0.0) return bpm;
            sourceItemId = item.getProperty(kSourceItemId, {}).toString();
            break;
        }
    }
    if (sourceItemId.isNotEmpty())
    {
        for (int i = 0; i < library.getNumChildren(); ++i)
        {
            const auto item = library.getChild(i);
            if (item.getProperty(kId).toString() == sourceItemId)
            {
                return static_cast<double>(item.getProperty(kBpm, 0.0));
            }
        }
    }
    return 0.0;
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
} // namespace silverdaw
