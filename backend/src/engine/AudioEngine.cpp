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

    // The click is mixed post-master, downstream of the compensation delay lines, so it must
    // step back by the alignment to stay with the music it is counting (ADR 0026).
    masterMeter.setMetronomeLeadSource(&busGraph.latencyCompensationAtomicRef());
}

AudioEngine::~AudioEngine()
{
    shutdown();
}

} // namespace silverdaw