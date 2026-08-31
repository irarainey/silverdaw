#pragma once

// Internal-only declarations for BpmDetector's DSP helpers.
// Include from BpmDetector.cpp, BpmAnalysisHelpers.cpp, the bpm_eval
// calibration harness and the DSP tests — the harness and the tests must
// exercise the shipped implementation, not a copy of it.

#include <vector>

namespace silverdaw
{

// Declared here (not BpmDetector.h) because it is implementation-internal
// and called only by BpmDetector::analyse.
bool refineGridFromOdfPeaks(const std::vector<double>& odf, double envRate, double groupDelaySec,
                            double periodSec, double anchorSec, double& outPeriod, double& outAnchor,
                            int& outMatched);

// Calibrated on a corpus with known beat times: 0.75 minimises mean |offset|
// across click, drum and pad material (2.68 ms -> 0.52 ms) and, more
// importantly, collapses the spread between those materials to under 1 ms.
// Lower fractions overshoot early, higher ones leave drums late.
inline constexpr double kOnsetBacktrackFraction = 0.75;
inline constexpr double kOnsetBacktrackMaxSec = 0.120;

// Sub-frame estimate of where the transient that produced an ODF peak began.
// `backtrackFraction` is a parameter so the bpm_eval harness can sweep it
// against ground truth WITHOUT reimplementing the algorithm — calibrating one
// implementation and shipping another is exactly how this constant would drift
// out of validity.
double estimateOnsetStartFrames(const std::vector<double>& odf, int peakIdx, double peakFrames,
                                double envRate,
                                double backtrackFraction = kOnsetBacktrackFraction);

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
