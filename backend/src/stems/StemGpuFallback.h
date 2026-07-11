#pragma once

#include <vector>

#include <juce_core/juce_core.h>

#include "StemSeparator.h"

namespace silverdaw
{

bool isRecoverableGpuFaultMessage(const juce::String& message);
double mapStemRetryPercent(double completedPercent, double retryPercent) noexcept;

class StemGpuFallbackState
{
public:
    bool shouldUseGpu(bool requested) const noexcept;
    bool isQuarantined() const noexcept;
    void quarantine() noexcept;

private:
    bool quarantined = false;
};

class StemReadyTransaction
{
public:
    explicit StemReadyTransaction(const StemReadyFn& publish);

    void stage(const StemResultFile& stem);
    void commit();

private:
    StemReadyFn publish;
    std::vector<StemResultFile> staged;
};

} // namespace silverdaw
