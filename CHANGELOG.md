# Changelog

## 1.0.1

- Fixed a crash when opening the Stems tab in Preferences on installed builds.
- Fixed first-use stem separation to download the RoFormer quality models (vocals + drums/bass) together by default, instead of the backup model.
- Fixed stem separation failing with a "Model directory not found" error when only the RoFormer models are installed; the backup model is no longer required for a fully pack-covered separation.
- Fixed the recent projects list showing a project's old name after it was renamed and saved.
- Changed first-use stem separation to show the model download prompt before the stem picker, so models are fetched first and stems are chosen once they're ready.
- Refined the Clip Editor waveform so short (and deeply zoomed-in) clips draw a smooth envelope instead of a blocky, pixelated one.
- Grouped the backup separation model with the quality models in Preferences ▸ Stems, with a note that it is only used as a fallback.
- Added a link to the Silverdaw website in the About dialog.

## 1.0.0

- Initial release
