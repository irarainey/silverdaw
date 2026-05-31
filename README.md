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
- **Timeline arranging.** Move, split, duplicate, cut, copy, trim, colour, and
  delete clips across multiple tracks. Clips snap to the beat grid by default,
  with a modifier for fine, free placement.
- **Automatic analysis.** Imported audio is analysed for key, tempo (BPM), and
  beat positions, so clips can line up musically.
- **Tempo and pitch.** Clips can automatically match the project tempo and be
  pitch-shifted independently, all without changing the source file.
- **Saved clips and samples.** Save reusable clips to the library and bake any
  clip down to a fresh sample when you want to commit its current sound.
- **Track and master controls.** Per-track volume faders, mute and solo,
  drag-to-resize and reorder tracks, and a master output with live metering.
- **Per-project sample rate.** Pin a project to 44.1 or 48 kHz; imports are
  checked against the project rate and offer a clear path when they differ.
- **Mixdown export.** Render the whole project to a single stereo file in WAV,
  FLAC, AIFF, or MP3, with optional loudness normalisation.
- **Autosave and crash recovery.** Work is snapshotted in the background and
  offered back to you after an unexpected exit.
- **Stay in flow.** Choose any audio output device and hot-swap it without
  leaving the timeline, relink moved source files in one step, and undo or redo
  any edit.

## Supported audio

- **Import:** WAV, AIFF, FLAC, MP3, AAC / M4A / MP4, and Windows Media audio.
- **Export:** WAV, FLAC, AIFF, and MP3.

## On the roadmap

Silverdaw is under active development. The items below describe where the
application is heading — they are **planned directions, not yet available**, and
are not part of the current feature set. See the
[Development Plan](docs/development-plan.md) for detail and status.

- **Recording.** A deliberately simple way to record live input — vocals, an
  instrument, or any audio device — straight onto a clip, without turning into a
  full recording studio.
- **MIDI devices and scratch authoring.** Support for external MIDI controllers
  and DJ decks, including a studio tool for crafting reusable "scratch" clips to
  drop into a mix (not a live-performance mode).
- **Sequence tracks.** Step-sequencing of samples and external or virtual
  instruments — such as a drum machine — alongside ordinary audio tracks.
- **Stem separation.** Split a track into parts, such as vocals and
  instrumental, to remix and recombine.
- **Built-in effects and transitions.** A small, well-explained set of mixing
  effects, clip-to-clip transitions, and stereo channel controls for polishing a
  mix.
- **More editing power.** Extra clip actions such as reverse, and manual
  correction of the detected beat grid.
- **Smarter matching.** Harmonic and key-compatibility hints with one-click
  tempo and key matching between clips.
- **Richer library.** Tags, search, list views, and connections to online
  sample and clip banks.
- **Plugin support.** Hosting third-party audio plugins on a track.
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
