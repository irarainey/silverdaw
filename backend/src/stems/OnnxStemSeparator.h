#pragma once

// ONNX Runtime-backed stem separator. Compiled only when the build enables stem
// separation (SILVERDAW_STEM_SEPARATION); the factory falls back to a stub
// otherwise. Each htdemucs-ft .onnx is a per-source specialist that takes the
// mixture waveform and returns that source's isolated waveform, so separation is
// one session run per stem.

#include <memory>

#include "StemSeparator.h"

namespace silverdaw
{

std::unique_ptr<StemSeparator> makeOnnxStemSeparator();

} // namespace silverdaw
