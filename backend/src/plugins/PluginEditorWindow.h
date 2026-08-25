#pragma once

#include <functional>
#include <memory>

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace silverdaw::plugins
{

// A plugin's own native editor, hosted in a backend-owned desktop window (ADR 0025). The
// renderer never draws plugin UI: it only asks the backend to open one of these. Message
// thread only.
class PluginEditorWindow final : public juce::DocumentWindow
{
  public:
    // `onClosed` fires when the user closes the window, so the owner can drop this object.
    PluginEditorWindow(juce::AudioPluginInstance& plugin, const juce::String& windowTitle,
                       std::function<void()> onClosed);
    ~PluginEditorWindow() override;

    /** Raises and focuses the window, working around the OS foreground lock (see the .cpp). */
    void bringToFrontAndFocus();

    void closeButtonPressed() override;

  private:
    std::function<void()> closedCallback;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PluginEditorWindow)
};

} // namespace silverdaw::plugins
