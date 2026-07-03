# Changelog

## 1.0.1

### Added

- A link to the Silverdaw website in the About dialog.
- Always-on startup diagnostics: every launch writes a small startup log — and a crash report if the backend faults — to a fixed `diagnostics` folder in the app's data directory, independent of the diagnostic-logging preference, to help diagnose a failure to start. These files are overwritten each launch and are not used for ongoing session logging.

### Changed

- First-use stem separation now shows the model download prompt before the stem picker, so the models are downloaded first and the stems are chosen once they're ready.
- The backup separation model is now grouped with the quality models in Preferences ▸ Stems, with a note that it is only used as a fallback.

### Fixed

- A crash when opening the Stems tab in Preferences on installed builds.
- First-use stem separation downloaded the backup model instead of the higher-quality RoFormer models (vocals + drums/bass); it now downloads the RoFormer models together by default.
- Stem separation failing with a "Model directory not found" error when only the RoFormer models are installed; the backup model is no longer required for a fully pack-covered separation.
- The recent projects list showing a project's old name after it was renamed and saved.
- The Clip Editor waveform looking blocky and pixelated on short or deeply zoomed-in clips; it now draws a smooth envelope.
- The Split at Playhead menu item and S shortcut silently doing nothing on a saved clip; they now show the same informational "linked clips must be edited in the Clip Editor" message as the right-click menu.

## 1.0.0

- Initial release
