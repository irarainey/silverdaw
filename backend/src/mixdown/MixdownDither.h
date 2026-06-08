#pragma once

// TPDF dither primitives shared by the mixdown render pump (MixdownRender.cpp)
// and the Normalize pass-2 quantiser (MixdownNormalize.cpp). Both must use the
// exact same generator and call order so the dithered 16-bit output is
// identical regardless of which pass writes the final container.

#include <cstdint>

namespace silverdaw::mixdown_dither
{

// One LSB at 16-bit in normalised float — the quantisation step the triangular
// dither is scaled to (±1 LSB peak).
constexpr float kLsb16f = 1.0f / 32768.0f;

// Per-channel xorshift32 PRNG. Two independent uniform draws summed per sample
// form a triangular PDF; independent L/R generators decorrelate the channels.
struct Xorshift32 { std::uint32_t state; };

inline float nextUniform(Xorshift32& s)
{
    std::uint32_t x = s.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    s.state = x ? x : 1u;
    return static_cast<float>(s.state) * (1.0f / 4294967296.0f);
}

} // namespace silverdaw::mixdown_dither
