#include "ProjectState.h"
#include "ProjectStatePropertyHelpers.h"

#include <cmath>

namespace silverdaw
{

static constexpr float kReverbEpsilon = 1.0e-4f;
static constexpr float kDelayEpsilon = 1.0e-4f;

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

} // namespace silverdaw
