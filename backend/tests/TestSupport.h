#pragma once

// Shared support for the custom backend test harness: the TestCase contract,
// the require/requireNear assertion helpers, and a handful of generic test
// utilities (temp dirs, throwaway WAVs, ValueTree equivalence, a constant
// audio source) reused across the per-domain test translation units.

#include "ValueTreeJson.h"

#include <functional>
#include <limits>
#include <stdexcept>
#include <string>

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace silverdaw::tests
{

using TestFn = std::function<void()>;

struct TestCase
{
    const char* name;
    TestFn fn;
};

inline void require(bool condition, const char* message)
{
    if (!condition)
    {
        throw std::runtime_error(message);
    }
}

inline void requireEqual(const juce::String& actual, const juce::String& expected, const char* message)
{
    if (actual != expected)
    {
        throw std::runtime_error(std::string(message) + " (actual='" + actual.toStdString() + "', expected='"
                                 + expected.toStdString() + "')");
    }
}

inline void requireNear(double actual, double expected, double epsilon, const char* message)
{
    if (std::abs(actual - expected) > epsilon)
    {
        throw std::runtime_error(std::string(message) + " (actual=" + std::to_string(actual)
                                 + ", expected=" + std::to_string(expected) + ")");
    }
}

inline juce::File makeTempDir(const juce::String& name)
{
    auto dir = juce::File::getSpecialLocation(juce::File::tempDirectory)
                   .getChildFile("SilverdawBackendTests")
                   .getChildFile(name + "-" + juce::Uuid().toString());
    const auto created = dir.createDirectory();
    if (created.failed())
    {
        throw std::runtime_error("failed to create temp dir: " + created.getErrorMessage().toStdString());
    }
    return dir;
}

inline void expectTreeEquivalent(const juce::ValueTree& actual, const juce::ValueTree& expected)
{
    const auto actualJson = juce::JSON::toString(silverdaw::ValueTreeJson::toVar(actual), true);
    const auto expectedJson = juce::JSON::toString(silverdaw::ValueTreeJson::toVar(expected), true);
    requireEqual(actualJson, expectedJson, "ValueTree JSON mismatch");
}

// A representative project ValueTree (track + clip + library item + markers)
// used as a fixture by the ProjectState and persistence round-trip tests.
inline juce::ValueTree makeProjectTree()
{
    juce::ValueTree project(juce::Identifier{"PROJECT"});
    project.setProperty("name", "Roundtrip", nullptr);
    project.setProperty("bpm", 123.45, nullptr);

    juce::ValueTree track(juce::Identifier{"TRACK"});
    track.setProperty("id", "t1", nullptr);
    track.setProperty("name", "Drums", nullptr);
    track.setProperty("gain", 0.75, nullptr);

    juce::ValueTree clip(juce::Identifier{"CLIP"});
    clip.setProperty("id", "c1", nullptr);
    clip.setProperty("libraryItemId", "lib1", nullptr);
    clip.setProperty("offsetMs", 1000.0, nullptr);
    clip.setProperty("inMs", 250.0, nullptr);
    clip.setProperty("durationMs", 4000.0, nullptr);
    clip.setProperty("colorIndex", 3, nullptr);
    track.appendChild(clip, nullptr);

    project.appendChild(track, nullptr);
    // Library holds the single source-of-truth filePath. Clips
    // reference it by id.
    juce::ValueTree library(juce::Identifier{"LIBRARY"});
    juce::ValueTree libItem(juce::Identifier{"ITEM"});
    libItem.setProperty("id", "lib1", nullptr);
    libItem.setProperty("filePath", "C:\\audio\\loop.wav", nullptr);
    libItem.setProperty("kind", "audio-file", nullptr);
    library.appendChild(libItem, nullptr);
    project.appendChild(library, nullptr);
    project.appendChild(juce::ValueTree(juce::Identifier{"MARKERS"}), nullptr);
    return project;
}

// A trivial positionable source that fills every requested sample with a
// constant value on all channels. Driving an OffsetSource with it exposes
// exactly the gain its envelope + edge-fade layers applied to the block.
class ConstantSource : public juce::PositionableAudioSource
{
  public:
    explicit ConstantSource(float v) : value(v) {}
    void prepareToPlay(int, double) override {}
    void releaseResources() override {}
    void getNextAudioBlock(const juce::AudioSourceChannelInfo& info) override
    {
        for (int ch = 0; ch < info.buffer->getNumChannels(); ++ch)
        {
            auto* d = info.buffer->getWritePointer(ch, info.startSample);
            for (int i = 0; i < info.numSamples; ++i) d[i] = value;
        }
        pos += info.numSamples;
    }
    void setNextReadPosition(juce::int64 p) override { pos = p; }
    juce::int64 getNextReadPosition() const override { return pos; }
    juce::int64 getTotalLength() const override { return std::numeric_limits<juce::int64>::max(); }
    bool isLooping() const override { return false; }

  private:
    float value;
    juce::int64 pos = 0;
};

} // namespace silverdaw::tests
