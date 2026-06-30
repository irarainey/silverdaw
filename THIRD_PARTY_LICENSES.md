# Third-Party Licences

Silverdaw is released under the **GNU Affero General Public License v3.0 or
later** (see [`LICENSE`](LICENSE)). It bundles or links the following
third-party components, each retained under its own licence. The notices below
satisfy the attribution requirements of those licences.

## Backend (C++)

### JUCE 8 — © Raw Material Software Limited

- **Licence**: GNU General Public License v3 (free / open-source option).
- **Project**: <https://juce.com>
- **Source**: <https://github.com/juce-framework/JUCE>
- **Notice**: Silverdaw's audio engine is powered by JUCE, used under the
  terms of the GPLv3. Silverdaw uses only headless audio modules
  (`juce_audio_basics`, `juce_audio_devices`, `juce_audio_formats`,
  `juce_core`, `juce_data_structures`, `juce_dsp`, `juce_events`); no JUCE
  GUI components are linked. A copy of the GPLv3 is included with the JUCE
  source obtained via CMake `FetchContent` (`backend/build/_deps/juce-src/`).

### IXWebSocket — © Machine Zone Inc. and contributors

- **Licence**: BSD 3-Clause.
- **Project**: <https://github.com/machinezone/IXWebSocket>
- **Notice**: Source obtained via CMake `FetchContent`; the full BSD-3-Clause
  text ships alongside the source at
  `backend/build/_deps/ixwebsocket-src/LICENSE.txt`.

### Rubber Band Library — © Chris Cannam and contributors

- **Licence**: GNU General Public License v2 or later (GPL-2.0+).
- **Project**: <https://breakfastquay.com/rubberband/>
- **Source**: <https://github.com/breakfastquay/rubberband>
- **Notice**: Used by the backend for non-destructive time-stretching and
  pitch shifting. Source is obtained via CMake `FetchContent`; the upstream
  licence text is included with the fetched source at
  `backend/build/_deps/rubberband-src/COPYING`.

### libsamplerate — © Erik de Castro Lopo and contributors

- **Licence**: BSD 2-Clause.
- **Project**: <https://libsndfile.github.io/libsamplerate/>
- **Source**: <https://github.com/libsndfile/libsamplerate>
- **Notice**: Used for offline analysis resampling and Rubber Band support.
  Source is obtained via CMake `FetchContent`.

### BTrack / KISS FFT

- **Licence**: GPL-3.0 for BTrack; BSD-style licence for KISS FFT.
- **Project**: <https://github.com/adamstark/BTrack>
- **Notice**: A patched vendored copy lives under `backend/third_party/btrack/`
  and powers BPM / beat detection. See
  [`backend/third_party/btrack/PATCHES.md`](backend/third_party/btrack/PATCHES.md)
  for the local MSVC-compatibility changes.

### RNNoise — © 2017 Mozilla; © 2018 Gregor Richards

- **Licence**: BSD 2-Clause.
- **Project**: <https://jmvalin.ca/demo/rnnoise/>
- **Source**: <https://github.com/xiph/rnnoise>
- **Notice**: Used by the backend for optional post-separation **vocal-stem
  denoise** (the RNN noise-suppression network; see `backend/src/dsp/`). The
  pinned `v0.1.1` release is obtained via CMake `FetchContent`, and its bundled
  trained model (`src/rnn_data.c`) ships under the same BSD-2-Clause licence. To
  build under MSVC, five C99 variable-length-array declarations in `pitch.c` /
  `celt_lpc.c` are rewritten to `_alloca` at configure time (a mechanical change,
  no behaviour difference); all other sources are used verbatim. The upstream
  licence text is included with the fetched source at
  `backend/build/_deps/rnnoise-src/COPYING`.

### LAME MP3 encoder — © The LAME Project

- **Licence**: GNU Lesser General Public License v2.1 or later (LGPL-2.1+).
- **Project**: <https://lame.sourceforge.io/>
- **Source**: <https://sourceforge.net/projects/lame/files/lame/>
- **Notice**: When MP3 export is enabled, Silverdaw bundles an unmodified
  Windows `lame.exe` build (typically sourced from the
  [RareWares LAME bundle](https://www.rarewares.org/mp3-lame-bundle.php))
  next to `SilverdawBackend.exe` in `resources/backend/`. Silverdaw invokes
  the encoder as a separate child process (via JUCE's
  `LAMEEncoderAudioFormat`); there is no static or dynamic linking against
  the LAME library, so the LGPL boundary is the process boundary.
  Per the LGPL, the unmodified upstream source is available from the
  project links above. If MP3 export was not enabled in a particular
  build, `lame.exe` is not included.

## Frontend (Electron + Vue)

### Electron, Chromium, Node.js

- **Licences**: MIT (Electron, Node.js), BSD-3-Clause (Chromium / V8), and
  many transitive component licences enumerated in Electron's bundled
  `LICENSES.chromium.html`.
- **Project**: <https://www.electronjs.org>

### Vue 3, Pinia, Vue Router

- **Licence**: MIT — © Yuxi (Evan) You and Vue contributors.
- **Project**: <https://vuejs.org>

### PixiJS

- **Licence**: MIT — © Mat Groves / Goodboy Digital and contributors.
- **Project**: <https://pixijs.com>

### Tailwind CSS, Vite, electron-vite, vue-tsc, ESLint, TypeScript

- **Licence**: MIT or Apache-2.0 (per package).
- The full set of npm dependency licences is enumerated by
  `pnpm licenses list` and is included in production installer builds.

### music-metadata

- **Licence**: MIT — © Borewit and contributors.
- **Project**: <https://github.com/Borewit/music-metadata>

## Downloaded models & runtimes (fetched on first use, not bundled)

These are downloaded on demand into the user's app-data folder and integrity-
checked against pinned SHA-256 hashes; they are not shipped in the installer.

### ONNX Runtime (+ DirectML) — © Microsoft

- **Licence**: MIT.
- **Use**: runs the stem-separation models on CPU or any DirectX 12 GPU.
- **Project**: <https://github.com/microsoft/onnxruntime>

### htdemucs fine-tuned — 4-stem separation model (backup)

- **Licence**: MIT — © Meta Platforms, Inc. (Demucs). ONNX export ©
  StemSplitio, also MIT.
- **Use**: the backup 4-stem (vocals/drums/bass/other) separation model — used
  per stem when that stem's RoFormer quality pack is not installed, or for every
  stem when the user enables "Always use the backup model". Also the zero-config
  path fetched on first use when no quality packs are present.
- **Source**: <https://huggingface.co/StemSplitio/htdemucs-ft-onnx>

### Mel-Band RoFormer "Vocal Quality Pack" (primary vocal model)

- **Licence**: MIT — vocal weights © Kimberley Jensen / SYH99999
  (`SYH99999/MelBandRoformerBigSYHFTV1Fast`); ONNX export © musetric, also MIT.
  Architecture from *Mel-Band RoFormer* (Wang, Lu, Won; arXiv:2310.01809) /
  `lucidrains/BS-RoFormer` (MIT).
- **Use**: higher-quality vocal model, used automatically for vocals once
  installed (in place of the htdemucs backup) unless the user forces the backup.
- **Source**: <https://huggingface.co/musetric/vocal-separation-roformer-onnx>
- **Note**: the upstream training-data provenance is undocumented; the weights
  are distributed by their author under MIT (the same posture as the htdemucs
  weights above).

### BS-RoFormer "Rhythm Quality Pack" (primary drums/bass model)

- **Licence**: MIT — 4-stem weights © ZFTurbo
  (`ZFTurbo/Music-Source-Separation-Training`, the
  `model_bs_roformer_ep_17_sdr_9.6568` checkpoint trained on MUSDB18-HQ).
  Architecture from `lucidrains/BS-RoFormer` (MIT). Silverdaw exports the
  checkpoint to a host-STFT ONNX (STFT/iSTFT stripped out of the graph) using an
  MIT export pipeline derived from `elicwhite/bs-roformer-web`.
- **Use**: higher-quality drums + bass model, used automatically for drums and
  bass once installed (in place of the htdemucs backup) unless the user forces
  the backup. One model run extracts both drums and bass.
- **Source**: <https://github.com/ZFTurbo/Music-Source-Separation-Training>
  (checkpoint + config, v1.0.12).

## Branding

The Silverdaw name, logo, and icons are © the Silverdaw contributors. They are
**not** covered by the AGPL grant and may not be used to promote, endorse, or
identify derived works without permission.

## Updating this file

When adding or upgrading a runtime dependency, append its licence + attribution
here so the bundled installer remains compliant.
