# Changelog

## 1.0.2

### Added

- A Clip Editor metronome that clicks to the clip's tempo, saved with the project.
- Detailed startup diagnostics log to help diagnose slow or failed starts.

### Changed

- Library items now carry a distinct type badge — Track, Stem, or Sample — so their type reads at a glance.
- Opening a library track/stem/sample is now labelled "Preview" (effects are edited per clip on the timeline) in a right-sized dialog, instead of the full editor.
- Feedback is now submitted through Featurebase.
- Sliders now snap to their centre when dragged near it, and reset on double-click.
- Pitch semitone and cent values can be double-clicked to type an exact amount.
- Clip Editor Beat grid panel reorganised into clear Tempo and Position sections, with the tempo set by typing (Enter to apply) and an Original/Restore affordance; it now sits next to the Warp panel.
- Clip Editor and right-click Warp now label tempo as "Playback", drop the duplicate source BPM, and add a Stretch % option so non-beat material (like vocals) can be fitted even without a detected tempo.
- Clip Editor waveform zoom now uses Ctrl + mouse wheel, matching the main timeline.
- Faster project loading for projects with many clips.
- Faster waveform drawing for clips that share the same audio.
- Faster startup, especially the first launch: the window appears immediately while the audio engine starts in the background.
- New preference (on by default) to set the project tempo from the first clip added to a new project; turn it off to keep the project tempo fixed.
- The stem separation Cancel button now shows a spinning "Cancelling…" state the moment it's clicked, so it's clear the request registered while the engine unwinds.

### Fixed

- Diagnostic and startup logs now default to a discoverable `Silverdaw` folder in your user folder, instead of a hidden location the installed app couldn't write to as shown.
- Trimming the view to the selection did nothing when previewing a library item.
- Clip Editor pitch sliders showing a browser focus outline, and the Warp tempo fields showing number spinners.
- "Unable to connect to audio engine" on some freshly installed machines.
- Sleep-prone USB output devices staying silent on the first play.
- The saved output device not being selected when slow to appear on startup.
- Silence on the first play right after switching output device from the transport bar.
- Clips with a variable-tempo source silently not being tempo-matched; a brief note now explains why.
- Stem separation progress bar freezing mid-stem and a slow Cancel button.
- Dragging the playhead left not scrolling the timeline.
- The cursor not staying a grabbing hand while dragging the playhead.
- The metronome on/off state not being remembered between sessions.

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
