#include "OffsetSource.h"

#include <cmath>

namespace silverdaw
{

// Renders `count` decelerating ("turntable brake") output samples into dst[*] starting at
// dstOffset. The source distance consumed since the brake start is the analytic, STATELESS
// curve `BrakeSnapshot::sourceConsumedAt(u)`, so live and offline render identically
// regardless of block size and seeks can't desync it. Forward, non-warped clips only (v1).
//
// The output is processed in sub-chunks no larger than the scratch buffer: the read-ahead
// thread can request blocks far bigger than `blockSize`, and each sub-chunk reads its own
// contiguous forward source span (rate ≤ 1, so the span is ≤ the sub-chunk + a couple of
// interpolation neighbours) and linearly interpolates. A short click-guard gain ramps the
// final samples to silence.
void OffsetSource::renderBrakeBlock(float* const* dst, int numCh, int dstOffset,
                                     const BrakeSnapshot& brake, double effLen,
                                     juce::int64 brakeStart, juce::int64 brakeAudibleStart, int count,
                                     juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur,
                                     double sourceRateScale)
{
    if (child == nullptr || count <= 0 || numCh <= 0) return;

    // Absolute source position where the brake begins. For a warped clip the warp
    // read source at `sourceRateScale` (tempo ratio) per timeline sample, so the
    // trigger position and the decelerating read scale by it (the brake decelerates
    // from the warped rate to 0 — continuous at the trigger, pitch no longer
    // preserved as a real record-stop is a varispeed). 1.0 for non-warped clips.
    const juce::int64 baseSrc =
        inSrc + static_cast<juce::int64>(static_cast<double>(brakeStart - clipStart) * sourceRateScale);
    const int scratchCap = warpScratch.getNumSamples();
    // The span grows with the read rate (≤ sourceRateScale), so size each sub-chunk
    // so the contiguous read still fits the scratch buffer.
    const int maxChunk =
        juce::jmax(1, static_cast<int>((scratchCap - 8) / juce::jmax(1.0, sourceRateScale)));
    const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

    for (int done = 0; done < count;)
    {
        const int n = juce::jmin(maxChunk, count - done);
        const double uStart = static_cast<double>(brakeAudibleStart - brakeStart) + done;
        const double uEnd = uStart + static_cast<double>(n - 1);
        const double sStart = sourceRateScale * brake.sourceConsumedAt(uStart, effLen);
        const double sEnd = sourceRateScale * brake.sourceConsumedAt(uEnd, effLen);

        // Contiguous forward span with one guard sample either side for the
        // 4-point cubic (Catmull-Rom) interpolation.
        const juce::int64 spanStart = static_cast<juce::int64>(std::floor(sStart)) - 1;
        const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(sEnd)) + 3;
        int spanLen = static_cast<int>(spanEndExclusive - spanStart);
        spanLen = juce::jlimit(1, scratchCap, spanLen);

        warpScratch.clear(0, spanLen);
        {
            float* sp[kMaxWarpChannels] = {nullptr};
            for (int c = 0; c < scratchPlanes; ++c) sp[c] = warpScratch.getWritePointer(c);
            // Forward read, windowed to the clip's source range (rev=false in v1).
            readChildReversibleBlock(sp, scratchPlanes, baseSrc + spanStart, spanLen,
                                     /*rev*/ false, inSrc, sourceDur);
        }

        for (int i = 0; i < n; ++i)
        {
            const double u = uStart + static_cast<double>(i);
            const double local =
                sourceRateScale * brake.sourceConsumedAt(u, effLen) - static_cast<double>(spanStart);
            const int i1 = static_cast<int>(std::floor(local));
            const float frac = static_cast<float>(local - static_cast<double>(i1));
            // Cubic needs idx-1 .. idx+2; clamp each to the span (edges only).
            const int k0 = juce::jlimit(0, spanLen - 1, i1 - 1);
            const int k1 = juce::jlimit(0, spanLen - 1, i1);
            const int k2 = juce::jlimit(0, spanLen - 1, i1 + 1);
            const int k3 = juce::jlimit(0, spanLen - 1, i1 + 2);
            const float g = brake.gainAt(u, effLen);
            for (int c = 0; c < numCh; ++c)
            {
                const float* s = warpScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
                const float p0 = s[k0], p1 = s[k1], p2 = s[k2], p3 = s[k3];
                // Catmull-Rom: exact for linear data, smooth for audio (low grain).
                const float out =
                    p1 + 0.5F * frac *
                             ((p2 - p0) +
                              frac * ((2.0F * p0 - 5.0F * p1 + 4.0F * p2 - p3) +
                                      frac * (3.0F * (p1 - p2) + p3 - p0)));
                dst[c][dstOffset + done + i] = out * g;
            }
        }
        done += n;
    }
}

// Renders `count` reverse-rewind ("turntable backspin") output samples into dst[*] starting
// at dstOffset. The source position rewinds BACKWARD from the trigger `s0` by the analytic,
// STATELESS curve `BackspinSnapshot::sourceRewoundAt(u)`, so live and offline render
// identically regardless of block size. Reads a contiguous forward source span per sub-chunk
// and 4-point cubic-interpolates; a rate-keyed fade silences the tail as the spin stops.
// Forward, non-warped clips only (v1). Reuses `warpScratch` because warp and tail rendering
// are sequential.
void OffsetSource::renderBackspinBlock(float* const* dst, int numCh, int dstOffset,
                                        const BackspinSnapshot& spin, double effLen,
                                        juce::int64 tailStart, juce::int64 tailAudibleStart, int count,
                                        juce::int64 clipStart, juce::int64 inSrc, juce::int64 sourceDur,
                                        double sourceRateScale)
{
    if (child == nullptr || count <= 0 || numCh <= 0) return;

    // Forward source position at the spin trigger. For a warped clip the warp read
    // source at `sourceRateScale` (tempo ratio) per timeline sample, so the trigger
    // position and the rewind distance scale by it (the spin reverses relative to the
    // warped playback). 1.0 for non-warped clips.
    const double s0 =
        static_cast<double>(inSrc) + static_cast<double>(tailStart - clipStart) * sourceRateScale;
    const double minSrc = static_cast<double>(inSrc); // never rewind before the clip start
    const int scratchCap = warpScratch.getNumSamples();
    const double spinSpeed = spin.getSpinSpeed();
    // Cap the rewind to the source available before the clip start. Without this the
    // spin (which rewinds spinSpeed*T/(p+1) of source) slams into the clip start and
    // FREEZES for the rest of the region on any clip shorter than ~3x the spin length,
    // so a long backspin sounds short. Instead, scale the rewind uniformly so it spans
    // the FULL duration — a gentler rewind that still ends right at the clip start.
    const double available = juce::jmax(0.0, s0 - minSrc);
    const double requestedTotal = sourceRateScale * spin.totalRewound(effLen);
    const double rewindScale =
        (requestedTotal > available && requestedTotal > 0.0) ? (available / requestedTotal) : 1.0;
    // Effective multiplier applied to the analytic rewind distance (fit x warp ratio).
    const double rewMul = rewindScale * sourceRateScale;
    // The contiguous span grows with the (scaled) spin speed, so size each sub-chunk
    // so the read still fits the scratch buffer.
    const int maxChunk =
        juce::jmax(1, static_cast<int>((scratchCap - 8) / juce::jmax(1.0, spinSpeed * rewMul)));
    const int scratchPlanes = juce::jmin(numCh, kMaxWarpChannels);

    for (int done = 0; done < count;)
    {
        const int n = juce::jmin(maxChunk, count - done);
        const double uStart = static_cast<double>(tailAudibleStart - tailStart) + done;
        const double uEnd = uStart + static_cast<double>(n - 1);
        // Source positions DECREASE with u (rewind): uStart is the latest (highest).
        const double posHi = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(uStart, effLen));
        const double posLo = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(uEnd, effLen));

        const juce::int64 spanStart =
            juce::jmax(inSrc, static_cast<juce::int64>(std::floor(posLo)) - 1);
        const juce::int64 spanEndExclusive = static_cast<juce::int64>(std::ceil(posHi)) + 3;
        int spanLen = static_cast<int>(spanEndExclusive - spanStart);
        spanLen = juce::jlimit(1, scratchCap, spanLen);

        warpScratch.clear(0, spanLen);
        {
            float* sp[kMaxWarpChannels] = {nullptr};
            for (int c = 0; c < scratchPlanes; ++c) sp[c] = warpScratch.getWritePointer(c);
            readChildReversibleBlock(sp, scratchPlanes, spanStart, spanLen,
                                     /*rev*/ false, inSrc, sourceDur);
        }

        for (int i = 0; i < n; ++i)
        {
            const double u = uStart + static_cast<double>(i);
            const double srcPos = juce::jmax(minSrc, s0 - rewMul * spin.sourceRewoundAt(u, effLen));
            const double local = srcPos - static_cast<double>(spanStart);
            const int i1 = static_cast<int>(std::floor(local));
            const float frac = static_cast<float>(local - static_cast<double>(i1));
            const int k0 = juce::jlimit(0, spanLen - 1, i1 - 1);
            const int k1 = juce::jlimit(0, spanLen - 1, i1);
            const int k2 = juce::jlimit(0, spanLen - 1, i1 + 1);
            const int k3 = juce::jlimit(0, spanLen - 1, i1 + 2);
            const float g = spin.gainAt(u, effLen);
            for (int c = 0; c < numCh; ++c)
            {
                const float* s = warpScratch.getReadPointer(juce::jmin(c, scratchPlanes - 1));
                const float p0 = s[k0], p1 = s[k1], p2 = s[k2], p3 = s[k3];
                const float out =
                    p1 + 0.5F * frac *
                             ((p2 - p0) +
                              frac * ((2.0F * p0 - 5.0F * p1 + 4.0F * p2 - p3) +
                                      frac * (3.0F * (p1 - p2) + p3 - p0)));
                dst[c][dstOffset + done + i] = out * g;
            }
        }
        done += n;
    }
}

} // namespace silverdaw
