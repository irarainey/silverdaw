# LAME MP3 encoder and decoder (bundled binary)

Silverdaw uses the [LAME](https://lame.sourceforge.io/) command-line tool as a
child process for both directions of MP3:

- **Export** — JUCE's `LAMEEncoderAudioFormat` spawns it to encode MP3.
- **Import** — `DecodedCache` spawns it (`lame --decode`) to decode every MP3
  into the decoded-WAV cache, because JUCE's own MP3 reader mis-parses some
  files badly enough that they cannot be played or analysed at all. See
  *Decoding compressed sources* in `docs/developer-guide.md`.

The standard RareWares **LAME 4.0 x64** bundle is used, not its separately
patched q4 variant. It includes **mpg123 1.33.7** as `libmpg123-0.dll`; the
executable requires that exact DLL filename beside it, even for `--version`.
Both runtime files are required at configure time and ship inside the installer.
End users need no extra install steps.

## The runtime files are not committed to the repo

The executable and DLL are excluded by `.gitignore`, so a fresh checkout
must fetch both:

```text
backend/third_party/lame/lame.exe   ← fetched, not tracked in git
backend/third_party/lame/libmpg123-0.dll
```

Fetch it before building:

```powershell
pwsh scripts\Fetch-Lame.ps1
```

The script pins the standard archive to SHA-256
`722f4311e2795d5c852076a579b3183beeb76e9010d9cab1e7f9d2e86d9d0808`,
computed from the RareWares HTTPS download. This is an integrity pin, not a
publisher signature. It checks the hash, requires a sibling decoder DLL and
runs the staged `lame --version` before replacing either installed file.
`Setup-Dev.ps1` invokes it when either file is absent; CI runs it before both
C++ jobs. Old standalone installations and incomplete pairs are refreshed.
A complete LAME 4.0 installation is retained unless `-Force` is supplied.

Custom `-Url` downloads must now be ZIP bundles with an explicit `-Sha256`;
standalone EXE downloads are no longer supported. A bundle with multiple
executables requires `-ZipEntry` to select one; its DLL must be in the same
directory. The version check requires LAME 4.0.

## Build & install flow

1. CMake configure requires both files. `SILVERDAW_LAME_EXE` may point to a
   different bundle, but `libmpg123-0.dll` must be its sibling. A shared
   POST_BUILD helper copies both files beside `SilverdawBackend` and
   `SilverdawBackendTests`, so MP3 regressions exercise the real decoder.
2. `scripts/Build-Release.ps1` produces the Release backend; the same
   POST_BUILD copy fires for the Release artefacts folder.
3. `frontend/electron-builder.yml` whitelists both runtime files in the backend
   `extraResources` filter. Their destination is `resources/backend/`.
4. At runtime `findLameExecutable()` (`backend/src/core/LamePath.h`) resolves it
   as a sibling of `SilverdawBackend.exe` — works identically for dev builds,
   packaged `win-unpacked`, and installed apps. Both the encoder and the
   decoder go through this one locator, so they can never disagree about where
   the binary lives.

## Upstream / how to refresh the bundled binary

- **RareWares LAME bundle** (the standard Windows distribution):
  <https://www.rarewares.org/mp3-lame-bundle.php>
- **Source** (build yourself if you prefer):
  <https://lame.sourceforge.io/>
- Verify with `lame --version` after refreshing this copy.

## Licensing

LAME is **LGPL-2.1-or-later**; libmpg123 is **LGPL-2.1**. Silverdaw invokes
LAME as a separate child process and links neither library; LAME itself
dynamically links libmpg123. The attribution and source links live in
[`THIRD_PARTY_LICENSES.md`](../../../THIRD_PARTY_LICENSES.md).
The unchanged [`COPYING.mpg123`](COPYING.mpg123) from mpg123 1.33.7 includes
the LGPL 2.1 text and upstream notices. Packaging copies it to
`resources/licenses/mpg123-COPYING.txt` alongside the existing attribution.
