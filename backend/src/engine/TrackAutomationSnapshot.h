#pragma once

#include "BreakpointCurve.h"

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Automatable track parameter ids (must match the bridge `paramId` strings).
enum class AutomationParam
{
    filter,
    pan,
    toneBass,
    toneMid,
    toneTreble,
    reverbSend,
    delaySend,
    leveler,
    punch,
    saturationDrive,
    saturationMix,
    bitCrusherRate,
    bitCrusherBits,
    bitCrusherBoost,
    bitCrusherMix,
    level,
    count_
};

inline bool automationParamFromString(const juce::String& id, AutomationParam& out) noexcept
{
    if (id == "filter") { out = AutomationParam::filter; return true; }
    if (id == "pan") { out = AutomationParam::pan; return true; }
    if (id == "toneBass") { out = AutomationParam::toneBass; return true; }
    if (id == "toneMid") { out = AutomationParam::toneMid; return true; }
    if (id == "toneTreble") { out = AutomationParam::toneTreble; return true; }
    if (id == "reverbSend") { out = AutomationParam::reverbSend; return true; }
    if (id == "delaySend") { out = AutomationParam::delaySend; return true; }
    if (id == "leveler") { out = AutomationParam::leveler; return true; }
    if (id == "punch") { out = AutomationParam::punch; return true; }
    if (id == "saturationDrive") { out = AutomationParam::saturationDrive; return true; }
    if (id == "saturationMix") { out = AutomationParam::saturationMix; return true; }
    if (id == "bitCrusherRate") { out = AutomationParam::bitCrusherRate; return true; }
    if (id == "bitCrusherBits") { out = AutomationParam::bitCrusherBits; return true; }
    if (id == "bitCrusherBoost") { out = AutomationParam::bitCrusherBoost; return true; }
    if (id == "bitCrusherMix") { out = AutomationParam::bitCrusherMix; return true; }
    if (id == "level") { out = AutomationParam::level; return true; }
    return false;
}

// Immutable per-track automation: one optional BreakpointCurve per automatable
// parameter. Built on the message thread, published by raw pointer to the audio
// thread (see `AudioEngine`'s ownership + retire queue). Never mutate after build.
struct TrackAutomationSnapshot
{
    static constexpr int kNumParams = static_cast<int>(AutomationParam::count_);

    bool has[kNumParams] = {};
    BreakpointCurve curves[kNumParams];

    bool hasAny() const noexcept
    {
        for (bool h : has)
            if (h) return true;
        return false;
    }

    bool hasParam(AutomationParam p) const noexcept { return has[static_cast<int>(p)]; }
    const BreakpointCurve& curve(AutomationParam p) const noexcept
    {
        return curves[static_cast<int>(p)];
    }
};

} // namespace silverdaw
