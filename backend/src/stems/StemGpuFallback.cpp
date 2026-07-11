#include "StemGpuFallback.h"

#include <algorithm>

namespace silverdaw
{

bool isRecoverableGpuFaultMessage(const juce::String& message)
{
    const auto lower = message.toLowerCase();
    const bool deviceLost = lower.contains("device removed") || lower.contains("device hung") ||
                            lower.contains("device reset") || lower.contains("device lost") ||
                            lower.contains("dxgi_error_device") || lower.contains("887a00");
    const bool outOfMemory = lower.contains("8007000e") || lower.contains("e_outofmemory") ||
                             lower.contains("not enough memory") || lower.contains("out of memory");
    return deviceLost || outOfMemory;
}

double mapStemRetryPercent(double completedPercent, double retryPercent) noexcept
{
    const double base = std::clamp(completedPercent, 0.0, 100.0);
    const double retry = std::clamp(retryPercent, 0.0, 100.0);
    return base + (100.0 - base) * retry / 100.0;
}

bool StemGpuFallbackState::shouldUseGpu(bool requested) const noexcept
{
    return requested && ! quarantined;
}

bool StemGpuFallbackState::isQuarantined() const noexcept
{
    return quarantined;
}

void StemGpuFallbackState::quarantine() noexcept
{
    quarantined = true;
}

StemReadyTransaction::StemReadyTransaction(const StemReadyFn& publishFn)
    : publish(publishFn)
{
}

void StemReadyTransaction::stage(const StemResultFile& stem)
{
    staged.push_back(stem);
}

void StemReadyTransaction::commit()
{
    for (const auto& stem : staged)
        publish(stem);
    staged.clear();
}

} // namespace silverdaw
