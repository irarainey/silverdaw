#include "ProjectState.h"
#include "ProjectStatePropertyHelpers.h"
#include "dsp/BitCrusherParameters.h"

#include <cmath>

namespace silverdaw
{
namespace
{
bool applyBitCrusherBits(juce::ValueTree& tree, const juce::Identifier& id, double value,
                         juce::UndoManager* undo)
{
    constexpr int defaultBits = bit_crusher::kMaxBits;
    const int clamped = bit_crusher::sanitizeBits(value);
    const bool hadProperty = tree.hasProperty(id);
    const int previous = hadProperty
        ? bit_crusher::sanitizeBits(static_cast<double>(tree.getProperty(id)))
        : defaultBits;
    if (clamped == defaultBits)
    {
        if (!hadProperty) return false;
        tree.removeProperty(id, undo);
        return true;
    }
    if (hadProperty && previous == clamped) return false;
    tree.setProperty(id, clamped, undo);
    return true;
}
} // namespace

bool ProjectState::setTrackBitCrusher(const juce::String& trackId, float rate, int bits,
                                      float boost, float mix)
{
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;

    constexpr float epsilon = 1.0e-4F;
    const float safeRate = bit_crusher::sanitizeRate(rate);
    const float safeBoost = bit_crusher::sanitizeUnit(boost);
    const float safeMix = bit_crusher::sanitizeUnit(mix);
    bool changed = applyUnitFloatWithDefault(track, kBitCrusherRate, safeRate, 1.0F,
                                              epsilon, &undoManager);
    changed |= applyBitCrusherBits(track, kBitCrusherBits, bits, &undoManager);
    changed |= applyUnitFloat(track, kBitCrusherBoost, safeBoost, epsilon, &undoManager);
    changed |= applyUnitFloat(track, kBitCrusherMix, safeMix, epsilon, &undoManager);
    return changed;
}

float ProjectState::getTrackBitCrusherRate(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 1.0F;
    return bit_crusher::sanitizeRate(
        static_cast<double>(track.getProperty(kBitCrusherRate, 1.0)));
}

int ProjectState::getTrackBitCrusherBits(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 16;
    return bit_crusher::sanitizeBits(
        static_cast<double>(track.getProperty(kBitCrusherBits, 16)));
}

float ProjectState::getTrackBitCrusherBoost(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0F;
    return bit_crusher::sanitizeUnit(
        static_cast<double>(track.getProperty(kBitCrusherBoost, 0.0)));
}

float ProjectState::getTrackBitCrusherMix(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return 0.0F;
    return bit_crusher::sanitizeUnit(
        static_cast<double>(track.getProperty(kBitCrusherMix, 0.0)));
}

} // namespace silverdaw
