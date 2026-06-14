#include "ProjectState.h"
#include "ProjectStatePropertyHelpers.h"

#include <cmath>

namespace silverdaw
{

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

bool ProjectState::moveTrack(const juce::String& trackId, int newIndex)
{
    // Visible track order ignores sibling LIBRARY/MARKERS nodes.
    int currentIndex = -1;
    int trackChildCount = 0;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto child = root.getChild(i);
        if (!child.hasType(kTrack))
            continue;
        if (child.getProperty(kId).toString() == trackId)
            currentIndex = i;
        ++trackChildCount;
    }
    if (currentIndex < 0 || trackChildCount <= 1)
        return false;
    // Translate track-ordinal index back to ValueTree child index.
    const int clampedOrdinal = juce::jlimit(0, trackChildCount - 1, newIndex);
    int absoluteTarget = -1;
    int seen = 0;
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        if (!root.getChild(i).hasType(kTrack))
            continue;
        if (seen == clampedOrdinal)
        {
            absoluteTarget = i;
            break;
        }
        ++seen;
    }
    if (absoluteTarget < 0 || absoluteTarget == currentIndex)
        return false;
    root.moveChild(currentIndex, absoluteTarget, &undoManager);
    return true;
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

bool ProjectState::getTrackMuted(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kMuted, false));
}

bool ProjectState::getTrackSoloed(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kSoloed, false));
}

bool ProjectState::anyTrackSoloed() const
{
    for (int i = 0; i < root.getNumChildren(); ++i)
    {
        const auto track = root.getChild(i);
        if (!track.hasType(kTrack)) continue;
        if (static_cast<bool>(track.getProperty(kSoloed, false))) return true;
    }
    return false;
}

float ProjectState::getEffectiveTrackGain(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0F;
    const bool muted = static_cast<bool>(track.getProperty(kMuted, false));
    if (muted) return 0.0F;
    const bool soloed = static_cast<bool>(track.getProperty(kSoloed, false));
    if (anyTrackSoloed() && !soloed) return 0.0F;
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

bool ProjectState::setTrackMuted(const juce::String& trackId, bool muted)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    if (muted)
    {
        track.setProperty(kMuted, true, &undoManager);
    }
    else
    {
        // False is suppressed to avoid persisted `muted:false` noise.
        track.removeProperty(kMuted, &undoManager);
    }
    return true;
}

bool ProjectState::setTrackSoloed(const juce::String& trackId, bool soloed)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    if (soloed)
    {
        track.setProperty(kSoloed, true, &undoManager);
    }
    else
    {
        track.removeProperty(kSoloed, &undoManager);
    }
    return true;
}

// Must match renderer resize limits (MIN_TRACK_HEIGHT / MAX_TRACK_HEIGHT) so the
// backend rejects out-of-range heights. The minimum is the smallest row that
// still fits the stacked header controls without overlap.
static constexpr double kMinTrackHeightPx = 80.0;
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


static constexpr float kSendEpsilon = 1.0e-4f;

static bool nearlyZero(float value) noexcept
{
    return std::abs(value) < kSendEpsilon;
}

static bool nearlyEqual(float a, float b) noexcept
{
    return std::abs(a - b) < kSendEpsilon;
}

// `absent == 0` keeps default sends out of persisted shape.
static bool applyClampedSend(juce::ValueTree& track,
                             const juce::Identifier& id,
                             float value,
                             juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(0.0f, 1.0f, value);
    const bool hadProperty = track.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(track.getProperty(id)))
        : 0.0f;

    if (nearlyZero(clamped))
    {
        if (!hadProperty)
        {
            return false;
        }
        track.removeProperty(id, undo);
        return true;
    }

    if (hadProperty && nearlyEqual(previous, clamped))
    {
        return false;
    }
    track.setProperty(id, clamped, undo);
    return true;
}

bool ProjectState::setTrackSends(const juce::String& trackId, float reverbSend, float delaySend)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    const bool reverbChanged = applyClampedSend(track, kSendReverb, reverbSend, &undoManager);
    const bool delayChanged = applyClampedSend(track, kSendDelay, delaySend, &undoManager);
    return reverbChanged || delayChanged;
}

float ProjectState::getTrackReverbSend(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0f;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kSendReverb, 0.0)));
}

float ProjectState::getTrackDelaySend(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0f;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kSendDelay, 0.0)));
}

// Near-centre pan is suppressed so legacy projects round-trip byte-clean.
static constexpr float kPanEpsilon = 1.0e-4f;

static bool applyClampedPan(juce::ValueTree& track,
                            const juce::Identifier& id,
                            float value,
                            juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(-1.0f, 1.0f, std::isfinite(value) ? value : 0.0f);
    const bool hadProperty = track.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(track.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < kPanEpsilon)
    {
        if (!hadProperty)
        {
            return false;
        }
        track.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < kPanEpsilon)
    {
        return false;
    }
    track.setProperty(id, clamped, undo);
    return true;
}

bool ProjectState::setTrackPan(const juce::String& trackId, float pan)
{
    auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return false;
    }
    return applyClampedPan(track, kPan, pan, &undoManager);
}

float ProjectState::getTrackPan(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid())
    {
        return 0.0f;
    }
    return static_cast<float>(static_cast<double>(track.getProperty(kPan, 0.0)));
}

// Default suppression lets dispatchers skip ack/undo/dirty on no-op writes.

// Epsilons sit below perceptible or renderer-visible resolution.
static constexpr float kToneDbEpsilon = 1.0e-3f;
static constexpr float kLevelerEpsilon = 1.0e-4f;

static bool applyClampedDb(juce::ValueTree& tree,
                           const juce::Identifier& id,
                           float value,
                           juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(-15.0f, 15.0f, value);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < kToneDbEpsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < kToneDbEpsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

// Bipolar Filter sweep in [-1, +1]; the centre (0) is the off default and is
// suppressed so flat tracks stay byte-clean, mirroring the dB-band suppression.
static constexpr float kToneFilterEpsilon = 1.0e-4f;

static bool applyClampedFilter(juce::ValueTree& tree,
                               const juce::Identifier& id,
                               float value,
                               juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(-1.0f, 1.0f, std::isfinite(value) ? value : 0.0f);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < kToneFilterEpsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < kToneFilterEpsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

bool ProjectState::setTrackTone(const juce::String& trackId, float bassDb, float midDb,
                                float trebleDb, float filter)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    bool changed = false;
    changed |= applyClampedDb(track, kToneBassDb, bassDb, &undoManager);
    changed |= applyClampedDb(track, kToneMidDb, midDb, &undoManager);
    changed |= applyClampedDb(track, kToneTrebleDb, trebleDb, &undoManager);
    changed |= applyClampedFilter(track, kToneFilter, filter, &undoManager);
    return changed;
}

float ProjectState::getTrackToneBassDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneBassDb, 0.0)));
}

float ProjectState::getTrackToneMidDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneMidDb, 0.0)));
}

float ProjectState::getTrackToneTrebleDb(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneTrebleDb, 0.0)));
}

float ProjectState::getTrackToneFilter(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kToneFilter, 0.0)));
}

bool ProjectState::setTrackLevelerAmount(const juce::String& trackId, float amount)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return applyUnitFloat(track, kLevelerAmount, amount, kLevelerEpsilon, &undoManager);
}

float ProjectState::getTrackLevelerAmount(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0f;
    return static_cast<float>(static_cast<double>(track.getProperty(kLevelerAmount, 0.0)));
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

} // namespace silverdaw
