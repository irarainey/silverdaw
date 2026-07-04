# Changelog

## 1.0.2

### Added

- More detail in the always-on startup diagnostics log — system information, startup timing, and the audio devices the engine found and opened — to make a slow or failed start (and audio-device problems) easier to diagnose.

### Changed

- Faster startup: the main window and project screen now appear almost immediately while the audio engine starts up in the background, instead of waiting for it first.
- Faster project loading, especially for projects with many clips — their audio files are now prepared together rather than one at a time.
- Projects with many clips that share the same audio now draw their waveforms faster, by reusing the shared waveform detail instead of rebuilding it for every clip.

### Fixed

- "Unable to connect to audio engine" on some freshly installed machines, caused by a missing Windows runtime component that is now included with the app.
- A sleep-prone USB output device (such as a USB DAC) not being woken in time on startup, so the first play was silent; the device is now roused before playback begins.
- The saved output device not being selected on startup when it was slow to appear (for example, a USB device still starting up); the app now picks it up as soon as it's ready and switches to it automatically.
- The first play being silent right after switching to a sleep-prone output device from the transport bar.
- Dropping a clip whose source has a variable tempo silently not matching it to the project tempo; the app now shows a brief note explaining why it wasn't tempo-matched.
- Dragging the playhead to the left not scrolling the timeline (only dragging right did); it now follows the playhead in both directions.
- The cursor not showing a grabbing hand while dragging the playhead, and flickering back to the arrow when the timeline started scrolling mid-drag; it now stays a hand throughout the drag.

## 1.0.1

### Added

- A link to the Silverdaw website in the About dialog.
- Always-on startup diagnostics: every launch writes a small startup log — and a crash report if the backend faults — to a fixed `diagnostics` folder in the app's data directory, independent of the diagnostic-logging preference, to help diagnose a failure to start. These files are overwritten each launch and are not used for ongoing session logging.

### Changed

- First-use stem separation now shows the model download prompt before the stem picker, so the models are downloaded first and the stems are chosen once they're ready.
- The backup separation model is now grouped with the quality models in Preferences ▸ Stems, with a note that it is only used as a fallback.
- The stem separation progress dialog now stays open (showing "Writing files…") until the stems have been placed on the timeline, instead of closing a few seconds before the new clips appear.

### Fixed

- A crash when opening the Stems tab in Preferences on installed builds.
- First-use stem separation downloaded the backup model instead of the higher-quality RoFormer models (vocals + drums/bass); it now downloads the RoFormer models together by default.
- Stem separation failing with a "Model directory not found" error when only the RoFormer models are installed; the backup model is no longer required for a fully pack-covered separation.
- The recent projects list showing a project's old name after it was renamed and saved.
- The Clip Editor waveform looking blocky and pixelated on short or deeply zoomed-in clips; it now draws a smooth envelope.
- The Split at Playhead menu item and S shortcut silently doing nothing on a saved clip; they now show the same informational "linked clips must be edited in the Clip Editor" message as the right-click menu.
- The stem separation progress bar appearing frozen (and the interface unresponsive) while separating on the CPU; inference now leaves one processor core free for the interface so the progress bar keeps updating throughout.
- Stem separation failing with a "Library item not found" error when run on a clip that was itself an already-separated stem (or any clip derived from a source no longer in the library); a clip now separates its own audio rather than the original source, so re-separating a stem works.

## 1.0.0

- Initial release
