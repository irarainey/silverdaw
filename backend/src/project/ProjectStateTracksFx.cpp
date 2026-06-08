#include "ProjectState.h"

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

// Must match renderer resize limits so backend rejects out-of-range heights.
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

// Send epsilon suppresses near-zero UI noise and keeps legacy snapshots byte-equivalent.
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
static constexpr float kReverbEpsilon = 1.0e-4f;
static constexpr float kDelayEpsilon = 1.0e-4f;

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

static bool applyUnitFloat(juce::ValueTree& tree,
                           const juce::Identifier& id,
                           float value,
                           float epsilon,
                           juce::UndoManager* undo)
{
    const auto clamped = juce::jlimit(0.0f, 1.0f, value);
    const bool hadProperty = tree.hasProperty(id);
    const auto previous = hadProperty
        ? static_cast<float>(static_cast<double>(tree.getProperty(id)))
        : 0.0f;
    if (std::abs(clamped) < epsilon)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && std::abs(previous - clamped) < epsilon) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}

static bool applyBoolDefaultFalse(juce::ValueTree& tree,
                                  const juce::Identifier& id,
                                  bool value,
                                  juce::UndoManager* undo)
{
    const bool hadProperty = tree.hasProperty(id);
    if (!value)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && static_cast<bool>(tree.getProperty(id))) return false;
    tree.setProperty(id, true, undo);
    return true;
}

bool ProjectState::setTrackTone(const juce::String& trackId, float bassDb, float midDb,
                                float trebleDb, bool lowCut, bool highCut)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    bool changed = false;
    changed |= applyClampedDb(track, kToneBassDb, bassDb, &undoManager);
    changed |= applyClampedDb(track, kToneMidDb, midDb, &undoManager);
    changed |= applyClampedDb(track, kToneTrebleDb, trebleDb, &undoManager);
    changed |= applyBoolDefaultFalse(track, kToneLowCut, lowCut, &undoManager);
    changed |= applyBoolDefaultFalse(track, kToneHighCut, highCut, &undoManager);
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

bool ProjectState::getTrackToneLowCut(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kToneLowCut, false));
}

bool ProjectState::getTrackToneHighCut(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return false;
    return static_cast<bool>(track.getProperty(kToneHighCut, false));
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

bool ProjectState::setProjectReverb(float size, float decay, float tone, float mix)
{
    bool changed = false;
    changed |= applyUnitFloat(root, kReverbSize, size, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbDecay, decay, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbTone, tone, kReverbEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kReverbMix, mix, kReverbEpsilon, &undoManager);
    return changed;
}

float ProjectState::getProjectReverbSize() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbSize, 0.0)));
}
float ProjectState::getProjectReverbDecay() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbDecay, 0.0)));
}
float ProjectState::getProjectReverbTone() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbTone, 0.0)));
}
float ProjectState::getProjectReverbMix() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kReverbMix, 0.0)));
}

// Reject unknown delay note values so hostile clients cannot persist unsupported state.
static bool isLegalDelayNoteValue(const juce::String& v)
{
    return v == "1/4" || v == "1/8" || v == "1/8T" || v == "1/16";
}

bool ProjectState::setProjectDelay(const juce::String& noteValue, float feedback,
                                   float tone, float mix)
{
    if (!isLegalDelayNoteValue(noteValue)) return false;

    bool changed = false;

    // Suppress the default note so untouched delay state stays absent.
    const bool hadNote = root.hasProperty(kDelayNoteValue);
    const auto prevNote = hadNote ? root.getProperty(kDelayNoteValue).toString() : juce::String("1/8");
    if (noteValue == "1/8")
    {
        if (hadNote) { root.removeProperty(kDelayNoteValue, &undoManager); changed = true; }
    }
    else if (!hadNote || prevNote != noteValue)
    {
        root.setProperty(kDelayNoteValue, noteValue, &undoManager);
        changed = true;
    }

    changed |= applyUnitFloat(root, kDelayFeedback, feedback, kDelayEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kDelayTone, tone, kDelayEpsilon, &undoManager);
    changed |= applyUnitFloat(root, kDelayMix, mix, kDelayEpsilon, &undoManager);
    return changed;
}

juce::String ProjectState::getProjectDelayNoteValue() const
{
    return root.getProperty(kDelayNoteValue, "1/8").toString();
}
float ProjectState::getProjectDelayFeedback() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayFeedback, 0.0)));
}
float ProjectState::getProjectDelayTone() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayTone, 0.0)));
}
float ProjectState::getProjectDelayMix() const
{
    return static_cast<float>(static_cast<double>(root.getProperty(kDelayMix, 0.0)));
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
