# Changelog

## 1.0.3

### Added

- The Home and End keys now jump the playhead to the start and end of the timeline (scrolling the view there), matching Ctrl+Shift+Left / Right.
- New keyboard shortcuts: Ctrl+F (zoom to fit), Escape (deselect clip/track), K (toggle metronome), Shift+M / Shift+S (mute / solo the selected track), Ctrl+Shift+T (trim project to last clip), plus Ctrl+D and Backspace as aliases for Duplicate and Delete.
- The K key now also toggles the Clip Editor's own metronome while that dialog is open, leaving the main timeline metronome setting unchanged.
- The Clip Editor now supports the Home / End keys (jump the preview playhead to the start / end of the active playback range) and Ctrl+F (fit the working view back into the canvas).
- Clips now automatically align to the timeline bar grid once their tempo is detected, so their bars line up with the project's bars (even when the clip starts with silence) and splitting and marker placement stay on the beat. Clips with no detected beats (such as simple samples) are left where you placed them. This can be turned off in Preferences ▸ Timeline.

### Changed

- Adding a track now automatically selects it, so clip paste, mute / solo shortcuts, and the FX rack target the new track immediately.
- A selected track's highlight border now extends across its header panel with the same thickness and track colour as the timeline row, so the selection outline reads as one continuous box.
- New projects now default to a 5-minute timeline (down from 10). Adding a first clip that runs longer automatically extends the project duration to fit the whole clip.
- The audio processing panel header no longer shows a redundant in-progress count.
- The transport's previous / next buttons now step through timeline markers by default (instead of jumping to the project start / end); you can switch back in Preferences ▸ Timeline.
- The timeline ruler now shows a grab cursor over the playhead, and a single click places the playhead while click-and-drag moves it. Double-clicking the ruler no longer does anything — add or remove a marker at the playhead with the M key.
- Tempo detection now gives up after 120 seconds and shows a notification instead of running indefinitely; the file can be reanalysed manually from the library.

### Fixed

- Editing a clip's position/trim during live playback can no longer momentarily glitch on the rare occasion the audio thread reads the clip's window mid-update: it now falls back to the last consistent window instead of a possibly torn (mismatched offset/length) read.
- Moving a clip along the timeline while playback is stopped and then pressing play no longer briefly bursts the clip's audio from its previous position. The per-track read-ahead buffer is now fully rebuilt after a stopped edit instead of relying on an unreliable seek that could leave stale buffered audio to play on the next start. (Also fixes the same stale-buffer class for stopped trim / fade / reverse / warp edits.)
- The Clip Editor and library preview window now wake a sleep-prone (USB) DAC before playback, using the same audio-thread wake pre-roll as the main timeline, so the first play into a cold amp no longer loses its opening to silence. The wake burst only fires when the endpoint is actually cold, so auditioning clips back-to-back stays clean (no start-of-play hiss on an already-awake device).
- Importing AAC/M4A files no longer hangs on "Analysing tempo…", and the import now always completes even when a file has no detectable tempo.
- Tempo detection no longer intermittently reports "no tempo" on import — concurrent decode jobs for the same file could collide on the shared decoded-audio cache, causing detection to give up. Decoding is now serialised per file, so the grid is detected on the first import instead of only after a manual reanalyse.
- Timeline beat markers now render reliably, including on imported AAC/M4A tracks.
- Project Properties no longer rejects a duration set to the exact length of the last clip — the length field (whole seconds) is now validated against the second-rounded clip end, so the displayed minimum can be saved.
- The transport's next button, when set to jump to the timeline ends, now scrolls the timeline view to the end of the project (matching how the previous button scrolls back to the start).
- The Preferences ▸ Stems tab now recognises already-downloaded separation models on open, instead of showing them as not downloaded when they are already present on disk.

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
- Much faster, more reliable stem separation on hybrid CPUs: inference now uses one thread per physical core (skipping the hyperthread siblings that were slowing it down) instead of oversubscribing every logical processor.
- Cancelling a stem separation now stops almost immediately instead of waiting for the current chunk to finish.
- The stem separation progress bar now advances in proportion to the work actually happening and at the real observed pace, so it no longer looks stuck on drums or stalls partway on slower machines. The drums+bass rhythm pass is labelled "Drums & Bass", and the per-stem cleanup passes now carry their own progress, so bass and the residual "other" stem no longer appear to make no progress while they're being processed.

### Fixed

- GPU acceleration for stem separation is no longer wrongly greyed out on machines with a capable GPU (such as Intel Arc integrated graphics); it now enables whenever a usable adapter is present.
- GPU stem separation now automatically falls back to the CPU (rather than failing) when the GPU runs out of memory — common on integrated GPUs that share system memory.
- The Warp/Clip Editor now offers the Stretch % control for samples (committed, free-form audio), which previously left it greyed out; the standalone Warp dialog and the Clip Editor also now agree on when Stretch is available.
- Diagnostic and startup logs now default to a discoverable `Silverdaw` folder in your user folder, instead of a hidden location the installed app couldn't write to as shown.
- Downloaded stem-separation models now live in a discoverable `Silverdaw\Models` folder in your user folder (existing downloads are moved there automatically); you can still point Silverdaw at models elsewhere.
- New projects now default to a `Silverdaw\Projects` folder in your user folder, keeping projects, models, logs, and diagnostics together in one easy-to-find place.
- Trimming the view to the selection did nothing when previewing a library item.
- Clip Editor pitch sliders showing a browser focus outline, and the Warp tempo fields showing number spinners.
- "Unable to connect to audio engine" on some freshly installed machines.
- Sleep-prone USB output devices staying silent on the first play.
- The saved output device not being selected when slow to appear on startup.
- Silence on the first play right after switching output device from the transport bar.
- Clips with a variable-tempo source silently not being tempo-matched; a brief note now explains why.
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
