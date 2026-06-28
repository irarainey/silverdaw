#pragma once

#include <atomic>
#include <cmath>
#include <vector>

#include <juce_audio_basics/juce_audio_basics.h>

namespace silverdaw
{

// Real-time metronome click. When enabled, mixes a short precomputed click into the post-master-gain
// output on every beat boundary, phase-aligned to the transport's absolute sample position so it
// tracks tempo changes and seeks exactly. A monitoring aid (post master gain, like OutputKeepAlive),
// so the project's own master volume never silences it. Audio-thread render is allocation-, lock- and
// branch-light; message-thread state (enabled / BPM) is published through atomics.
class Metronome
{
  public:
    void setEnabled(bool e) noexcept { enabled.store(e, std::memory_order_release); }
    bool isEnabled() const noexcept { return enabled.load(std::memory_order_acquire); }

    void setBpm(double b) noexcept { bpm.store(b, std::memory_order_release); }

    // Build the click waveform for the active sample rate. Called from prepareToPlay, which JUCE
    // serialises against the audio callback, so resizing the click buffer here is safe.
    void prepare(double sampleRate) noexcept
    {
        if (sampleRate <= 0.0)
        {
            click.clear();
            return;
        }
        // ~35 ms crisp tick: a 1500 Hz sine under a fast exponential decay so it cuts through a mix
        // without ringing into the next beat.
        const int len = static_cast<int>(sampleRate * kClickSeconds);
        click.assign(static_cast<size_t>(juce::jmax(1, len)), 0.0f);
        constexpr double kFreq = 1500.0;
        constexpr double kDecayTau = 0.008; // seconds
        for (int i = 0; i < len; ++i)
        {
            const double t = static_cast<double>(i) / sampleRate;
            const double env = std::exp(-t / kDecayTau);
            click[static_cast<size_t>(i)] = static_cast<float>(kClickPeak * env * std::sin(2.0 * juce::MathConstants<double>::pi * kFreq * t));
        }
    }

    // Audio thread: mix clicks for the block spanning [blockStartPos, blockStartPos + numSamples) in
    // absolute transport samples. The caller passes the true start-of-block transport position and
    // only invokes this for blocks where the transport actually advanced (i.e. real playback, not a
    // stopped block or a wake pre-roll), so phase is always correct. No-op unless enabled.
    void render(juce::AudioBuffer<float>& buffer, int startSample, int numSamples,
                juce::int64 blockStartPos, double sampleRate) noexcept
    {
        if (! enabled.load(std::memory_order_acquire)) return;
        const double curBpm = bpm.load(std::memory_order_acquire);
        if (curBpm <= 0.0 || sampleRate <= 0.0 || numSamples <= 0 || click.empty()) return;

        const double beatPeriod = sampleRate * 60.0 / curBpm; // samples per beat
        if (beatPeriod < 1.0) return;

        const auto clickLen = static_cast<juce::int64>(click.size());
        const juce::int64 blockEnd = blockStartPos + numSamples;

        // Beats whose click overlaps this block: a click at beat k starts at round(k*beatPeriod) and
        // is audible while start < blockEnd and start + clickLen > blockStartPos.
        juce::int64 firstBeat =
            static_cast<juce::int64>(std::floor(static_cast<double>(blockStartPos - clickLen + 1) / beatPeriod));
        if (firstBeat < 0) firstBeat = 0;
        const juce::int64 lastBeat =
            static_cast<juce::int64>(std::floor(static_cast<double>(blockEnd - 1) / beatPeriod));

        const int numCh = buffer.getNumChannels();
        for (juce::int64 k = firstBeat; k <= lastBeat; ++k)
        {
            const juce::int64 clickStart = std::llround(static_cast<double>(k) * beatPeriod);
            const juce::int64 from = juce::jmax(clickStart, blockStartPos);
            const juce::int64 to = juce::jmin(clickStart + clickLen, blockEnd);
            for (juce::int64 s = from; s < to; ++s)
            {
                const int bufIdx = startSample + static_cast<int>(s - blockStartPos);
                const float v = click[static_cast<size_t>(s - clickStart)];
                for (int ch = 0; ch < numCh; ++ch)
                    buffer.addSample(ch, bufIdx, v);
            }
        }
    }

  private:
    static constexpr double kClickSeconds = 0.035;
    static constexpr double kClickPeak = 0.25; // ~-12 dBFS, audible over typical programme

    std::atomic<bool> enabled{false};
    std::atomic<double> bpm{100.0};
    // Audio-thread-read click waveform; only resized from prepare() during a serialised device
    // (re)start, so no concurrent access with render().
    std::vector<float> click;

    static_assert(std::atomic<double>::is_always_lock_free,
                  "Metronome publishes BPM lock-free to the audio thread");
};

} // namespace silverdaw
