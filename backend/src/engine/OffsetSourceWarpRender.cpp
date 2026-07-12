#include "OffsetSource.h"

namespace silverdaw
{

// Reads `n` source samples for forward clip-source position `srcPos` into `dst`. When
// `rev` is set the clip window `[inSrc, inSrc + sourceDur)` is mirrored so the audio plays
// backwards; samples outside the window are silenced rather than leaking neighbouring audio.
void OffsetSource::readChildReversibleBlock(float* const* dst, int numCh, juce::int64 srcPos, int n,
                                             bool rev, juce::int64 inSrc, juce::int64 sourceDur)
{
    if (child == nullptr || n <= 0 || numCh <= 0) return;

    if (!rev)
    {
        if (sourceDur <= 0)
        {
            child->setNextReadPosition(srcPos);
            juce::AudioBuffer<float> bufView(dst, numCh, n);
            juce::AudioSourceChannelInfo info(&bufView, 0, n);
            child->getNextAudioBlock(info);
            return;
        }

        for (int c = 0; c < numCh; ++c)
            juce::FloatVectorOperations::clear(dst[c], n);

        const juce::int64 localStart = srcPos - inSrc;
        const juce::int64 validStart =
            juce::jmax(static_cast<juce::int64>(0), localStart);
        const juce::int64 validEnd = juce::jmin(localStart + n, sourceDur);
        const int validCount =
            static_cast<int>(juce::jmax(static_cast<juce::int64>(0),
                                        validEnd - validStart));
        if (validCount > 0)
        {
            const int destOffset = static_cast<int>(validStart - localStart);
            float* validDest[kMaxWarpChannels] = {nullptr};
            const int planes = juce::jmin(numCh, kMaxWarpChannels);
            for (int c = 0; c < planes; ++c)
                validDest[c] = dst[c] + destOffset;
            child->setNextReadPosition(inSrc + validStart);
            juce::AudioBuffer<float> bufView(validDest, planes, validCount);
            juce::AudioSourceChannelInfo info(&bufView, 0, validCount);
            child->getNextAudioBlock(info);
        }
        return;
    }

    const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);
    const int scratchCapacity = reverseScratch.getNumSamples();
    if (scratchPlanes <= 0 || scratchCapacity <= 0) return;

    int done = 0;
    while (done < n)
    {
        const int chunk = juce::jmin(n - done, scratchCapacity);
        reverseScratch.clear(0, chunk);

        const juce::int64 localStart = srcPos + done - inSrc;
        const juce::int64 mirroredLocalStart = sourceDur - localStart - chunk;
        const juce::int64 validStart =
            juce::jmax(static_cast<juce::int64>(0), mirroredLocalStart);
        const juce::int64 validEnd =
            juce::jmin(mirroredLocalStart + chunk, sourceDur);
        const int validCount =
            static_cast<int>(juce::jmax(static_cast<juce::int64>(0),
                                        validEnd - validStart));
        if (validCount > 0)
        {
            const int destOffset = static_cast<int>(validStart - mirroredLocalStart);
            float* sp[kMaxWarpChannels] = {nullptr};
            for (int c = 0; c < scratchPlanes; ++c)
                sp[c] = reverseScratch.getWritePointer(c) + destOffset;
            child->setNextReadPosition(inSrc + validStart);
            juce::AudioBuffer<float> bufView(sp, scratchPlanes, validCount);
            juce::AudioSourceChannelInfo info(&bufView, 0, validCount);
            child->getNextAudioBlock(info);
        }

        for (int c = 0; c < numCh; ++c)
        {
            const float* s =
                reverseScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
            float* d = dst[c] + done;
            for (int i = 0, j = chunk - 1; i < chunk; ++i, --j)
                d[i] = s[j];
        }
        done += chunk;
    }
}

void OffsetSource::pullThroughWarp(WarpProcessor& w, juce::AudioBuffer<float>& dest, int startSample,
                                    int numSamples, bool rev, juce::int64 inSrc, juce::int64 sourceDur)
{
    if (child == nullptr || numSamples <= 0) return;

    const int sourceCh = juce::jmax(1, w.getNumChannels());
    const int destCh = juce::jmax(1, dest.getNumChannels());

    const int outPlanes = juce::jmin(sourceCh, kMaxWarpChannels);
    const int scratchCapacity = warpScratch.getNumSamples();
    if (outPlanes <= 0 || scratchCapacity <= 0) return;

    auto readSource =
        [this, sourceCh, rev, inSrc, sourceDur](float* const* dst, juce::int64 srcPos, int n)
    {
        readChildReversibleBlock(dst, sourceCh, srcPos, n, rev, inSrc, sourceDur);
    };

    int done = 0;
    while (done < numSamples)
    {
        const int chunk = juce::jmin(numSamples - done, scratchCapacity);
        warpScratch.clear(0, chunk);

        float* warpOut[kMaxWarpChannels] = {nullptr};
        for (int c = 0; c < outPlanes; ++c)
            warpOut[c] = warpScratch.getWritePointer(c);
        w.process(warpOut, chunk, readSource);

        if (sourceCh == 1 && destCh > 1)
        {
            const float* src = warpScratch.getReadPointer(0);
            for (int c = 0; c < destCh; ++c)
                juce::FloatVectorOperations::copy(
                    dest.getWritePointer(c, startSample + done), src, chunk);
        }
        else
        {
            const int common = juce::jmin(sourceCh, destCh);
            for (int c = 0; c < common; ++c)
                juce::FloatVectorOperations::copy(
                    dest.getWritePointer(c, startSample + done),
                    warpScratch.getReadPointer(c),
                    chunk);
            for (int c = common; c < destCh; ++c)
                juce::FloatVectorOperations::clear(
                    dest.getWritePointer(c, startSample + done), chunk);
        }
        done += chunk;
    }
}

} // namespace silverdaw
