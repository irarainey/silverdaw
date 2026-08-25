#include "PluginEditorWindow.h"

namespace silverdaw::plugins
{

PluginEditorWindow::PluginEditorWindow(juce::AudioPluginInstance& plugin,
                                       const juce::String& windowTitle,
                                       std::function<void()> onClosed)
    : juce::DocumentWindow(windowTitle, juce::Colours::black, juce::DocumentWindow::closeButton),
      closedCallback(std::move(onClosed))
{
    // A plugin without its own editor still gets a window, using JUCE's generic parameter
    // list, so every hosted effect stays adjustable (ADR 0025).
    auto* editor = plugin.hasEditor() ? plugin.createEditorIfNeeded() : nullptr;
    if (editor == nullptr) editor = new juce::GenericAudioProcessorEditor(plugin);

    setUsingNativeTitleBar(true);
    setContentOwned(editor, true);
    setResizable(editor->isResizable(), false);
    centreWithSize(getWidth(), getHeight());
    setVisible(true);
    toFront(true);
}

PluginEditorWindow::~PluginEditorWindow()
{
    clearContentComponent();
}

void PluginEditorWindow::closeButtonPressed()
{
    // Hide first: the callback destroys this window asynchronously, and a window that stays
    // painted until then reads as an unresponsive close.
    setVisible(false);
    if (closedCallback) closedCallback();
}

} // namespace silverdaw::plugins
