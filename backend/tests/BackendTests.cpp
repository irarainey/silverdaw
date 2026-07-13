// Backend test entry point. The per-domain test functions live in sibling
// translation units (see TestRegistry.h); this file just assembles the
// registry, runs the custom harness loop, and reports pass/fail.

#include "TestRegistry.h"

#include <iostream>
#include <string>
#include <vector>

#include <juce_events/juce_events.h>

namespace
{
using namespace silverdaw::tests;

// Assemble the full registry. Building it is cheap (each entry is just a name +
// lambda); running JUCE / audio code only happens when a test's fn() is called.
std::vector<TestCase> buildRegistry()
{
    std::vector<TestCase> tests;
    addProjectStateTests(tests);
    addProjectStateFxTests(tests);
    addPersistenceTests(tests);
    addBridgeTests(tests);
    addMidiControllerMappingTests(tests);
    addWarpTests(tests);
    addScratchDspTests(tests);
    addScratchProtocolTests(tests);
    addScratchSessionTests(tests);
    addScratchRecorderTests(tests);
    addAudioEngineTests(tests);
    addFxDspTests(tests);
    addLoudnessTests(tests);
    addEnvelopeFadeTests(tests);
    addAutomationTests(tests);
    addMixdownRenderTests(tests);
    addStemSeparationTests(tests);
    addBpmDetectorTests(tests);
    addVocalEnhancerTests(tests);
    addVocalDenoiserTests(tests);
    addDereverberatorTests(tests);
    addVocalRestorerTests(tests);
    addDrumEnhancerTests(tests);
    addBassEnhancerTests(tests);
    addOtherEnhancerTests(tests);
    addMelRoformerSpectralTests(tests);
    addBsRoformerSpectralTests(tests);
    addLibraryCleanupTests(tests);
    addScratchPatternPersistenceTests(tests);
    return tests;
}
} // namespace

// Usage:
//   SilverdawBackendTests             run every test (default; used by the dev script)
//   SilverdawBackendTests --list      print one test name per line and exit (test discovery)
//   SilverdawBackendTests --run NAME  run only the test whose name exactly matches NAME
int main(int argc, char** argv)
{
    using namespace silverdaw::tests;

    const auto tests = buildRegistry();
#if defined(SILVERDAW_STEM_SEPARATION)
    require(tests.size() == 288, "backend test registry should contain 288 tests");
#else
    require(tests.size() == 286, "backend test registry should contain 286 tests");
#endif

    bool listOnly = false;
    std::string runOnly;
    for (int i = 1; i < argc; ++i)
    {
        const std::string arg = argv[i];
        if (arg == "--list")
            listOnly = true;
        else if (arg == "--run" && i + 1 < argc)
            runOnly = argv[++i];
        else
        {
            std::cerr << "unknown argument: " << arg << '\n';
            return 2;
        }
    }

    // Discovery: list names without initialising JUCE or running any test.
    if (listOnly)
    {
        for (const auto& test : tests)
            std::cout << test.name << '\n';
        return 0;
    }

    juce::ScopedJuceInitialiser_GUI juceInit;

    int failed = 0;
    int ran = 0;
    for (const auto& test : tests)
    {
        if (!runOnly.empty() && runOnly != test.name)
            continue;

        ++ran;
        try
        {
            test.fn();
            std::cout << "[PASS] " << test.name << '\n';
        }
        catch (const std::exception& ex)
        {
            ++failed;
            std::cerr << "[FAIL] " << test.name << ": " << ex.what() << '\n';
        }
    }

    if (!runOnly.empty() && ran == 0)
    {
        std::cerr << "no test named '" << runOnly << "'\n";
        return 2;
    }

    if (failed > 0)
    {
        std::cerr << failed << " backend test(s) failed\n";
        return 1;
    }

    std::cout << ran << " backend test(s) passed\n";
    return 0;
}
