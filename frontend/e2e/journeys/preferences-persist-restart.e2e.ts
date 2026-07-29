// J15 — Preferences set in the UI survive a restart.
//
// Distinct from the legacy-upgrade journey next door: that one proves an older
// `preferences.json` is read and rewritten in the current shape, but it never
// restarts, so it cannot show that a setting the *user* chose is still in force
// next time they open the app. That is the failure this covers, and it is a
// three-way contract — the renderer has to send the change, the main process has
// to write it, and the next launch has to read it back and re-apply it.
//
// Nothing here can be proved in Vitest: the value has to cross the renderer/main
// boundary, land in a real file, and be picked up by a genuinely new process.
//
// The chosen settings deliberately span three tabs and three control types
// (radio, checkbox, number) and land in different sections of the document, so a
// regression that persists only one shape of value still fails.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { closeSilverdaw, expect, test, type SilverdawApp } from '../fixtures/silverdaw'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'

const CHOSEN_INTERVAL = 45

interface PreferencesDocument {
  autosave?: { intervalSeconds?: number }
  toasts?: { enabled?: boolean }
  ui?: { waveformDisplayMode?: string; followPlayback?: boolean }
}

const readPreferences = (userDataDir: string): PreferencesDocument =>
  JSON.parse(readFileSync(join(userDataDir, 'preferences.json'), 'utf8')) as PreferencesDocument

/** Opens Preferences and returns the dialog. */
const openPreferences = async (app: SilverdawApp) => {
  await invokeMenuItem(app.page, 'Edit', 'Preferences')
  const dialog = app.page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

test('preferences chosen in the dialog are still in force after a restart', async ({
  launchApp
}) => {
  // ── First session: change settings across three tabs and save ─────────────
  const first = await launchApp()
  await waitForStartupReady(first.page)
  await startNewProject(first.page)

  const dialog = await openPreferences(first)

  await dialog.getByRole('tab', { name: 'General' }).click()
  // Both defaults are the opposite of what is chosen below, so "still set after
  // the restart" cannot be a default that was never actually changed.
  const monoWaveforms = dialog.getByRole('radio', { name: 'Single waveform' })
  const toasts = dialog.getByRole('checkbox', { name: 'Show toast notifications' })
  await expect(monoWaveforms).not.toBeChecked()
  await expect(toasts).toBeChecked()
  await monoWaveforms.check()
  await toasts.uncheck()

  await dialog.getByRole('tab', { name: 'Timeline' }).click()
  const followPlayback = dialog.getByRole('checkbox', { name: 'Follow playback' })
  await expect(followPlayback).toBeChecked()
  await followPlayback.uncheck()

  await dialog.getByRole('tab', { name: 'Project' }).click()
  const interval = dialog.locator('#autosave-interval')
  await expect(interval).not.toHaveValue(String(CHOSEN_INTERVAL))
  await interval.fill(String(CHOSEN_INTERVAL))

  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toBeHidden()

  // The main process owns the write, so wait for the file rather than assuming
  // the dialog closing means it landed.
  await expect
    .poll(() => {
      // `expect.poll` propagates a throw instead of retrying, so a read that
      // lands mid-write has to degrade to "not there yet".
      try {
        return readPreferences(first.userDataDir).autosave?.intervalSeconds
      } catch {
        return undefined
      }
    })
    .toBe(CHOSEN_INTERVAL)

  const saved = readPreferences(first.userDataDir)
  expect(saved.ui?.waveformDisplayMode).toBe('summary')
  expect(saved.toasts?.enabled).toBe(false)
  expect(saved.ui?.followPlayback).toBe(false)

  const profile = first.userDataDir
  await closeSilverdaw(first, { keepProfile: true })

  // ── Second session: the same profile, a brand-new process ─────────────────
  const second = await launchApp({ userDataDir: profile })
  await waitForStartupReady(second.page)
  await startNewProject(second.page)

  const reopened = await openPreferences(second)

  await reopened.getByRole('tab', { name: 'General' }).click()
  await expect(reopened.getByRole('radio', { name: 'Single waveform' })).toBeChecked()
  await expect(
    reopened.getByRole('checkbox', { name: 'Show toast notifications' })
  ).not.toBeChecked()

  await reopened.getByRole('tab', { name: 'Timeline' }).click()
  await expect(reopened.getByRole('checkbox', { name: 'Follow playback' })).not.toBeChecked()

  await reopened.getByRole('tab', { name: 'Project' }).click()
  await expect(reopened.locator('#autosave-interval')).toHaveValue(String(CHOSEN_INTERVAL))

  // Closing without saving must not rewrite what was loaded — a restart that
  // quietly normalises the file would defeat the whole point of persisting it.
  await reopened.getByRole('button', { name: 'Cancel' }).click()
  await expect(reopened).toBeHidden()
  expect(readPreferences(profile).autosave?.intervalSeconds).toBe(CHOSEN_INTERVAL)
})
