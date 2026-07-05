#include "InferenceThreads.h"

#include <algorithm>
#include <thread>

#ifdef _WIN32
#include <cstddef>
#include <vector>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace silverdaw::stems
{
namespace
{
#ifdef _WIN32
// Number of PHYSICAL cores (one record per core, regardless of efficiency
// class), or 0 if the topology can't be read. This deliberately counts all
// cores — P and E — because on non-hyperthreaded hybrid CPUs the efficiency
// cores contribute real throughput with no sibling contention; it just excludes
// hyperthread siblings, which is where oversubscription actually hurts.
int detectPhysicalCores() noexcept
{
    DWORD length = 0;
    GetLogicalProcessorInformationEx(RelationProcessorCore, nullptr, &length);
    if (length == 0) return 0;

    std::vector<std::byte> buffer(static_cast<size_t>(length));
    if (! GetLogicalProcessorInformationEx(
              RelationProcessorCore,
              reinterpret_cast<PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX>(buffer.data()), &length))
        return 0;

    const auto* const end = buffer.data() + length;
    int cores = 0;
    for (auto* p = buffer.data(); p < end;)
    {
        const auto* info = reinterpret_cast<const SYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX*>(p);
        if (info->Relationship == RelationProcessorCore) ++cores; // one record per physical core
        p += info->Size;
    }
    return cores;
}
#endif // _WIN32
} // namespace

int inferenceIntraOpThreads() noexcept
{
    const unsigned int logical = std::thread::hardware_concurrency();
    // Historical default: reserve two logical processors so the websocket/message
    // threads always have somewhere to run. This was fast on non-hyperthreaded
    // hybrid CPUs and is the throughput baseline we must not regress below.
    const int base = logical > 0u ? std::max(1, static_cast<int>(logical) - 2) : 1;

#ifdef _WIN32
    const int physical = detectPhysicalCores();
    if (physical > 0)
    {
        // One thread per physical core, but never more than the historical base.
        // - Hyperthreaded CPU (physical < logical): physical < base, so this drops
        //   the HT siblings that caused oversubscription slowdowns.
        // - Non-HT CPU (physical == logical): base (logical - 2) wins, matching the
        //   long-standing, known-fast thread count.
        return std::max(1, std::min(base, physical));
    }
#endif
    return base;
}

} // namespace silverdaw::stems
