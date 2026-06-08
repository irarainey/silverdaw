#pragma once

#include <array>
#include <cstdint>
#include <vector>

#include <juce_core/juce_core.h>

namespace silverdaw
{

// BS.1770-4 loudness + true-peak analyser for the writer's stereo float stream.
// Stores per-block MS so post-gain loudness can re-gate instead of adding gain blindly.
// Not thread-safe: construct, process, finalize, and destroy on one thread.
class LoudnessAnalyzer
{
public:
    struct Result
    {
        /** `silent` means `-inf`; guard before mapping to JSON. */
        double integratedLufs{0.0};
        /** `silent` means `-inf`. */
        double truePeakDbtp{0.0};
        /** Distinct from `unmeasurable`: no sample exceeded the absolute-gate floor. */
        bool silent{false};
        /** Uses a whole-signal fallback when no 400 ms block survives gating. */
        bool unmeasurable{false};
        int gatedBlockCount{0};
    };

    /** Throws for rates other than the supported 44.1/48 kHz analysis paths. */
    explicit LoudnessAnalyzer(double sampleRate);

    /** Allocation-free; mono is promoted into the internal stereo analysis path. */
    void process(const float* const* channels, int numChannels, int numFrames);

    /** Idempotent; later calls return the cached result. */
    Result finalize();

    /** Re-gates stored MS after linear gain; call only after `finalize()`. */
    Result computeForLinearGainDb(double gainDb) const;

    void reset();

private:
    struct Biquad
    {
        double b0{1.0}, b1{0.0}, b2{0.0};
        double a1{0.0}, a2{0.0};
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

    // BS.1770 gating uses 400 ms blocks with 75% overlap.
    int blockFrames_{0};
    int stepFrames_{0};
    int frameCursor_{0};
    int64_t totalFramesSeen_{0};

    double sumSqL_{0.0};
    double sumSqR_{0.0};

    static constexpr int kSubBlocksPerBlock = 4;
    struct SubBlock { double sumSqL{0.0}; double sumSqR{0.0}; };
    std::array<SubBlock, kSubBlocksPerBlock> subBlocks_{};
    int subBlockWriteIdx_{0};
    int subBlocksFilled_{0};

    // Stored so post-gain measurements can re-gate analytically.
    std::vector<double> blockMs_;

    // Fallback for streams too short to close a 400 ms block.
    double ungatedRunningSum_{0.0};
    int ungatedRunningCount_{0};

    struct TruePeak
    {
        // 4× polyphase FIR table, packed by phase.
        static constexpr int kPhases = 4;
        static constexpr int kTapsPerPhase = 16;
        std::array<float, kPhases * kTapsPerPhase> coefs{};
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
