# Application resources

Static files referenced at runtime by the Electron main process. Kept
**outside** the build output so they''re addressable via `app.getAppPath()`
in both `pnpm dev` and a future packaged build, without needing to be
re-emitted by Vite.

## `icons/`

Output of an Electron icon generator (e.g. `electron-icon-builder`,
`electron-icon-maker`). Drop the whole generated set into this folder.

### What we use today (Phase 1–5)

| File          | Purpose                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `icon.ico`    | Windows icon used for the `BrowserWindow` (taskbar, alt-tab, dialog title). Should be a multi-resolution `.ico` containing at least 16, 32, 48, 64, 128 and 256 px variants — Windows picks the right size per surface. |

Wired in `frontend/src/main/index.ts` via
`join(app.getAppPath(), ''resources'', ''icons'', ''icon.ico'')`. The lookup
is defensive: if the file is missing, Electron falls back to its
default icon and `main.log` notes the absence — the app still starts.

### What we use later (Phase 6 installer + cross-platform)

The PNGs sitting alongside `icon.ico` aren''t consumed at runtime but
will be picked up by electron-builder when the Windows installer lands:

| File(s)                                                  | Purpose                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `16x16.png`, `32x32.png`, `48x48.png`, `64x64.png`, `128x128.png`, `256x256.png`, `512x512.png`, `1024x1024.png` | Linux: per-size PNGs for AppImage / `.deb` / `.rpm` (future).            |
| `icon.icns`                                              | macOS: multi-resolution Apple icon container (future).                   |
| `icon.png` (the largest one — typically 1024×1024)       | electron-builder''s master fallback when a platform-specific file is missing. |

You don''t need to do anything beyond dropping the generator''s output
here — relaunch the app (`pnpm dev`) and `icon.ico` is picked up
automatically. No rebuild needed.
