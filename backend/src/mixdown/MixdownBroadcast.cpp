#include "MixdownBroadcast.h"

#include "BridgeServer.h"

#include <cmath>
#include <limits>

namespace silverdaw::mixdown_bridge
{

// Min spacing between progress envelopes so the bridge isn't flooded.
void broadcastProgress(BridgeServer& bridge, double percent, const char* stage)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("percent", juce::jlimit(0.0, 100.0, percent));
    obj->setProperty("stage", juce::String(stage));
    bridge.broadcast("MIXDOWN_PROGRESS", juce::var(obj));
}

void broadcastDone(BridgeServer& bridge,
                   const juce::File& outputFile,
                   double durationMs,
                   const LoudnessAnalyzer::Result* loudness,
                   bool limitedByTruePeak,
                   double appliedGainDb,
                   int64_t pass2PostGainClipCount,
                   double pass2PostGainPeakAmp)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("filePath", outputFile.getFullPathName());
    obj->setProperty("durationMs", durationMs);
    if (loudness != nullptr)
    {
        auto* l = new juce::DynamicObject();
        // BS.1770: integrated LUFS may be -Infinity for silent
        // programmes. JSON cannot represent ±Infinity, so emit
        // explicit nulls and let the UI render "—".
        if (loudness->silent || ! std::isfinite(loudness->integratedLufs))
            l->setProperty("integratedLufs", juce::var());
        else
            l->setProperty("integratedLufs", loudness->integratedLufs);
        if (! std::isfinite(loudness->truePeakDbtp))
            l->setProperty("truePeakDbtp", juce::var());
        else
            l->setProperty("truePeakDbtp", loudness->truePeakDbtp);
        l->setProperty("silent", loudness->silent);
        l->setProperty("unmeasurable", loudness->unmeasurable);
        l->setProperty("gatedBlockCount", static_cast<int>(loudness->gatedBlockCount));
        l->setProperty("appliedGainDb", appliedGainDb);
        l->setProperty("limitedByTruePeak", limitedByTruePeak);
        l->setProperty("pass2ClippedSamples", static_cast<int>(juce::jlimit<int64_t>(0,
            std::numeric_limits<int>::max(), pass2PostGainClipCount)));
        l->setProperty("pass2PostGainPeak", pass2PostGainPeakAmp);
        obj->setProperty("loudness", juce::var(l));
    }
    bridge.broadcast("MIXDOWN_DONE", juce::var(obj));
}

void broadcastFailed(BridgeServer& bridge, MixdownFailureCode code, const juce::String& error)
{
    auto* obj = new juce::DynamicObject();
    obj->setProperty("code", juce::String(mixdownFailureCodeToString(code)));
    obj->setProperty("error", error);
    bridge.broadcast("MIXDOWN_FAILED", juce::var(obj));
}

} // namespace silverdaw::mixdown_bridge
