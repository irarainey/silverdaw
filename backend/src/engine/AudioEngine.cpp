#include "AudioEngine.h"

namespace silverdaw
{

AudioEngine::AudioEngine()
{
    // The bus graph samples automation against the master transport counter.
    busGraph.setTimelineSamplesSource(&master.positionAtomicRef());
}

AudioEngine::~AudioEngine()
{
    shutdown();
}

} // namespace silverdaw