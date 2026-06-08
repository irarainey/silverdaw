#pragma once

// Shared TPDF dither keeps 16-bit output identical across render paths.

#include <cstdint>

namespace silverdaw::mixdown_dither
{

constexpr float kLsb16f = 1.0f / 32768.0f;

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
