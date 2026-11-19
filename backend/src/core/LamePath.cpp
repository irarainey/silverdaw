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

int lameTimeoutMsFor(const juce::File& sourceFile)
{
    const auto megabytes = static_cast<double>(sourceFile.getSize()) / (1024.0 * 1024.0);
    return static_cast<int>(juce::jlimit(60'000.0, 600'000.0, megabytes * 10'000.0));
}

} // namespace silverdaw
