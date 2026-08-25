#include "PluginEditorWindow.h"

#if JUCE_WINDOWS
#include <windows.h>
#endif

namespace silverdaw::plugins
{
#if JUCE_WINDOWS
namespace
{
// Windows refuses SetForegroundWindow to a process that does not already own the foreground.
// The backend is a headless console process and the renderer is what the user just clicked,
// so a plugin editor would otherwise open behind the app window with only a flashing taskbar
// button. Briefly joining the foreground thread's input queue makes the call legal, which is
// the documented way for a helper process to raise a window the user explicitly asked for.
void forceWindowToForeground(void* windowHandle)
{
    auto* hwnd = static_cast<HWND>(windowHandle);
    if (hwnd == nullptr) return;

    const auto foregroundThread =
        ::GetWindowThreadProcessId(::GetForegroundWindow(), nullptr);
    const auto thisThread = ::GetCurrentThreadId();
    const bool attached = foregroundThread != 0 && foregroundThread != thisThread
                          && ::AttachThreadInput(foregroundThread, thisThread, TRUE) != 0;

    ::SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
    ::SetForegroundWindow(hwnd);
    ::SetActiveWindow(hwnd);

    if (attached) ::AttachThreadInput(foregroundThread, thisThread, FALSE);
}
} // namespace
#endif

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
    bringToFrontAndFocus();
}

void PluginEditorWindow::bringToFrontAndFocus()
{
    setMinimised(false);
    toFront(true);

#if JUCE_WINDOWS
    forceWindowToForeground(getWindowHandle());
#endif
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
