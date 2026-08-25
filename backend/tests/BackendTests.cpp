// Backend test entry point. The per-domain test functions live in sibling
// translation units (see TestRegistry.h); this file just assembles the
// registry, runs the custom harness loop, and reports pass/fail.

#include "TestRegistry.h"

#include "PluginScanWorker.h"

#include <iostream>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include <juce_events/juce_events.h>

namespace
{
using namespace silverdaw::tests;

// Assemble the full registry. Building it is cheap (each entry is just a name +
// lambda); running JUCE / audio code only happens when a test's fn() is called.
// Registrars are listed with their names so a domain that silently contributes
// nothing can be named in the error.
struct DomainRegistrar
{
    const char* domain;
    void (*add)(std::vector<TestCase>&);
};

constexpr DomainRegistrar kRegistrars[] = {
    {"ProjectState", addProjectStateTests},
    {"ProjectStateFx", addProjectStateFxTests},
    {"ProjectStateTrackPlugins", addProjectStateTrackPluginTests},
    {"Persistence", addPersistenceTests},
    {"Bridge", addBridgeTests},
    {"MidiControllerMapping", addMidiControllerMappingTests},
    {"Warp", addWarpTests},
    {"ScratchDsp", addScratchDspTests},
    {"BackingMonitorSource", addBackingMonitorSourceTests},
    {"ScratchProtocol", addScratchProtocolTests},
    {"ScratchSession", addScratchSessionTests},
    {"ScratchRecorder", addScratchRecorderTests},
    {"AudioEngine", addAudioEngineTests},
    {"FxDsp", addFxDspTests},
    {"Loudness", addLoudnessTests},
    {"EnvelopeFade", addEnvelopeFadeTests},
    {"Automation", addAutomationTests},
    {"BeatRepeat", addBeatRepeatTests},
    {"MixdownRender", addMixdownRenderTests},
    {"StemSeparation", addStemSeparationTests},
    {"BpmDetector", addBpmDetectorTests},
    {"VocalEnhancer", addVocalEnhancerTests},
    {"VocalDenoiser", addVocalDenoiserTests},
    {"Dereverberator", addDereverberatorTests},
    {"VocalRestorer", addVocalRestorerTests},
    {"DrumEnhancer", addDrumEnhancerTests},
    {"BassEnhancer", addBassEnhancerTests},
    {"OtherEnhancer", addOtherEnhancerTests},
    {"MelRoformerSpectral", addMelRoformerSpectralTests},
    {"BsRoformerSpectral", addBsRoformerSpectralTests},
    {"LibraryCleanup", addLibraryCleanupTests},
    {"ScratchPatternPersistence", addScratchPatternPersistenceTests},
    {"ScratchPatternEvaluator", addScratchPatternEvaluatorTests},
    {"ScratchPatternReplayProjectState", addScratchPatternReplayProjectStateTests},
    {"PluginCatalogue", addPluginCatalogueTests},
    {"PluginChain", addPluginChainTests},
    {"PluginLatency", addPluginLatencyTests},
};

// Structural validation of the assembled registry. Guards the failures that
// would otherwise leave CTest green while tests went missing: a domain that
// registers nothing, and a name that breaks discovery — CTest keys each case on
// its exact name, so an empty, duplicate, or non-ASCII name loses a test.
std::string validateRegistry(const std::vector<TestCase>& tests,
                             const std::vector<std::pair<const char*, std::size_t>>& perDomainCounts)
{
    for (const auto& [domain, count] : perDomainCounts)
    {
        if (count == 0) return std::string("domain '") + domain + "' registered no tests";
    }

    std::set<std::string> seen;
    for (const auto& test : tests)
    {
        if (test.name == nullptr || *test.name == '\0') return "a test has an empty name";
        for (const char* c = test.name; *c != '\0'; ++c)
        {
            if (static_cast<unsigned char>(*c) > 0x7F)
                return std::string("test name is not ASCII: '") + test.name + "'";
        }
        if (!seen.insert(test.name).second)
            return std::string("duplicate test name: '") + test.name + "'";
        if (!test.fn) return std::string("test has no function: '") + test.name + "'";
    }
    return {};
}

std::vector<TestCase> buildRegistry(std::vector<std::pair<const char*, std::size_t>>& perDomainCounts)
{
    std::vector<TestCase> tests;
    for (const auto& registrar : kRegistrars)
    {
        const auto before = tests.size();
        registrar.add(tests);
        perDomainCounts.emplace_back(registrar.domain, tests.size() - before);
    }
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

    // The scan coordinator relaunches whichever executable is running, which under test is
    // this harness. Answering the worker command line here keeps the child-process scan path
    // testable instead of the child failing as an unknown argument.
    {
        juce::StringArray commandLineArgs;
        for (int i = 1; i < argc; ++i)
            commandLineArgs.add(juce::String{argv[i]});
        const auto commandLine = commandLineArgs.joinIntoString(" ");

        if (silverdaw::plugins::isScanWorkerCommandLine(commandLine))
            return silverdaw::plugins::runScanWorker(commandLine);
    }

    std::vector<std::pair<const char*, std::size_t>> perDomainCounts;
    const auto tests = buildRegistry(perDomainCounts);
    if (const auto problem = validateRegistry(tests, perDomainCounts); !problem.empty())
    {
        std::cerr << "backend test registry is invalid: " << problem << '\n';
        return 2;
    }

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
