// Backend test entry point. The per-domain test functions live in sibling
// translation units (see TestRegistry.h); this file just assembles the
// registry, runs the custom harness loop, and reports pass/fail.

#include "TestRegistry.h"

#include <iostream>
#include <vector>

#include <juce_events/juce_events.h>

int main()
{
    juce::ScopedJuceInitialiser_GUI juceInit;

    using namespace silverdaw::tests;

    std::vector<TestCase> tests;
    addProjectStateTests(tests);
    addProjectStateFxTests(tests);
    addPersistenceTests(tests);
    addBridgeTests(tests);
    addWarpTests(tests);
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
    addDrumEnhancerTests(tests);
    addBassEnhancerTests(tests);
    addOtherEnhancerTests(tests);
    addMelRoformerSpectralTests(tests);
    addBsRoformerSpectralTests(tests);
    addLibraryCleanupTests(tests);

    require(tests.size() == 174, "backend test registry should contain 174 tests");

    int failed = 0;
    for (const auto& test : tests)
    {
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

    if (failed > 0)
    {
        std::cerr << failed << " backend test(s) failed\n";
        return 1;
    }

    std::cout << tests.size() << " backend test(s) passed\n";
    return 0;
}
