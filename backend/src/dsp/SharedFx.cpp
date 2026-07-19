#include "SharedFx.h"

namespace silverdaw
{

double delayNoteToMs(const juce::String& noteValue, double bpm) noexcept
{
    const double safeBpm = juce::jlimit(15.0, 999.0,
        (bpm > 0.0 && std::isfinite(bpm)) ? bpm : 120.0);
    double beats = 0.5; // 1/8 default
    if (noteValue == "1/4")       beats = 1.0;
    else if (noteValue == "1/8")  beats = 0.5;
    else if (noteValue == "1/8T") beats = 1.0 / 3.0;
    else if (noteValue == "1/16") beats = 0.25;
    return beats * 60000.0 / safeBpm;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

void SharedFx::prepare(double sampleRate, int maxBlockSize) noexcept
{
    sr = (sampleRate > 0.0 && std::isfinite(sampleRate)) ? sampleRate : 44100.0;
    maxBlock = juce::jmax(1, maxBlockSize);

    wetL.assign(static_cast<size_t>(maxBlock), 0.0F);
    wetR.assign(static_cast<size_t>(maxBlock), 0.0F);

    maxDelaySamples = juce::jmax(2, static_cast<int>(
        std::ceil(kMaxDelayMs * sr / 1000.0)) + 1);
    delayBufL.assign(static_cast<size_t>(maxDelaySamples), 0.0F);
    delayBufR.assign(static_cast<size_t>(maxDelaySamples), 0.0F);
    delayGeneration.assign(static_cast<size_t>(maxDelaySamples), 0);

    reverb.setSampleRate(sr);
    recomputeReverbToneCoeff();
    recomputeEchoToneCoeff();
    snapSmoothers();
    prepared = true;
    reset();
    // Targets are already snapped above; drop any stale pending control flags.
    reverbSnapRequested.store(false, std::memory_order_relaxed);
    echoSnapRequested.store(false, std::memory_order_relaxed);
    applyDelayTimeRequested.store(false, std::memory_order_relaxed);
    resetRequested.store(false, std::memory_order_relaxed);
}

void SharedFx::reset() noexcept
{
    reverb.reset();
    invalidateDelayBuffer();
    reverbToneStateL = reverbToneStateR = 0.0F;
    echoToneStateL   = echoToneStateR   = 0.0F;

    activeDelaySamples.store(
        computeDelaySamples(targetDelayMs.load(std::memory_order_relaxed)),
        std::memory_order_relaxed);

    resetDetectors();
}

// ── Lock-free setters ─────────────────────────────────────────────────────────

void SharedFx::setReverbParams(float size, float decay, float tone, float mix,
                               bool snap) noexcept
{
    const float s = juce::jlimit(0.0F, 1.0F, sanitize(size));
    const float d = juce::jlimit(0.0F, 1.0F, sanitize(decay));
    // Keep Size and Decay independent so each knob has an obvious effect.
    targetRoomSize.store(juce::jlimit(0.0F, 1.0F, 0.05F + 0.92F * s),
                         std::memory_order_relaxed);
    targetDamping.store(1.0F - d, std::memory_order_relaxed);
    targetReverbToneHz.store(mapToneHz(juce::jlimit(0.0F, 1.0F, sanitize(tone))),
                             std::memory_order_relaxed);
    targetReverbMix.store(juce::jlimit(0.0F, 1.0F, sanitize(mix)),
                          std::memory_order_relaxed);

    // Release pairs with the acquire in `processReverb`, so a consumed snap sees the targets.
    if (snap) reverbSnapRequested.store(true, std::memory_order_release);
}

void SharedFx::setDelayParams(double delayMs, float feedback, float tone, float mix,
                              bool snap, bool applyTimeNow) noexcept
{
    const double clampedMs = juce::jlimit(1.0, kMaxDelayMs,
        std::isfinite(delayMs) ? delayMs : 1.0);
    targetDelayMs.store(clampedMs, std::memory_order_relaxed);
    targetFeedback.store(juce::jlimit(0.0F, kMaxFeedback, sanitize(feedback)),
                         std::memory_order_relaxed);
    targetEchoToneHz.store(mapToneHz(juce::jlimit(0.0F, 1.0F, sanitize(tone))),
                           std::memory_order_relaxed);
    targetEchoMix.store(juce::jlimit(0.0F, 1.0F, sanitize(mix)),
                        std::memory_order_relaxed);

    recomputeAnalyticTail();
    // `applyTimeNow=false` keeps the current echo time until the next reset/cold start.
    if (applyTimeNow)
        applyDelayTimeRequested.store(true, std::memory_order_release);
    if (snap) echoSnapRequested.store(true, std::memory_order_release);
}

double SharedFx::minimumEchoTailSeconds(double delayMs, float feedback) noexcept
{
    const double clampedMs = juce::jlimit(1.0, kMaxDelayMs,
        std::isfinite(delayMs) ? delayMs : 1.0);
    return (clampedMs / 1000.0)
           * static_cast<double>(analyticEchoTailRepeats(feedback));
}

// ── Process ───────────────────────────────────────────────────────────────────

void SharedFx::process(const juce::AudioBuffer<float>& reverbSend,
                        const juce::AudioBuffer<float>& delaySend,
                        juce::AudioBuffer<float>& out, int startSample,
                        int numSamples) noexcept
{
    if (! prepared || numSamples <= 0 || numSamples > maxBlock) return;
    if (out.getNumChannels() < 1) return;

    if (resetRequested.exchange(false, std::memory_order_acquire))
        reset();

    const float alpha            = blockAlpha(numSamples);
    const bool reverbInputPresent = bufferHasSignal(reverbSend, numSamples);
    const bool delayInputPresent  = bufferHasSignal(delaySend,  numSamples);

    processReverb(reverbSend, out, startSample, numSamples, alpha, reverbInputPresent);
    processEcho  (delaySend,  out, startSample, numSamples, alpha, delayInputPresent);
}

// ── Private helpers ───────────────────────────────────────────────────────────

int SharedFx::computeDelaySamples(double ms) const noexcept
{
    const double clampedMs = juce::jlimit(1.0, kMaxDelayMs,
        std::isfinite(ms) ? ms : 1.0);
    return juce::jlimit(1, juce::jmax(1, maxDelaySamples - 1),
                        static_cast<int>(std::round(clampedMs * sr / 1000.0)));
}

// Log mapping makes the tone knob feel even across octaves.
double SharedFx::mapToneHz(float tone01) noexcept
{
    const double t = juce::jlimit(0.0, 1.0, static_cast<double>(tone01));
    return kToneMinHz * std::pow(kToneMaxHz / kToneMinHz, t);
}

float SharedFx::blockAlpha(int numSamples) const noexcept
{
    return dsp::blockAlpha(numSamples, sr, kSmoothTauSeconds);
}

float SharedFx::onePoleCoeff(double hz) const noexcept
{
    const double f = juce::jlimit(20.0, sr * 0.49, hz);
    const double x = std::exp(-2.0 * juce::MathConstants<double>::pi * f / sr);
    return static_cast<float>(juce::jlimit(0.0, 1.0, 1.0 - x));
}

void SharedFx::recomputeReverbToneCoeff() noexcept
{
    reverbToneCoeff = onePoleCoeff(curReverbToneHz);
}

void SharedFx::recomputeEchoToneCoeff() noexcept
{
    echoToneCoeff = onePoleCoeff(curEchoToneHz);
}

void SharedFx::applyReverbParams() noexcept
{
    const float roomSize = juce::jlimit(0.0F, 1.0F, curRoomSize);
    const float damping  = juce::jlimit(0.0F, 1.0F, curDamping);
    if (reverbParamsApplied
        && juce::approximatelyEqual(roomSize, lastAppliedRoomSize)
        && juce::approximatelyEqual(damping,  lastAppliedDamping))
        return; // skip redundant smoother re-targeting when nothing changed

    juce::Reverb::Parameters p;
    p.roomSize  = roomSize;
    p.damping   = damping;
    p.wetLevel  = 1.0F; // fully wet; the Mix knob is applied as our own return gain
    p.dryLevel  = 0.0F;
    p.width     = 1.0F;
    p.freezeMode = 0.0F;
    reverb.setParameters(p);
    lastAppliedRoomSize = roomSize;
    lastAppliedDamping  = damping;
    reverbParamsApplied = true;
}

void SharedFx::snapSmoothers() noexcept
{
    curRoomSize     = targetRoomSize.load(std::memory_order_relaxed);
    curDamping      = targetDamping.load(std::memory_order_relaxed);
    curReverbToneHz = targetReverbToneHz.load(std::memory_order_relaxed);
    curReverbMix    = targetReverbMix.load(std::memory_order_relaxed);
    curFeedback     = targetFeedback.load(std::memory_order_relaxed);
    curEchoToneHz   = targetEchoToneHz.load(std::memory_order_relaxed);
    curEchoMix      = targetEchoMix.load(std::memory_order_relaxed);
    applyReverbParams();
    recomputeReverbToneCoeff();
    recomputeEchoToneCoeff();
}

bool SharedFx::bufferHasSignal(const juce::AudioBuffer<float>& buf,
                               int numSamples) noexcept
{
    const int nCh = juce::jmin(2, buf.getNumChannels());
    for (int ch = 0; ch < nCh; ++ch)
        if (buf.getMagnitude(ch, 0, numSamples) > kSignalEpsilon) return true;
    return false;
}

void SharedFx::resetDetectors() noexcept
{
    reverbSilentBlocks = 0;
    reverbFramesSinceInput = 0;
    // A reset processor has no tail; the first new input restarts its detector.
    reverbDone.store(true, std::memory_order_relaxed);
    echoFramesSinceInput = 0;
    echoDone.store(true, std::memory_order_relaxed);
}

void SharedFx::recomputeAnalyticTail() noexcept
{
    analyticTailRepeats.store(
        analyticEchoTailRepeats(targetFeedback.load(std::memory_order_relaxed)),
        std::memory_order_relaxed);
}

int SharedFx::analyticEchoTailRepeats(float feedback) noexcept
{
    // Feedback is clamped below unity, so the analytic tail log stays finite.
    const double fb = juce::jlimit(0.0, static_cast<double>(kMaxFeedback),
        static_cast<double>(sanitize(feedback)));
    if (fb <= 1.0e-4)
    {
        return 1; // single slap
    }
    const double n = std::ceil(
        std::log(static_cast<double>(kRmsFloorLin)) / std::log(fb));
    return juce::jlimit(1, 4096, static_cast<int>(n));
}

// ── Reverb processing ─────────────────────────────────────────────────────────

void SharedFx::processReverb(const juce::AudioBuffer<float>& send,
                              juce::AudioBuffer<float>& out,
                              int startSample, int numSamples,
                              float alpha, bool inputPresent) noexcept
{
    if (reverbSnapRequested.exchange(false, std::memory_order_acquire))
    {
        curRoomSize     = targetRoomSize.load(std::memory_order_relaxed);
        curDamping      = targetDamping.load(std::memory_order_relaxed);
        curReverbToneHz = targetReverbToneHz.load(std::memory_order_relaxed);
        curReverbMix    = targetReverbMix.load(std::memory_order_relaxed);
        reverbParamsApplied = false;
        applyReverbParams();
        recomputeReverbToneCoeff();
        // JUCE's hidden parameter ramps advance only in processStereo().
        // Reapplying the unchanged sample rate snaps them to their targets
        // without reallocating the already-sized delay lines.
        reverb.setSampleRate(sr);
    }

    smoothToward(curRoomSize, targetRoomSize.load(std::memory_order_relaxed), alpha);
    smoothToward(curDamping,  targetDamping.load(std::memory_order_relaxed),  alpha);
    if (smoothToward(curReverbToneHz,
                     targetReverbToneHz.load(std::memory_order_relaxed), alpha))
        recomputeReverbToneCoeff();
    smoothToward(curReverbMix, targetReverbMix.load(std::memory_order_relaxed), alpha);
    applyReverbParams();

    const bool wasTerminated = reverbDone.load(std::memory_order_relaxed);
    if (wasTerminated && ! inputPresent) return;
    if (wasTerminated)
    {
        // Our smoothers kept advancing while idle; synchronize JUCE's internal
        // ramps before the first restarted sample so stale coefficients cannot
        // glide into the new signal.
        reverbParamsApplied = false;
        applyReverbParams();
        reverb.setSampleRate(sr);
        reverbToneStateL = reverbToneStateR = 0.0F;
        reverbSilentBlocks = 0;
        reverbFramesSinceInput = 0;
        reverbDone.store(false, std::memory_order_relaxed);
    }
    const int sendCh = send.getNumChannels();
    const float* inL = sendCh > 0 ? send.getReadPointer(0) : nullptr;
    const float* inR = sendCh > 1 ? send.getReadPointer(1) : inL;
    for (int i = 0; i < numSamples; ++i)
    {
        wetL[static_cast<size_t>(i)] = inL ? inL[i] : 0.0F;
        wetR[static_cast<size_t>(i)] = inR ? inR[i] : 0.0F;
    }

    reverb.processStereo(wetL.data(), wetR.data(), numSamples);

    // Accumulate post-mix RMS so the detector follows the audible return.
    double sumSq = 0.0;
    const float mix = curReverbMix;
    for (int i = 0; i < numSamples; ++i)
    {
        reverbToneStateL += reverbToneCoeff
            * (wetL[static_cast<size_t>(i)] - reverbToneStateL);
        reverbToneStateR += reverbToneCoeff
            * (wetR[static_cast<size_t>(i)] - reverbToneStateR);
        const float l = reverbToneStateL * mix;
        const float r = reverbToneStateR * mix;
        wetL[static_cast<size_t>(i)] = l;
        wetR[static_cast<size_t>(i)] = r;
        sumSq += static_cast<double>(l) * l + static_cast<double>(r) * r;
    }

    addWet(out, startSample, numSamples);
    updateReverbDetector(sumSq, numSamples, inputPresent);
}

// ── Echo processing ───────────────────────────────────────────────────────────

void SharedFx::processEcho(const juce::AudioBuffer<float>& send,
                            juce::AudioBuffer<float>& out,
                            int startSample, int numSamples,
                            float alpha, bool inputPresent) noexcept
{
    if (applyDelayTimeRequested.exchange(false, std::memory_order_acquire))
        activeDelaySamples.store(
            computeDelaySamples(targetDelayMs.load(std::memory_order_relaxed)),
            std::memory_order_relaxed);

    if (echoSnapRequested.exchange(false, std::memory_order_acquire))
    {
        curFeedback   = targetFeedback.load(std::memory_order_relaxed);
        curEchoToneHz = targetEchoToneHz.load(std::memory_order_relaxed);
        curEchoMix    = targetEchoMix.load(std::memory_order_relaxed);
        recomputeEchoToneCoeff();
    }

    smoothToward(curFeedback, targetFeedback.load(std::memory_order_relaxed), alpha);
    if (smoothToward(curEchoToneHz,
                     targetEchoToneHz.load(std::memory_order_relaxed), alpha))
        recomputeEchoToneCoeff();
    smoothToward(curEchoMix, targetEchoMix.load(std::memory_order_relaxed), alpha);

    const bool wasTerminated = echoDone.load(std::memory_order_relaxed);
    if (wasTerminated && ! inputPresent) return;
    if (wasTerminated)
    {
        invalidateDelayBuffer();
        echoToneStateL = echoToneStateR = 0.0F;
        echoFramesSinceInput = 0;
        echoDone.store(false, std::memory_order_relaxed);
    }
    const int sendCh   = send.getNumChannels();
    const float* inL   = sendCh > 0 ? send.getReadPointer(0) : nullptr;
    const float* inR   = sendCh > 1 ? send.getReadPointer(1) : inL;
    const int delaySamps = juce::jlimit(1, maxDelaySamples - 1,
        activeDelaySamples.load(std::memory_order_relaxed));
    const float fb  = curFeedback;
    const float mix = curEchoMix;

    double sumSq = 0.0;
    for (int i = 0; i < numSamples; ++i)
    {
        int readIdx = delayWriteIdx - delaySamps;
        if (readIdx < 0) readIdx += maxDelaySamples;

        const bool currentGeneration =
            delayGeneration[static_cast<size_t>(readIdx)] == activeDelayGeneration;
        const float delayedL =
            currentGeneration ? delayBufL[static_cast<size_t>(readIdx)] : 0.0F;
        const float delayedR =
            currentGeneration ? delayBufR[static_cast<size_t>(readIdx)] : 0.0F;

        echoToneStateL += echoToneCoeff * (delayedL - echoToneStateL);
        echoToneStateR += echoToneCoeff * (delayedR - echoToneStateR);

        const float dryL = inL ? inL[i] : 0.0F;
        const float dryR = inR ? inR[i] : 0.0F;
        delayBufL[static_cast<size_t>(delayWriteIdx)] = dryL + fb * echoToneStateL;
        delayBufR[static_cast<size_t>(delayWriteIdx)] = dryR + fb * echoToneStateR;
        delayGeneration[static_cast<size_t>(delayWriteIdx)] = activeDelayGeneration;

        if (++delayWriteIdx >= maxDelaySamples) delayWriteIdx = 0;

        const float l = delayedL * mix;
        const float r = delayedR * mix;
        wetL[static_cast<size_t>(i)] = l;
        wetR[static_cast<size_t>(i)] = r;
        sumSq += static_cast<double>(l) * l + static_cast<double>(r) * r;
    }

    addWet(out, startSample, numSamples);
    updateEchoDetector(sumSq, numSamples, delaySamps, inputPresent);
}

// ── Output and detectors ──────────────────────────────────────────────────────

void SharedFx::addWet(juce::AudioBuffer<float>& out, int startSample,
                      int numSamples) noexcept
{
    const int outCh = out.getNumChannels();
    if (outCh > 0) out.addFrom(0, startSample, wetL.data(), numSamples);
    if (outCh > 1) out.addFrom(1, startSample, wetR.data(), numSamples);
}

void SharedFx::updateReverbDetector(double sumSq, int numSamples,
                                    bool inputPresent) noexcept
{
    if (inputPresent) reverbFramesSinceInput = 0;
    else reverbFramesSinceInput += numSamples;

    const float rms = static_cast<float>(std::sqrt(sumSq / (2.0 * numSamples)));
    const int n = silenceBlockTarget(numSamples);
    if (rms < kRmsFloorLin)
    {
        if (reverbSilentBlocks < n) ++reverbSilentBlocks;
    }
    else if (rms > kRmsRestartLin)
    {
        reverbSilentBlocks = 0;
    }

    const bool decayed = reverbSilentBlocks >= n;
    const bool capped  = reverbFramesSinceInput
                         >= static_cast<int64_t>(kRoomCapSeconds * sr);
    reverbDone.store(decayed || capped, std::memory_order_relaxed);
}

void SharedFx::updateEchoDetector(double sumSq, int numSamples, int delaySamps,
                                  bool inputPresent) noexcept
{
    if (inputPresent) echoFramesSinceInput = 0;
    else echoFramesSinceInput += numSamples;

    const float rms = static_cast<float>(std::sqrt(sumSq / (2.0 * numSamples)));
    const int64_t holdFrames =
        static_cast<int64_t>(delaySamps)
        + static_cast<int64_t>(kSilenceWindowMs * sr / 1000.0);
    const int64_t analyticFrames =
        static_cast<int64_t>(analyticTailRepeats.load(std::memory_order_relaxed))
        * delaySamps;
    const int64_t requiredFrames = juce::jmax(holdFrames, analyticFrames);
    const int64_t capFrames = juce::jmax(
        static_cast<int64_t>(kEchoCapSeconds * sr), requiredFrames);

    const bool rmsSilent       = rms < kRmsFloorLin;
    const bool repeatAwareDone = rmsSilent && echoFramesSinceInput >= requiredFrames;
    const bool capped          = echoFramesSinceInput >= capFrames;
    echoDone.store(repeatAwareDone || capped, std::memory_order_relaxed);
}

int SharedFx::silenceBlockTarget(int numSamples) const noexcept
{
    const double blockMs = 1000.0 * numSamples / sr;
    return juce::jmax(1, static_cast<int>(
        std::ceil(kSilenceWindowMs / juce::jmax(1.0e-3, blockMs))));
}

void SharedFx::invalidateDelayBuffer() noexcept
{
    ++activeDelayGeneration;
    delayWriteIdx = 0;
}

} // namespace silverdaw
