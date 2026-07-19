#include "ProjectState.h"
#include "dsp/BitCrusherParameters.h"
#include "dsp/SaturationParameters.h"

#include <algorithm>
#include <cmath>

namespace silverdaw
{
namespace
{

juce::Array<juce::var> readLanes(const juce::ValueTree& track, const juce::Identifier& id)
{
    if (!track.hasProperty(id)) return {};
    const auto& v = track.getProperty(id);
    if (!v.isArray()) return {};
    return *v.getArray();
}

bool pointsSemanticallyEqual(const juce::Array<juce::var>& a, const juce::Array<juce::var>& b,
                             const juce::Identifier& timeId, const juce::Identifier& valueId)
{
    if (a.size() != b.size()) return false;
    for (int i = 0; i < a.size(); ++i)
    {
        const double ta = static_cast<double>(a.getReference(i).getProperty(timeId, 0.0));
        const double tb = static_cast<double>(b.getReference(i).getProperty(timeId, 0.0));
        const double va = static_cast<double>(a.getReference(i).getProperty(valueId, 0.0));
        const double vb = static_cast<double>(b.getReference(i).getProperty(valueId, 0.0));
        if (std::abs(ta - tb) > 1.0e-3 || std::abs(va - vb) > 1.0e-4) return false;
    }
    return true;
}

bool lanesSemanticallyEqual(const juce::Array<juce::var>& a, const juce::Array<juce::var>& b,
                            const juce::Identifier& paramIdKey, const juce::Identifier& pointsKey,
                            const juce::Identifier& timeId, const juce::Identifier& valueId)
{
    if (a.size() != b.size()) return false;
    // Lane order is insertion order; compare by matching paramId rather than position.
    for (int i = 0; i < a.size(); ++i)
    {
        const juce::String pid = a.getReference(i).getProperty(paramIdKey, juce::var()).toString();
        const juce::var* match = nullptr;
        for (int j = 0; j < b.size(); ++j)
        {
            if (b.getReference(j).getProperty(paramIdKey, juce::var()).toString() == pid)
            {
                match = &b.getReference(j);
                break;
            }
        }
        if (match == nullptr) return false;
        const auto& av = a.getReference(i).getProperty(pointsKey, juce::var());
        const auto& bv = match->getProperty(pointsKey, juce::var());
        const juce::Array<juce::var> ap = av.isArray() ? *av.getArray() : juce::Array<juce::var>{};
        const juce::Array<juce::var> bp = bv.isArray() ? *bv.getArray() : juce::Array<juce::var>{};
        if (!pointsSemanticallyEqual(ap, bp, timeId, valueId)) return false;
    }
    return true;
}

double normalizeAutomationValue(const juce::String& paramId, double value)
{
    if (paramId == "saturationDrive")
        return saturation::sanitizeDrive(value);
    if (paramId == "saturationMix")
        return saturation::sanitizeMix(value);
    if (paramId == "bitCrusherRate")
        return bit_crusher::sanitizeRate(value);
    if (paramId == "bitCrusherBits")
        return bit_crusher::sanitizeBits(value);
    if (paramId == "bitCrusherBoost" || paramId == "bitCrusherMix")
        return bit_crusher::sanitizeUnit(value);
    return value;
}

} // namespace

bool ProjectState::setTrackAutomation(const juce::String& trackId, const juce::String& paramId,
                                      const juce::Array<juce::var>& points)
{
    if (paramId.isEmpty()) return false;
    auto track = findTrack(trackId);
    if (!track.isValid()) return false;

    // Normalise the incoming points: finite, time-clamped, sorted, dedup by time.
    juce::Array<juce::var> normalised;
    normalised.ensureStorageAllocated(points.size());
    for (const auto& p : points)
    {
        if (!p.isObject()) return false;
        const double t = static_cast<double>(p.getProperty(kAutomationTimeMs, 0.0));
        const double val = static_cast<double>(p.getProperty(kAutomationValue, 0.0));
        if (!std::isfinite(t) || !std::isfinite(val)) return false;
        auto* obj = new juce::DynamicObject();
        obj->setProperty(kAutomationTimeMs, juce::jmax(0.0, t));
        obj->setProperty(kAutomationValue, normalizeAutomationValue(paramId, val));
        normalised.add(juce::var(obj));
    }
    std::sort(normalised.begin(), normalised.end(), [this](const juce::var& a, const juce::var& b) {
        return static_cast<double>(a.getProperty(kAutomationTimeMs, 0.0)) <
               static_cast<double>(b.getProperty(kAutomationTimeMs, 0.0));
    });
    for (int i = 1; i < normalised.size(); ++i)
    {
        const double prev =
            static_cast<double>(normalised.getReference(i - 1).getProperty(kAutomationTimeMs, 0.0));
        const double curr =
            static_cast<double>(normalised.getReference(i).getProperty(kAutomationTimeMs, 0.0));
        if (std::abs(curr - prev) < 1.0e-3) return false; // duplicate timeMs
    }

    const auto existing = readLanes(track, kAutomation);

    // Rebuild the lanes array: keep every other param's lane, replace this one.
    juce::Array<juce::var> nextLanes;
    nextLanes.ensureStorageAllocated(existing.size() + 1);
    for (const auto& lane : existing)
    {
        if (lane.getProperty(kAutomationParamId, juce::var()).toString() != paramId)
            nextLanes.add(lane);
    }
    if (normalised.size() >= 2)
    {
        auto* laneObj = new juce::DynamicObject();
        laneObj->setProperty(kAutomationParamId, paramId);
        laneObj->setProperty(kAutomationPoints, juce::var(normalised));
        nextLanes.add(juce::var(laneObj));
    }

    if (lanesSemanticallyEqual(existing, nextLanes, kAutomationParamId, kAutomationPoints,
                               kAutomationTimeMs, kAutomationValue))
    {
        return false;
    }

    if (nextLanes.isEmpty())
    {
        if (!track.hasProperty(kAutomation)) return false;
        track.removeProperty(kAutomation, &undoManager);
        return true;
    }
    track.setProperty(kAutomation, juce::var(nextLanes), &undoManager);
    return true;
}

juce::Array<juce::var> ProjectState::getTrackAutomation(const juce::String& trackId,
                                                        const juce::String& paramId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return {};
    const auto lanes = readLanes(track, kAutomation);
    for (const auto& lane : lanes)
    {
        if (lane.getProperty(kAutomationParamId, juce::var()).toString() == paramId)
        {
            const auto& pts = lane.getProperty(kAutomationPoints, juce::var());
            if (pts.isArray()) return *pts.getArray();
            return {};
        }
    }
    return {};
}

juce::Array<juce::var> ProjectState::getTrackAutomationLanes(const juce::String& trackId) const
{
    const auto track = findTrack(trackId);
    if (!track.isValid()) return {};
    return readLanes(track, kAutomation);
}

} // namespace silverdaw
