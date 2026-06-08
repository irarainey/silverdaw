#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

/**
 * ITU-R BS.1770-4 integrated loudness + true-peak analyser.
 *
 * Designed to be fed the post-resampler / pre-dither stereo float
 * stream the writer emits. The analyser is stateless w.r.t. the file
 * format — it sees normalised float samples and the file sample rate.
 *
 * Topology (per channel):
 *   x → [pre-filter high-shelf, ~+4 dB] → [high-pass, ~38 Hz] → K-weighted x'
 *
 *   gating MS = mean(x'²) over 400 ms blocks (75% overlap → step 100 ms)
 *   loudness  = -0.691 + 10·log10(Σ G_ch · MS_ch),  G_L=G_R=1.0 (stereo)
 *
 *   absolute gate: drop blocks below -70 LUFS
 *   relative gate: from ungated mean, drop blocks below mean - 10 LU
 *   integrated   = -0.691 + 10·log10(mean of surviving block MS sums)
 *
 * The per-block MS values are stored so a downstream caller can
 * recompute the integrated value after a linear gain — the absolute
 * gate is NOT gain-invariant (rubber-duck finding A1) so we re-gate
 * analytically rather than just adding gainDb to the integrated.
 *
 * True peak: 4× upsampled per channel via a 64-tap polyphase
 * windowed-sinc FIR; reported as the max absolute sample seen in
 * dBTP.
 *
 * Coefficient design is at runtime via bilinear pre-warp of the
 * BS.1770 analog prototypes; only 44.1 kHz and 48 kHz are accepted
 * (other rates throw — see `setSampleRate`). The single-source
 * design avoids drift between hard-coded coefficient tables.
 *
 * Thread model: not thread-safe. Construct, push, finalize, destroy
 * on the same thread.
 */
class LoudnessAnalyzer
{
public:
    struct Result
    {
        /** Integrated loudness in LUFS. `silent==true` ⇒ this is
         *  `-std::numeric_limits<double>::infinity()`; callers MUST
         *  guard before mapping to JSON. */
        double integratedLufs{0.0};
        /** True-peak across the whole render in dBTP. `silent==true`
         *  ⇒ this is `-inf`. */
        double truePeakDbtp{0.0};
        /** True if no samples were ever above the noise floor used
         *  by the absolute -70 LUFS gate. Distinct from
         *  `unmeasurable` below. */
        bool silent{false};
        /** True when at least one sample was non-silent but no
         *  400 ms block survived gating (e.g. shorter than 400 ms
         *  AND below the absolute gate). The integrated value is
         *  computed from a single fallback block over the whole
         *  signal in this case. */
        bool unmeasurable{false};
        /** Number of 400 ms gating blocks that survived BOTH the
         *  absolute -70 LUFS and the relative -10 LU gates. Useful
         *  in tests; 0 ⇒ silent or unmeasurable. */
        int gatedBlockCount{0};
    };

    /** Construct for the given sample rate. Rates other than 44100
     *  and 48000 throw a `juce::String` exception — loudness mode
     *  is only certified at the rates Silverdaw supports today. */
    explicit LoudnessAnalyzer(double sampleRate);

    /** Feed `numFrames` interleaved-by-channel samples. `channels`
     *  is an array of channel pointers (length `numChannels`); only
     *  the first two are read (mono is promoted by feeding ch0 to
     *  both internal channels). Cheap allocation-free path. */
    void process(const float* const* channels, int numChannels, int numFrames);

    /** Flush remaining samples into the gating buffer and compute
     *  the result. Idempotent; multiple calls return the cached
     *  result. */
    Result finalize();

    /** Re-gate the stored per-block K-weighted MS values assuming a
     *  linear gain of `gainDb` has been applied to the stream. The
     *  true-peak is shifted analytically by `+gainDb`. Returns a
     *  Result reflecting the post-gain measurement. Cheap (no DSP).
     *  MUST be called only after `finalize()`. */
    Result computeForLinearGainDb(double gainDb) const;

    /** Reset all state so the analyser can be reused for a second
     *  pass on a fresh stream. */
    void reset();

private:
    struct Biquad
    {
        double b0{1.0}, b1{0.0}, b2{0.0};
        double a1{0.0}, a2{0.0};
        // Direct-form-II transposed state, per channel (L, R).
        std::array<double, 2> z1{0.0, 0.0};
        std::array<double, 2> z2{0.0, 0.0};
        inline float process(int ch, double x) noexcept
        {
            const double y = b0 * x + z1[ch];
            z1[ch] = b1 * x - a1 * y + z2[ch];
            z2[ch] = b2 * x - a2 * y;
            return static_cast<float>(y);
        }
        void resetState() noexcept
        {
            z1 = {0.0, 0.0};
            z2 = {0.0, 0.0};
        }
    };

    void pushKWeightedSample(double xL, double xR);
    void closeBlock();

    static Biquad designKHighShelf(double fs);
    static Biquad designKHighPass(double fs);

    double sampleRate_{48000.0};
    Biquad hsFilter_{};
    Biquad hpFilter_{};

    // 400 ms block formed by overlapping 4 sub-blocks of 100 ms each
    // (BS.1770 75% overlap). We accumulate per-sample sum-of-squares
    // into the current sub-block; on each 100 ms boundary the totals
    // are pushed into a 4-slot ring buffer and (once filled) the sum
    // of the 4 slots becomes one gating block.
    int blockFrames_{0};
    int stepFrames_{0};
    int frameCursor_{0};
    int64_t totalFramesSeen_{0};

    // Per-channel running sum of squared K-weighted samples for the
    // current sub-block. Reset on each sub-block boundary.
    double sumSqL_{0.0};
    double sumSqR_{0.0};

    static constexpr int kSubBlocksPerBlock = 4;
    struct SubBlock { double sumSqL{0.0}; double sumSqR{0.0}; };
    std::array<SubBlock, kSubBlocksPerBlock> subBlocks_{};
    int subBlockWriteIdx_{0};
    int subBlocksFilled_{0};

    // Block MS sums (G_L·MSL + G_R·MSR with G=1.0) stored per
    // overlapping gating block. Used at finalize() and by
    // `computeForLinearGainDb`.
    std::vector<double> blockMs_;

    // Running ungated total (sum of all block MS sums and count) so
    // a fallback "single big block" measurement is available when
    // no 400 ms block was ever closed.
    double ungatedRunningSum_{0.0};
    int ungatedRunningCount_{0};

    // True-peak oversampler state (per channel).
    struct TruePeak
    {
        // 4× polyphase FIR, 16 taps per phase (64 effective taps),
        // designed once at construction. The four phase tables are
        // packed contiguously: [phase0_tap0..15, phase1_tap0..15, ...].
        static constexpr int kPhases = 4;
        static constexpr int kTapsPerPhase = 16;
        std::array<float, kPhases * kTapsPerPhase> coefs{};
        // Per-channel sliding history of recent input samples
        // (length kTapsPerPhase). Initialised to 0.
        std::array<std::array<float, kTapsPerPhase>, 2> history{};
        std::array<int, 2> writeIdx{0, 0};
        double maxAbs{0.0};
    } truePeak_;
    void buildTruePeakFir();
    void pushTruePeakSample(int ch, float sample);

    bool finalized_{false};
    Result cachedResult_{};
};

} // namespace silverdaw
