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

## Branding

The Silverdaw name, logo, and icons are © the Silverdaw contributors. They are
**not** covered by the AGPL grant and may not be used to promote, endorse, or
identify derived works without permission.

## Updating this file

When adding or upgrading a runtime dependency, append its licence + attribution
here so the bundled installer remains compliant.
