#include "TransportCommands.h"

#include "AudioEngine.h"
#include "Log.h"
#include "PayloadHelpers.h"
#include "ProjectState.h"

namespace silverdaw
{

using silverdaw::bridge::tryGetNumber;

void handleTransportPlay(AudioEngine& engine, bool mixdownInProgress)
{
    if (mixdownInProgress)
    {
        silverdaw::log::warn("bridge", "recv TRANSPORT_PLAY rejected — mixdown render is in progress");
        return;
    }
    silverdaw::log::info("bridge", "recv TRANSPORT_PLAY");
    engine.play();
}

void handleTransportPause(AudioEngine& engine)
{
    silverdaw::log::info("bridge", "recv TRANSPORT_PAUSE");
    engine.pause();
}

void handleTransportStop(AudioEngine& engine, ProjectState& projectState)
{
    silverdaw::log::info("bridge", "recv TRANSPORT_STOP");
    engine.stop();
    projectState.setPlayheadMs(0.0);
}

void handleTransportSeek(const juce::var& payload, AudioEngine& engine, ProjectState& projectState)
{
    const auto positionMs = tryGetNumber(payload, "positionMs");
    silverdaw::log::info("bridge", "recv TRANSPORT_SEEK pos=" + juce::String(positionMs.value_or(-1.0)));
    if (positionMs.has_value())
    {
        engine.setPositionMs(*positionMs);
        projectState.setPlayheadMs(juce::jmax(0.0, *positionMs));
    }
}

void handleTransportScrub(const juce::var& payload, AudioEngine& engine, ProjectState& projectState)
{
    const auto positionMs = tryGetNumber(payload, "positionMs");
    const auto deltaMs = tryGetNumber(payload, "deltaMs");
    if (! positionMs.has_value() || ! deltaMs.has_value())
        return;

    if (engine.scrubPositionMs(*positionMs, *deltaMs))
        projectState.setPlayheadMs(juce::jmax(0.0, *positionMs));
}

} // namespace silverdaw
