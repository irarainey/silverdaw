// J1 — Cold launch.
//
// The foundational journey: a real Electron main process starts, hardens and
// shows a window, defers the backend spawn until first paint, the JUCE engine
// comes up on a dynamic loopback port, AUTHs over the bridge, and the renderer
// reaches its ready state.
//
// The key assertion is indirect and deliberately so. `StartupScreen` only
// renders its project buttons once `transport.handshakeReady` is true, so the
// visible "New Project" button is proof that the whole cross-process chain
// completed — spawn, port resolution, AUTH, and handshake. Asserting the UI the
// user actually sees keeps the test free of production test hooks and tied to
// behaviour rather than implementation.

import { expect, test } from '../fixtures/silverdaw'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

test('cold launch reaches the ready startup screen with the engine connected', async ({
  silverdaw
}) => {
  const { page, electronApp, diagnosticsDir, userDataDir } = silverdaw

  await expect(page).toHaveTitle('Silverdaw')

  // Ready state. Generous timeout: a cold engine start pays for process spawn
  // and audio-device open, neither of which is under our control.
  await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Open Project…' })).toBeVisible()

  // A failed handshake renders the startup screen's focused error mode instead,
  // so the absence of that copy confirms we reached ready rather than degraded.
  await expect(page.getByText('Start a new project or open an existing one.')).toBeVisible()

  // Exactly one window: `setWindowOpenHandler` denies any other.
  expect(electronApp.windows()).toHaveLength(1)

  // Isolation held: every piece of persisted state the app owns — preferences,
  // window state, MRU, autosaves — resolves inside the throwaway profile, so the
  // run cannot read or corrupt the developer's real settings.
  const resolvedUserData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  expect(resolvedUserData).toBe(userDataDir)

  // The always-on diagnostics log exists, which is what makes a failed run
  // explainable across both processes (the fixture attaches it on failure).
  expect(existsSync(join(diagnosticsDir, 'startup.log'))).toBe(true)
})

test('a fresh profile starts with no recent projects', async ({ silverdaw }) => {
  const { page } = silverdaw

  await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible({ timeout: 60_000 })

  // Guards the isolation itself rather than a product behaviour: if the fixture
  // ever leaked the real profile, the developer's MRU list would appear here.
  await expect(page.getByText('Recent Projects')).toBeHidden()
})
