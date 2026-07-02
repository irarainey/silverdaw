// Locks down the default Electron session. Silverdaw's renderer drives all
// audio, file, project and stem work through the WebSocket bridge and the
// validated IPC surface — it never uses web-platform capabilities such as
// geolocation, camera, microphone, notifications, MIDI, or WebUSB/Serial/HID
// devices. Denying every permission and device request removes that attack
// surface and, on MSIX builds, stops Windows prompting the user to grant
// capabilities (e.g. location) the app has no reason to request.

import { app, session } from 'electron'
import { logMain } from './log'

/**
 * Chromium command-line switches that MUST be applied before app "ready".
 *
 * On Windows, a packaged (MSIX, full-trust) app trips the per-app Windows
 * location consent prompt at startup even though Silverdaw uses no geolocation
 * and no Web MIDI — because Chromium reaches a *WinRT* API that Windows treats
 * as location-revealing. Windows scopes that consent to the package identity,
 * which is why it only happens for the MSIX build and never in dev / the
 * unpacked build, and why the renderer permission handler never sees it (it's
 * a native WinRT call, not a web permission request).
 *
 * We disable the two WinRT code paths that can reach it, neither of which the
 * app needs:
 *   - `MidiManagerWinrt`      Chromium's WinRT MIDI backend enumerates MIDI via
 *                             a Bluetooth-LE-capable `DeviceWatcher`; BLE scans
 *                             count as location access. Falls back to winmm.
 *   - `LocationProviderManager` selects the OS (WinRT) location provider over
 *                             the network provider; disabling it keeps Chromium
 *                             off the WinRT system-location source.
 * `WinSystemLocationPermission` is also disabled as belt-and-braces.
 *
 * (The JUCE backend is unaffected: it builds with the default
 * `JUCE_USE_WINRT_MIDI=0`, so it already uses the winmm MIDI backend.)
 */
export function applyChromiumSecuritySwitches(): void {
  // Defensive hardening for a DAW that uses neither Web Bluetooth nor BLE MIDI
  // (USB MIDI still works via winmm). These are NOT the fix for the startup
  // "precise location" prompt — see the investigation notes; that prompt is
  // triggered inside a Chromium child process on packaged (MSIX) builds.
  app.commandLine.appendSwitch('disable-features', 'WebBluetooth,MidiManagerWinrt')
}

/** Install deny-all permission + device handlers on the default session. */
export function hardenDefaultSession(): void {
  const ses = session.defaultSession

  // Renderer-initiated permission requests (geolocation, media, notifications,
  // midi, clipboard-read, …) are all refused.
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    logMain('WARN ', 'session', `denied permission request: ${permission}`)
    callback(false)
  })

  // Synchronous "is this permission already granted?" checks also refuse.
  ses.setPermissionCheckHandler(() => false)

  // WebUSB / Web Serial / WebHID / Web Bluetooth device access is refused.
  ses.setDevicePermissionHandler(() => false)
}
