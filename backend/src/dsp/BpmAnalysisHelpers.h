#pragma once

// Internal-only declarations for BpmDetector's DSP helpers.
// Include ONLY from BpmDetector.cpp and BpmAnalysisHelpers.cpp.

#include <vector>

namespace silverdaw
{

// Declared here (not BpmDetector.h) because it is implementation-internal
// and called only by BpmDetector::analyse.
bool refineGridFromOdfPeaks(const std::vector<double>& odf, double envRate, double groupDelaySec,
                            double periodSec, double anchorSec, double& outPeriod, double& outAnchor,
                            int& outMatched);

namespace bpm_detail
{

bool fitPeriodAndAnchor(const std::vector<double>& beats, double initialPeriod, double initialAnchor,
                        double& outPeriod, double& outAnchor, double& outRmsResidual, int& outKeptCount);

std::vector<double> computeOdf(const std::vector<float>& signal, int envHop);

double autocorrPreferredLag(const std::vector<double>& odf, int minLag, int maxLag, double preferredLag);

double findBestAnchor(const std::vector<double>& odf, double envRate, double periodSec,
                      double fallbackAnchor);

void scoreGridAgainstBeats(const std::vector<double>& beats, double period, double anchor,
                           double& outRms, int& outKept);

} // namespace bpm_detail
} // namespace silverdaw
