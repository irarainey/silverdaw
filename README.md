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
instrument.

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

- **Project library.** Import audio into a per-project library and drag it
  straight onto the timeline. Files are grouped and easy to reuse.
- **Timeline arranging.** Move, split, duplicate, cut, copy, paste, trim, colour,
  and delete clips across multiple tracks. Drag clips or nudge them with the
  keyboard; clips snap to the beat grid by default, with a modifier for fine,
  free placement. Bar numbering starts at 1 by default,
  or you can start it at 0 or lower to leave lead-in bars before bar one for clips
  with a silent intro.
- **Automatic analysis.** Imported audio is analysed for key, tempo (BPM), and
  beat positions, so clips can line up musically. When detection is uncertain you
  can set a BPM by hand and slide the beat grid over the waveform to line it up.
- **Metronome.** Toggle an audible click that follows the project tempo from the
  timing display, so you can check by ear whether a loop or beat sits in time
  with the BPM. It is off by default and its state is saved with the project.
- **Stem separation.** Split a track into vocals, drums, bass, and other parts
  and drop each onto its own track to remix and recombine — non-destructive, with
  optional GPU acceleration. Each stem keeps the original's tempo, key, and
  artwork. High-quality **RoFormer models** (downloaded once, ~1 GB) do the
  separation by default, with a built-in backup model that needs no setup. A
  **Fast / Balanced / Best** speed control and optional one-click cleanup let you
  trade speed for polish.
- **Tempo and pitch.** Clips can automatically match the project tempo and be
  pitch-shifted independently, all without changing the source file.
- **Saved clips and samples.** Save reusable clips to the library and bake any
  clip down to a fresh sample when you want to commit its current sound.
- **Loop slicing.** Chop a clip into slices — on a bar or beat grid (from a whole
  bar down to 1/32) or with hand-placed markers — then lay the slices back on the
  timeline as separate clips, or save each one as its own sample to rearrange and
  rebuild. Right-click a clip for a quick **Chop to Grid**, or open the Clip
  Editor's **Slice** mode for hands-on control. Non-destructive — the source file
  is untouched.
- **Portable projects.** Saving a project nests it in its own folder and keeps
  its generated stems and samples beside the project file, so the whole folder
  can be moved or synced between machines (for example via cloud storage) and
  still open — as long as the original source files sit at the same location.
- **Tidy up on remove.** Optionally have Silverdaw delete a stem's or sample's
  generated file — and the now-empty folder it leaves behind — from disk when you
  remove it from the library. Off by default (removal just unlinks it from the
  project); your original imported files are never touched. Turn it on in
  **Preferences ▸ Project**.
- **Track, project, and master controls.** Per-track volume faders with a
  bipolar equal-power **Pan** control in each track header, plus mute, solo,
  and a collapsible bottom panel with **Track FX**, **Project FX**, and
  **Library** tabs. Track FX gives each track a Tone EQ (Bass / Mid / Treble),
  a bipolar **Filter** (a single DJ-style sweep from low-pass through off to
  high-pass), a single-knob **Compressor** (gentle dynamics control), plus Reverb and
  Delay sends; Project FX hosts the song-wide Reverb and Delay those sends
  feed. Plus drag-to-resize and reorder tracks, and a master output with live
  metering.
- **Track effect automation.** Open a collapsible lane under any track to draw
  breakpoint curves that automate a parameter over the timeline — Filter, Pan,
  Tone Bass / Mid / Treble, Reverb / Delay sends, Compressor, or **Gain** (a
  post-FX track level). Add, drag, right-click or Alt-click to delete, and
  arrow-key nudge points; raise/lower or copy/paste a whole curve; values play
  live and render identically in the mixdown. Each Track FX control has an
  **A** button to automate it: the slider sets the resting value, and a drawn
  curve overlays it over time — and while a curve is active its slider follows
  the automation, so you can watch each control move as the track plays.
- **Per-clip volume shaping.** Draw a volume envelope right on a clip's waveform
  in the Clip Editor to swell, duck, fade in, or fade out, or chop a selected
  range to silence or full volume with hard edges — all non-destructive
  and applied to both playback and export.
- **Reverse a clip.** Play any clip back-to-front from the timeline right-click
  menu or a toggle in the Clip Editor (with live preview) — non-destructive, so
  the source file is never altered.
- **DJ turntable effects.** Add a **Brake** (a vinyl record-stop that slows the
  clip to a halt) or a **Backspin** (a reverse rewind, like pulling the record
  back) at the end of a clip from the right-click menu or the Clip Editor
  toolbar (with live preview) — non-destructive, one or the other per clip, applied
  to every linked copy, working on warped clips too and carried through to
  export. Reverse, Brake, and Backspin are mutually exclusive — set one and the
  others stay visible but disabled until you turn it off. Tune how long they take
  and how they feel in **Preferences ▸ Effects**.
- **Single or stereo waveforms.** Choose whether clips show one combined
  waveform or stacked left / right channels, in Preferences — applied across the
  timeline and the Clip Editor.
- **Per-project sample rate.** Pin a project to 44.1 or 48 kHz; imports are
  checked against the project rate and offer a clear path when they differ.
- **Mixdown export.** Render the whole project to a single stereo file in WAV,
  FLAC, AIFF, or MP3, with optional loudness normalisation and a choice of which
  bar to start the render from.
- **Autosave and crash recovery.** Work is snapshotted in the background and
  offered back to you after an unexpected exit.
- **Stay in flow.** Choose any audio output device and hot-swap it without
  leaving the timeline, relink moved source files in one step, and undo or redo
  any edit.

## Supported audio

- **Import:** WAV, AIFF, FLAC, MP3, AAC / M4A / MP4, and Windows Media audio.
- **Export:** WAV, FLAC, AIFF, and MP3.
- **Processing & quality:** Audio is processed internally in **32-bit floating
  point** from end to end, so your imported files — whatever their original bit
  depth — are never quantised while you edit or play, and the source files are
  never altered. Conversion to a final bit depth happens only on export, which
  **defaults to 16-bit** and also offers 24-bit and 32-bit float depending on
  the chosen format (WAV: 16 / 24 / 32-float; FLAC and AIFF: 16 / 24).

## On the roadmap

Silverdaw is under active development. The items below describe where the
application is heading — they are **planned directions, not yet available**, and
are not part of the current feature set. See the
[Development Plan](docs/development-plan.md) for detail and status.

- **Richer transitions and stereo width.** The core mixing toolkit already
  ships — Tone EQ and bipolar Filter, equal-power Pan, a per-track Compressor,
  project-wide Reverb and Delay sends, track effect automation, per-clip volume
  shaping, and clip-to-clip crossfade transitions (drag one clip's edge over its
  neighbour). Still to come: more transition styles such as bass swaps, filter
  fades, and delay tails; a one-click move to duck the music under a vocal;
  stereo width controls; and the occasional extra effect to round out the set.
- **More editing power.** Extra clip actions, phrase-aware snapping, and
  finer manual correction of the detected beat grid.
- **MIDI devices and scratch authoring.** Support for external MIDI controllers
  and DJ decks, including a studio tool for crafting reusable "scratch" clips to
  drop into a mix (not a live-performance mode).
- **Sequence tracks.** Step-sequencing of samples and external or virtual
  instruments — such as a drum machine — alongside ordinary audio tracks.
- **Plugin support.** Hosting third-party audio plugins on a track.
- **Recording.** A deliberately simple way to record live input — vocals, an
  instrument, or any audio device — straight onto a clip, without turning into a
  full recording studio.
- **Sharing and distribution.** Easier export to online platforms, a Windows
  Store build, and an online user guide.

## Documentation

- **[Developer Guide](docs/developer-guide.md)** — architecture, internals,
  build and run instructions, and contributor workflows.
- **[Development Plan](docs/development-plan.md)** — the longer-term feature and
  design roadmap.

## License

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** — see [`LICENSE`](LICENSE) for the full text. Third-party components
retain their own licences; see
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for the required
attribution notices.
