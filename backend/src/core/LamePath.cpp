#include "LamePath.h"

namespace silverdaw
{

juce::File findLameExecutable()
{
    const auto exeDir = juce::File::getSpecialLocation(juce::File::currentExecutableFile).getParentDirectory();
#if JUCE_WINDOWS
    return exeDir.getChildFile("lame.exe");
#else
    return exeDir.getChildFile("lame");
#endif
}

} // namespace silverdaw
