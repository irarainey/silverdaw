#include "OffsetSource.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>

namespace silverdaw
{

void OffsetSource::prepareToPlay(int blockSize, double sampleRate)
{
    cachedBlockSize.store(blockSize, std::memory_order_relaxed);
    cachedSampleRate.store(sampleRate, std::memory_order_relaxed);
    const int renderScratchSamples = juce::jmax(kRenderScratchSamples, blockSize);
    warpScratch.setSize(kMaxWarpChannels, renderScratchSamples,
                        /*keepExistingContent*/ false,
                        /*clearExtraSpace*/ true,
                        /*avoidReallocating*/ false);
    reverseScratch.setSize(kMaxWarpChannels, renderScratchSamples,
                           /*keepExistingContent*/ false,
                           /*clearExtraSpace*/ true,
                           /*avoidReallocating*/ false);
    if (child != nullptr)
    {
        child->prepareToPlay(blockSize, sampleRate);
    }
    if (auto* w = warp.load(std::memory_order_acquire))
    {
        w->prepareToPlay(blockSize);
    }
}

void OffsetSource::releaseResources()
{
    if (child != nullptr)
    {
        child->releaseResources();
    }
}

void OffsetSource::getNextAudioBlock(const juce::AudioSourceChannelInfo& info)
{
    if (child == nullptr || info.numSamples <= 0)
    {
        info.clearActiveBufferRegion();
        return;
    }

    const juce::int64 startPos = position.load(std::memory_order_relaxed);
    const juce::int64 endPos = startPos + info.numSamples;
    const ClipWindow window = readClipWindow();
    const juce::int64 clipStart = window.offsetSamples;
    auto* currentWarp = warp.load(std::memory_order_acquire);
    const juce::int64 sourceDur = window.clipDurationSamples;
    const juce::int64 dur = timelineSamplesForSourceSamples(sourceDur, currentWarp);
    const juce::int64 clipEnd =
        dur > 0 ? clipStart + dur : std::numeric_limits<juce::int64>::max();
    const juce::int64 inSrc = window.inSourceSamples;

    if (endPos <= clipStart || startPos >= clipEnd)
    {
        info.clearActiveBufferRegion();
        position.store(endPos, std::memory_order_relaxed);
        return;
    }

    const juce::int64 audibleStart = juce::jmax(startPos, clipStart);
    const juce::int64 audibleEnd = juce::jmin(endPos, clipEnd);
    const int silentLeading = static_cast<int>(audibleStart - startPos);
    const int audibleSamples = static_cast<int>(audibleEnd - audibleStart);
    const int silentTrailing = info.numSamples - silentLeading - audibleSamples;

    if (silentLeading > 0)
    {
        juce::AudioSourceChannelInfo lead = info;
        lead.numSamples = silentLeading;
        lead.clearActiveBufferRegion();
    }

    if (audibleSamples > 0)
    {
        juce::AudioSourceChannelInfo audible = info;
        audible.startSample += silentLeading;
        audible.numSamples = audibleSamples;
        auto* w = currentWarp;
        const bool rev = reversed.load(std::memory_order_acquire);

        // Tail effects (turntable brake / backspin). Mutually exclusive; backspin
        // wins if both are set. Reverse is excluded (out of scope). v1 now composes
        // with warp: the part before the effect is warped normally, then the tail is
        // read straight from the source as a varispeed (a record-stop is pitch-
        // changing, so it can't go through the pitch-preserving stretcher). The warp
        // tempo ratio only positions the tail and scales its rate for continuity.
        const BackspinSnapshot* backspin = backspinSnap.load(std::memory_order_acquire);
        const BrakeSnapshot* brake = brakeSnap.load(std::memory_order_acquire);
        const bool backspinActive = backspin != nullptr && !backspin->isEmpty() && !rev;
        const bool brakeActive = !backspinActive && brake != nullptr && !brake->isEmpty() && !rev;
        const bool tailActive = backspinActive || brakeActive;
        const double rateScale = (w != nullptr && w->isActive()) ? w->getTempoRatio() : 1.0;

        float* planes[kMaxWarpChannels] = {nullptr};
        const int numCh = juce::jmin(audible.buffer->getNumChannels(), kMaxWarpChannels);
        for (int c = 0; c < numCh; ++c)
        {
            planes[c] = audible.buffer->getWritePointer(c, audible.startSample);
        }

        // Warp `cnt` output samples (from `audibleStart`) through the stretcher,
        // reseeking only on a discontinuity so steady-state keeps its history.
        const auto warpInto = [&](int cnt) {
            if (w == nullptr || cnt <= 0) return;
            const bool forceReseek = warpReseekRequested.exchange(false, std::memory_order_acq_rel);
            if (forceReseek || lastBlockEnded || audibleStart != lastAudibleEnd)
            {
                const double ratio = w->getTempoRatio();
                const juce::int64 warpedSourcePos =
                    inSrc + static_cast<juce::int64>(static_cast<double>(audibleStart - clipStart) * ratio);
                w->seekSource(warpedSourcePos);
            }
            pullThroughWarp(*w, *audible.buffer, audible.startSample, cnt, rev, inSrc, sourceDur);
        };

        if (!tailActive)
        {
            if (w != nullptr)
            {
                warpInto(audibleSamples);
            }
            else
            {
                const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                readChildReversibleBlock(planes, numCh, sourcePos, audibleSamples, rev, inSrc, sourceDur);
            }
        }
        else
        {
            // Split this block at the effect trigger (last `effLen` of the timeline
            // footprint). The pre-tail part plays normally (warped or direct); the
            // tail part renders the varispeed straight from the source.
            const juce::int64 effLen = backspinActive
                ? juce::jmin(backspin->getBackspinLenSamples(), dur)
                : juce::jmin(brake->getBrakeLenSamples(), dur);
            const juce::int64 tailStart = clipEnd - effLen;
            const juce::int64 normalEnd = juce::jmin(audibleEnd, tailStart);
            const int normalCount =
                static_cast<int>(juce::jmax(static_cast<juce::int64>(0), normalEnd - audibleStart));
            if (normalCount > 0)
            {
                if (w != nullptr)
                {
                    warpInto(normalCount);
                }
                else
                {
                    const juce::int64 sourcePos = (audibleStart - clipStart) + inSrc;
                    readChildReversibleBlock(planes, numCh, sourcePos, normalCount, rev, inSrc, sourceDur);
                }
            }
            const juce::int64 tailAudibleStart = juce::jmax(audibleStart, tailStart);
            const int tailCount = static_cast<int>(audibleEnd - tailAudibleStart);
            if (tailCount > 0)
            {
                if (backspinActive)
                {
                    renderBackspinBlock(planes, numCh, normalCount, *backspin,
                                        static_cast<double>(effLen), tailStart, tailAudibleStart,
                                        tailCount, clipStart, inSrc, sourceDur, rateScale);
                }
                else
                {
                    renderBrakeBlock(planes, numCh, normalCount, *brake,
                                     static_cast<double>(effLen), tailStart, tailAudibleStart,
                                     tailCount, clipStart, inSrc, sourceDur, rateScale);
                }
            }
        }
        lastBlockEnded = false;
        lastAudibleEnd = audibleEnd;

        applyClipGain(*audible.buffer,
                      audible.startSample, audibleSamples,
                      audibleStart, clipStart);
    }
    else
    {
        lastBlockEnded = true;
    }

    if (silentTrailing > 0)
    {
        juce::AudioSourceChannelInfo trail = info;
        trail.startSample += silentLeading + audibleSamples;
        trail.numSamples = silentTrailing;
        trail.clearActiveBufferRegion();
    }

    position.store(endPos, std::memory_order_relaxed);
    lastBlockEndPosition.store(endPos, std::memory_order_relaxed);
}

void OffsetSource::setNextReadPosition(juce::int64 newPosition)
{
    // Rebuild stale JUCE read-ahead buffers after timeline changes so playback starts at
    // the new position.
    const juce::int64 prevExpected = lastBlockEndPosition.load(std::memory_order_relaxed);
    constexpr juce::int64 kContinuityToleranceSamples = 16384;
    const bool isDiscontinuous =
        prevExpected < 0 ||
        std::abs(newPosition - prevExpected) > kContinuityToleranceSamples;

    position.store(newPosition, std::memory_order_relaxed);
    const ClipWindow window = readClipWindow();
    const juce::int64 off = window.offsetSamples;
    const juce::int64 inSrc = window.inSourceSamples;
    if (child != nullptr)
    {
        // Silverdaw tempoRatio is project/source; Rubber Band receives the inverse
        // internally.
        juce::int64 childPos = inSrc;
        if (newPosition >= off)
        {
            if (auto* w = warp.load(std::memory_order_acquire); w != nullptr && w->isActive())
            {
                childPos = inSrc + static_cast<juce::int64>(
                    static_cast<double>(newPosition - off) * w->getTempoRatio());
            }
            else
            {
                childPos = (newPosition - off) + inSrc;
            }
        }
        child->setNextReadPosition(childPos);
    }
    if (isDiscontinuous)
    {
        lastBlockEnded = true;
        if (auto* w = warp.load(std::memory_order_acquire))
        {
            w->requestReset();
        }
    }
}

void OffsetSource::applyClipGain(juce::AudioBuffer<float>& buffer,
                                  int startSample, int count,
                                  juce::int64 audibleStart, juce::int64 clipStart) noexcept
{
    if (count <= 0) return;
    const EnvelopeSnapshot* env = envelope.load(std::memory_order_acquire);
    const EdgeFadeSnapshot* fade = edgeFade.load(std::memory_order_acquire);
    const bool haveFade = fade != nullptr && !fade->isEmpty();
    const double sr = cachedSampleRate.load(std::memory_order_relaxed);
    const bool haveEnv = env != nullptr && !env->isEmpty() && sr > 0.0;
    if (!haveEnv && !haveFade) return;

    const double msPerSample = sr > 0.0 ? 1000.0 / sr : 0.0;
    const int numCh = buffer.getNumChannels();
    auto* const* channelData = buffer.getArrayOfWritePointers();
    std::size_t seg = 0;
    for (int i = 0; i < count; ++i)
    {
        const juce::int64 timelineSample = audibleStart + i;
        float gain = 1.0F;
        if (haveEnv)
        {
            const double ms = static_cast<double>(timelineSample - clipStart) * msPerSample;
            gain *= env->gainAtMs(ms, seg);
        }
        if (haveFade)
        {
            gain *= fade->gainAtSample(timelineSample);
        }
        if (gain == 1.0F) continue;
        for (int ch = 0; ch < numCh; ++ch)
        {
            channelData[ch][startSample + i] *= gain;
        }
    }
}

OffsetSource::ClipWindow OffsetSource::readClipWindow() const noexcept
{
    constexpr int kMaxRetries = 4;
    ClipWindow w{};
    for (int attempt = 0; attempt < kMaxRetries; ++attempt)
    {
        const auto s1 = windowSeq.load(std::memory_order_acquire);
        if ((s1 & 1u) != 0u) continue; // writer mid-update; spin briefly
        w.offsetSamples = offsetSamples.load(std::memory_order_relaxed);
        w.inSourceSamples = inSourceSamples.load(std::memory_order_relaxed);
        w.clipDurationSamples = clipDurationSamples.load(std::memory_order_relaxed);
        std::atomic_thread_fence(std::memory_order_acquire);
        const auto s2 = windowSeq.load(std::memory_order_relaxed);
        if (s1 == s2)
        {
            lastGoodWindow = w; // cache the last CONSISTENT snapshot (single reader thread)
            return w;
        }
    }
    // The writer held the seqlock open for the whole bounded spin — e.g. the message thread was
    // preempted between the field stores. Return the last consistent window rather than falling
    // through to torn relaxed reads (which could pair a new offset with an old duration and
    // glitch the block). It is at worst one update stale — imperceptible and self-correcting on
    // the next block — but never inconsistent. Spinning longer to wait out the writer is avoided
    // deliberately: this runs on the (high-priority) audio read-ahead thread, and busy-waiting
    // on a preempted lower-priority writer risks priority inversion.
    return lastGoodWindow;
}

} // namespace silverdaw
