// J3 — Project save and reopen round-trip.
//
// The highest-value regression net in the suite. CONTEXT.md makes backward
// compatibility of persisted project files a CRITICAL constraint, and this is
// the only tier that can prove it end to end: the JUCE engine owns the
// `ValueTree` and writes the file (ADR 0002), so a faithful round-trip needs a
// real engine, a real save, a real process restart, and a real load.
//
// The second launch is deliberately a separate process with its own profile.
// Reopening in the same instance would prove only that state survived in
// memory, which is not the guarantee users depend on.

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { createToneWav } from '../helpers/audioFixtures'
import { libraryItem, libraryItems } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject, waitForStartupReady } from '../helpers/startup'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PROJECT_NAME = 'E2E Round Trip'
const AUDIO_FILE = 'e2e-round-trip.wav'

test('a saved project reopens with its library intact after a restart', async ({ launchApp }) => {
  const projectsDir = mkdtempSync(join(tmpdir(), 'silverdaw-e2e-projects-'))
  // A project saves as `<Name>/<Name>.silverdaw`, so the folder the user picks
  // is not the folder the file lands in (main/projectPaths.ts).
  const chosenPath = join(projectsDir, `${PROJECT_NAME}.silverdaw`)
  const projectFile = join(projectsDir, PROJECT_NAME, `${PROJECT_NAME}.silverdaw`)
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: 2 })

  // ── First session: build a project and save it ────────────────────────────
  const first = await launchApp()
  await startNewProject(first.page)

  await stubOpenDialog(first.electronApp, [wavPath])
  await first.page
    .getByRole('button', { name: 'Import', description: 'Import audio files into the library' })
    .click()
  await expect(libraryItem(first.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })

  await stubSaveDialog(first.electronApp, chosenPath)
  await invokeMenuItem(first.page, 'File', 'Save As')

  // Wait for the app to consider the save finished before shutting it down.
  // Polling the file alone is not enough: the name appears in the payload well
  // before the engine has flushed a complete, parseable document, so closing on
  // that signal alone can truncate the very artefact under test.
  await expect(first.page.getByRole('button', { name: PROJECT_NAME })).toBeVisible({
    timeout: 30_000
  })
  await expect(first.page.getByLabel('Unsaved changes')).toBeHidden()

  // The engine performs the write, so assert the real artefact rather than a UI
  // proxy for it — the file on disk is the thing the guarantee is about.
  await expect
    .poll(() => existsSync(projectFile) && readFileSync(projectFile, 'utf8').includes(AUDIO_FILE), {
      timeout: 30_000,
      message: `expected ${projectFile} to reference ${AUDIO_FILE}`
    })
    .toBe(true)

  // Release the engine's handle on the project folder before reopening it.
  await closeSilverdaw(first)

  // ── Second session: a cold process reopens the saved file ─────────────────
  const second = await launchApp()
  await waitForStartupReady(second.page)

  await stubOpenDialog(second.electronApp, [projectFile])

  // A single click, deliberately. The startup screen enables its picker at handshake
  // time, before the engine is ready to load; this must not be dropped, so the open
  // is deferred until the bridge is ready. Retrying here would hide that regression.
  await second.page.getByRole('button', { name: 'Open Project…' }).click()

  await expect(libraryItem(second.page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(libraryItems(second.page)).toHaveCount(1)

  // The name the user chose in the save dialog must survive the restart. The engine
  // used to adopt the filename only after serialising and then mark the project
  // clean, so the file kept "Untitled" and the chosen name was lost on reopen —
  // invisible for the whole of the first session, which is why it went unnoticed.
  await expect(second.page.getByRole('button', { name: PROJECT_NAME })).toBeVisible()
})
