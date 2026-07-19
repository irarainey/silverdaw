#pragma once

#include <algorithm>
#include <cmath>

namespace silverdaw::bit_crusher
{

inline constexpr int kMinBits = 1;
inline constexpr int kMaxBits = 16;
inline constexpr float kMinRate = 0.01F;

inline float sanitizeUnit(double value) noexcept
{
    const double safeValue = std::isfinite(value) ? value : 0.0;
    return static_cast<float>(std::clamp(safeValue, 0.0, 1.0));
}

inline float sanitizeRate(double value) noexcept
{
    const double safeValue = std::isfinite(value) ? value : 1.0;
    return static_cast<float>(std::clamp(safeValue, static_cast<double>(kMinRate), 1.0));
}

inline int sanitizeBits(double value) noexcept
{
    const double safeValue = std::isfinite(value) ? value : static_cast<double>(kMaxBits);
    return static_cast<int>(std::lround(
        std::clamp(safeValue, static_cast<double>(kMinBits), static_cast<double>(kMaxBits))));
}

} // namespace silverdaw::bit_crusher
