#include "AudioEngine.h"

namespace silverdaw
{

AudioEngine::AudioEngine()
{
    // The bus graph samples automation against the master transport counter.
    busGraph.setTimelineSamplesSource(&master.positionAtomicRef());

    // Hosted plugins follow the same transport, read from the same atomics (ADR 0025).
    pluginPlayHead.setTransportSources(&master.positionAtomicRef(),
                                       &master.sampleRateAtomicRef(),
                                       &outputKeepAlive.playingAtomicRef());
    busGraph.setPluginPlayHead(&pluginPlayHead);
}

AudioEngine::~AudioEngine()
{
    shutdown();
}

} // namespace silverdaw