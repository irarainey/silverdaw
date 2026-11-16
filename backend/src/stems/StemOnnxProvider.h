#pragma once

#include <onnxruntime_cxx_api.h>

namespace silverdaw
{

// Returns the configured mode, including CPU fallback after GPU initialisation fails.
bool configureStemOnnxProvider(Ort::SessionOptions& options, bool useGpu);

} // namespace silverdaw
