<div align="center">
  <img src="images/logo-small.png" alt="Silverdaw logo" width="160">

  # Silverdaw

  An open-source Digital Audio Workstation (DAW) for remixing, mashups, and sample-driven music making.
</div>

## What is Silverdaw?

Silverdaw is a Windows desktop application for building tracks out of existing
audio. Import your songs, loops, vocals, and samples, drag them onto a timeline,
and arrange, trim, re-pitch, and tempo-match them into a finished mix. It is
designed for bedroom DJs, producers, and mixers — anyone who wants to create
mixes and mashups easily by combining and reshaping existing audio. It is geared
towards DJs and producers as a studio creation tool, not a live-performance
instrument. Supported MIDI DJ decks can also record editable vinyl-style
scratches directly from audio into a mix, combining deck control with a
non-destructive studio workflow.

## Installation

Silverdaw runs on Windows 10 (1809+) or Windows 11 (64-bit). There are two
ways to install it — see the **[installation guide](INSTALL.md)** for full
steps and the pros and cons of each:

- **[Microsoft Store](https://apps.microsoft.com/detail/9N8T25L0462F)**
  *(recommended)* — one-click install, no setup, automatic updates.
- **Portable download** — a zip you unzip and run; no installation.

## Goals and focus

Silverdaw is built around a single idea: **arranging audio should be simple.**

- **Approachable by design.** The app stays deliberately small and focused.
  Common tasks are a drag, a double-click, or a single menu item away — no deep
  menus or studio jargon to learn first.
- **Remix and mashup first.** Everything is geared towards layering and
  blending existing audio: automatic tempo and key detection, tempo matching,
  pitch shifting, and a per-project library of clips and samples.
- **Non-destructive.** Tempo, pitch, and trim changes are applied as settings on
  a clip, so your original files are never altered and edits can always be
  undone or revised.
- **It just plays.** Drop a clip in and it is ready to play. Analysis and
  waveforms happen in the background and never block what you are doing.

## Key features

- **Project library.** Drop audio files onto the Library to import them, or use
  the Import button and **File ▸ Import to Library…**. You can also drop a file
  directly onto a timeline track to import and place it, or onto empty timeline
  space to create a track for it. Dropping several files creates one new track
  per file. Filter the Library by track name, artist, or BPM with the field
  beside Import; use its **X** or press `Escape` while it is focused to clear it.
  Library items are grouped and easy to reuse. Tiles show a track's
  cover art (or a per-kind icon when there's none); right-click a tile to
  **Update Image…** with your own picture, or **Remove** / **Restore** the image —
  all per-tile and non-destructive.
- **Timeline arranging.** Move, split, duplicate, cut, copy, paste, trim, colour,
  and delete clips across multiple tracks. Drag clips or nudge them with the
  keyboard; clips snap to the beat grid by default, with a modifier for fine,
  free placement. **Select several clips at once** — Shift-click a range on one
  track or Ctrl-click clips across tracks — then move the whole group together,
  nudge it with the arrow keys, or lock, colour, duplicate, delete, and
  cut/copy/paste them in one step. Bar numbering starts at 1 by default,
  or you can start it at 0 or lower to leave lead-in bars before bar one for clips
  with a silent intro.
- **Crossfade transitions.** Extend a clip edge over an adjacent clip to create
  a crossfade. Use the clip menu's **Crossfade** group to choose a Smooth or
  Fade out/in recipe, or remove it.
- **Automatic analysis.** Imported audio is analysed for key, tempo (BPM), and
  beat positions, so clips can line up musically. Once a clip's tempo is known it
  automatically snaps to the timeline's bar grid so its bars line up with the
  project — handy when a clip has a silent intro — and you can turn this off in
  Preferences. When detection is uncertain you can set a BPM by hand and slide the
  beat grid over the waveform to line it up.
- **Metronome.** Toggle an audible click that follows the project tempo from the
  timing display, so you can check by ear whether a loop or beat sits in time
  with the BPM. It is off by default and its state is saved with the project.
- **Stem separation.** Split a track into vocals, drums, bass, and other parts
  and drop each onto its own track to remix and recombine — non-destructive, with
  optional GPU acceleration. Each stem keeps the original's tempo, key, and
  artwork. High-quality **RoFormer models** (downloaded once, ~1 GB) do the
  separation by default, with a backup model downloaded automatically only if
  it's ever needed. A
  **Fast / Balanced / Best** speed control and optional one-click cleanup let you
  trade speed for polish, and an optional per-run **reverb & echo removal** cleans
  room reverb and slap-back off the vocal as it separates.
- **Split stereo channels.** Use **Transform ▸ Split Stereo Channels…** on a
  stereo clip to split its **Left** and/or **Right** channel onto its own new
  track — each channel becomes a stereo clip carrying only that side (copied to
  both). Non-destructive, and each split keeps the original's tempo, key, and
  artwork, just like a stem.
- **Tempo and pitch.** Clips can automatically match the project tempo and be
  pitch-shifted independently, all without changing the source file.
- **Saved clips and samples.** Save reusable clips to the library and bake any
  clip down to a fresh sample when you want to commit its current sound.
- **Loop slicing.** Chop a clip into slices — on a bar or beat grid (from a whole
  bar down to 1/32) or with hand-placed markers — then lay the slices back on the
  timeline as separate clips, or save each one as its own sample to rearrange and
  rebuild. Use **Transform ▸ Chop to Grid** for a quick grid chop, or open the
  Clip Editor's **Slice** mode for hands-on control. Non-destructive — the
  source file is untouched.
- **Beat Repeat.** Use **Effects ▸ Beat Repeat** on a clip or empty track lane
  to add a tempo-aligned repeat region at the playhead. Choose a duration and a
  1/4, 1/8, or 1/16 division to capture and repeat part of the track without
  changing its source audio.
- **Portable projects.** Saving a project nests it in its own folder and keeps
  its generated stems and samples beside the project file, so the whole folder
  can be moved or synced between machines (for example via cloud storage) and
  still open — as long as the original source files sit at the same location.
- **Tidy up on remove.** Optionally have Silverdaw delete a stem's or sample's
  generated file — and the now-empty folder it leaves behind — from disk when you
  remove it from the library. Off by default (removal just unlinks it from the
  project); your original imported files are never touched. This can't be undone.
  Turn it on in **Preferences ▸ Project**.
- **Track, project, and master controls.** Per-track volume faders with a
  bipolar equal-power **Pan** control in each track header, plus mute, solo,
  and a collapsible bottom panel with **Track FX**, **Project FX**, and
  **Library** tabs.
  - **Track FX**
    - **Tone:** Bass, Mid, and Treble controls.
    - **Filter:** a single DJ-style sweep from low-pass through off to high-pass.
    - **Compressor:** single-knob gentle dynamics control.
    - **Punch:** transient enhancement.
    - **Saturation:** soft clipping.
    - **Bit Crusher:** lo-fi digital reduction.
    - **Reverb and Delay sends:** feed the shared Project FX effects.
  - **Project FX**
    - **Reverb and Delay:** song-wide effects fed by each track's sends. Delay
      Time uses direct 1/4, 1/8, 1/8T, and 1/16 beat-division buttons.
    - **Glue Compressor:** one-control compression after the shared effect
      returns and before master gain.
    - **Safety Limiter:** fixed-ceiling protection for the final output.
  - **FX layout and guidance:** each Track FX and Project FX header offers a
    hover explanation. Track FX keeps five responsive columns: Tone; Filter
    above Reverb & Delay; Compressor above Punch; Saturation; and Bit Crusher.
  - Drag to resize and reorder tracks, and use the master output's live metering.
- **Track effect automation.** Open a collapsible lane under any track to draw
  breakpoint curves that automate a parameter over the timeline — Filter, Pan,
  Tone Bass / Mid / Treble, Reverb / Delay sends, Compressor, Punch,
  Saturation, Bit Crusher, or **Gain** (a post-FX track level). Add, drag,
  right-click or
  Alt-click to delete, and arrow-key nudge points; raise/lower or copy/paste a
  whole curve; values play live and render identically in the mixdown. Each
  Track FX control has an **A** button to automate it: the slider sets the
  resting value, and a drawn curve overlays it over time — and while a curve is
  active its slider follows the automation, so you can watch each control move
  as the track plays.
- **Per-clip volume shaping.** Draw a volume envelope right on a clip's waveform
  in the Clip Editor to swell, duck, fade in, or fade out, or chop a selected
  range to silence or full volume with hard edges — all non-destructive
  and applied to both playback and export.
- **Reverse a clip.** Play any clip back-to-front from **Effects ▸ Reverse** or
  a toggle in the Clip Editor (with live preview) — non-destructive, so the
  source file is never altered.
- **DJ turntable effects.** Add one of these at the end of a clip from
  **Effects ▸ Brake / Backspin** or the Clip Editor toolbar:
  - **Brake:** a vinyl record-stop that slows the clip to a halt.
  - **Backspin:** a reverse rewind, like pulling the record back.

  Both have live preview, are non-destructive, apply to every linked copy, work
  on warped clips, and carry through to export. Reverse, Brake, and Backspin
  are mutually exclusive — set one and the others stay visible but disabled
  until you turn it off. Tune how long Brake and Backspin take and how they
  feel in **Preferences ▸ Effects**.
- **Vinyl-style scratch authoring.** Open a clip or library item in the Scratch
  Editor and use a supported MIDI DJ deck to record platter and crossfader
  moves. Deck control is the primary workflow; the on-screen deck offers an
  experimental trackpad and keyboard fallback for creating a simple scratch
  that you can edit into a more complex pattern. Replay the result, apply it
  non-destructively to a clip, or save it as a new library sample for use in
  your mix. **Scratch realism** adds adjustable held-platter softening and
  groove texture, with Off, Medium, and High levels in **Preferences ▸ Effects**.
- **Single or stereo waveforms.** Choose whether clips show one combined
  waveform or stacked left / right channels (the default), in Preferences —
  applied across the timeline and the Clip Editor.
- **Per-project sample rate.** Pin a project to 44.1 or 48 kHz; imports are
  checked against the project rate and offer a clear path when they differ.
- **Mixdown export.** Render the whole project to a single stereo file in WAV,
  FLAC, AIFF, or MP3, with optional loudness normalisation and a choice of which
  bar to start the render from.
- **Autosave and crash recovery.** Work is snapshotted in the background and
  offered back to you after an unexpected exit.
- **Stay in flow.** Drop files onto the Library, or import them from
  **File ▸ Import to Library…** (`Ctrl`+`I`), toggle the bottom panel with
  `Ctrl`+`J`, jump to zoom presets with `Ctrl`+`1`–`8`, and navigate with Home /
  End. Choose any audio output device and hot-swap it without leaving the
  timeline, relink moved source files in one step, and undo or redo any edit.
  **Help ▸ Keyboard Shortcuts** opens the full shortcut reference.
- **Supported MIDI deck control.** Use a recognised deck controller for
  transport, timeline and marker navigation, clip browsing, selected-track
  mixer controls, platter holding and scratching, plus supported lights and
  meters. Other MIDI devices remain visible but cannot be enabled. See the
  **[supported controller list and control reference](docs/midi-controllers.md)**.

## Supported audio

- **Import:** WAV, AIFF, FLAC, MP3, AAC / M4A / MP4, and Windows Media audio.
- **Export:** WAV, FLAC, AIFF, and MP3.
- **Processing & quality:** Audio is processed internally in **32-bit floating
  point** from end to end, so your imported files — whatever their original bit
  depth — are never quantised while you edit or play, and the source files are
  never altered. Conversion to a final bit depth happens only on export, which
  **defaults to 16-bit** and also offers 24-bit and 32-bit float depending on
  the chosen format (WAV: 16 / 24 / 32-float; FLAC and AIFF: 16 / 24).

## Stem separation models

Silverdaw's stem separation is powered by open, machine-learning models. To keep
the download small, **no models ship inside the app** — they are fetched only
when you first use stem separation, downloaded once, and then stored on your
computer and reused for every future separation.

For full transparency about what Silverdaw downloads and from where: the models
are hosted on Silverdaw's own Hugging Face account and are downloaded directly
from there:

- **[huggingface.co/silverdaw](https://huggingface.co/silverdaw)**

By default Silverdaw uses the higher-quality **RoFormer** models (vocals and
drums/bass, ~1 GB total), with a smaller **backup** model downloaded
automatically only if it's ever needed as a fallback. Nothing is uploaded — separation runs entirely on your own machine, and
the download is a one-time, on-demand fetch of the model files only. If you would
rather not download anything, you can point Silverdaw at a copy of the models you
already have from **Preferences ▸ Stems**.

## Documentation

- **[Installation guide](INSTALL.md)** — how to install Silverdaw (Microsoft
  Store or portable zip) with the pros and cons of each.
- **[Developer Guide](docs/developer-guide.md)** — architecture, internals,
  build and run instructions, and contributor workflows.
- **[MIDI deck controllers](docs/midi-controllers.md)** — supported devices,
  setup, mapped controls, feedback, limitations, and troubleshooting.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](LICENSE) for the full text. Third-party components
retain their own licences; see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the required
attribution notices.
