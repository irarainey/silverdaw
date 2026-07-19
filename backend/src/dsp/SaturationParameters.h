#pragma once

#include <algorithm>
#include <cmath>

namespace silverdaw::saturation
{

inline float sanitizeDrive(double value) noexcept
{
    const double safeValue = std::isfinite(value) ? value : 0.0;
    return static_cast<float>(std::clamp(safeValue, 0.0, 1.0));
}

inline float sanitizeMix(double value) noexcept
{
    const double safeValue = std::isfinite(value) ? value : 1.0;
    return static_cast<float>(std::clamp(safeValue, 0.0, 1.0));
}

} // namespace silverdaw::saturation
