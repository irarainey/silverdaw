#pragma once

// Per-domain test registration. Each translation unit owns one domain's test
// functions (in its own anonymous namespace) and exposes a single add function
// that appends its TestCases to the shared registry assembled in main().

#include "TestSupport.h"

#include <vector>

namespace silverdaw::tests
{

void addProjectStateTests(std::vector<TestCase>& tests);
void addProjectStateFxTests(std::vector<TestCase>& tests);
void addPersistenceTests(std::vector<TestCase>& tests);
void addBridgeTests(std::vector<TestCase>& tests);
void addWarpTests(std::vector<TestCase>& tests);
void addAudioEngineTests(std::vector<TestCase>& tests);
void addFxDspTests(std::vector<TestCase>& tests);
void addLoudnessTests(std::vector<TestCase>& tests);
void addEnvelopeFadeTests(std::vector<TestCase>& tests);
void addAutomationTests(std::vector<TestCase>& tests);
void addMixdownRenderTests(std::vector<TestCase>& tests);
void addStemSeparationTests(std::vector<TestCase>& tests);
void addBpmDetectorTests(std::vector<TestCase>& tests);
void addVocalEnhancerTests(std::vector<TestCase>& tests);
void addVocalDenoiserTests(std::vector<TestCase>& tests);
void addDrumEnhancerTests(std::vector<TestCase>& tests);
void addBassEnhancerTests(std::vector<TestCase>& tests);
void addOtherEnhancerTests(std::vector<TestCase>& tests);
void addMelRoformerSpectralTests(std::vector<TestCase>& tests);

} // namespace silverdaw::tests
