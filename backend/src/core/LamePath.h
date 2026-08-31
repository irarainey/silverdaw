#pragma once

#include <juce_core/juce_core.h>

namespace silverdaw
{

// Location of the bundled `lame.exe`, which sits beside the backend executable.
//
// LAME is used for two distinct jobs, so this lives in core rather than in either
// caller: MP3 *encoding* on export (via juce::LAMEEncoderAudioFormat) and MP3
// *decoding* on import (DecodedCache). Both must agree on where the binary is.
juce::File findLameExecutable();

} // namespace silverdaw
