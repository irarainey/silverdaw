// J10 — Exporting a mixdown writes a real audio file.
//
// Export is the terminal act of the product: everything else — importing,
// arranging, mixing — exists to reach this file. It is also the single deepest
// path through the stack, because the JUCE engine renders the audio offline and
// writes the artefact itself (ADR 0002), so the renderer only ever sees progress
// messages. No other tier can prove the render actually produced audio.
//
// The assertion is deliberately made against the decoded header rather than the
// UI's "done" state. A progress dialog that closes proves the renderer stopped
// waiting; it does not prove a single sample was written, and a zero-length or
// header-only file is exactly the regression worth catching.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'

const AUDIO_FILE = 'e2e-mixdown-source.wav'
const SOURCE_SECONDS = 2

interface WavSummary {
  readonly byteRate: number
  readonly dataBytes: number
  readonly seconds: number
}

/**
 * Minimal RIFF/WAVE reader. Walking the chunks rather than assuming a 44-byte
 * header matters here: the engine is free to emit extra chunks, and a reader
 * that assumed a fixed offset would silently measure the wrong thing.
 */
function readWav(path: string): WavSummary {
  const buf = readFileSync(path)
  expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(buf.subarray(8, 12).toString('ascii')).toBe('WAVE')

  let byteRate = 0
  let dataBytes = 0
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii')
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') byteRate = buf.readUInt32LE(offset + 16)
    if (id === 'data') dataBytes = size
    offset += 8 + size + (size % 2)
  }

  expect(byteRate).toBeGreaterThan(0)
  return { byteRate, dataBytes, seconds: dataBytes / byteRate }
}

test('exporting a mixdown writes a playable audio file', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const outputDir = makeTrackedTempDir('mixdown')
  const outputPath = join(outputDir, 'E2E Mixdown.wav')
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: SOURCE_SECONDS })

  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()

  // Export is gated until there is audio to render, so the clip has to be on the
  // timeline — not merely in the library — before the menu item does anything.
  await stubOpenDialog(electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  await invokeMenuItem(page, 'File', 'Export Mixdown')

  // The output path is an ordinary text input, so the native picker behind
  // "Browse…" never has to be opened. No overwrite prompt can appear either:
  // the target is a fresh path in a temp directory.
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').first().fill(outputPath)

  // Export defaults to "Clip at duration", which renders the full 5-minute default
  // project length regardless of content. Choosing "Trim to end of last clip" ties
  // the artefact's length to the clip, which is what makes the duration assertion
  // below mean something rather than just restating a default.
  await dialog.getByRole('radio', { name: 'Trim to end of last clip' }).check()

  await dialog.getByRole('button', { name: 'Export' }).click()

  // Rendering is offline work in the engine, so allow generous time. Polling the
  // file rather than the progress dialog keeps the wait tied to the artefact.
  await expect
    .poll(
      () => {
        try {
          return readFileSync(outputPath).length
        } catch {
          return 0
        }
      },
      { timeout: 60_000, message: `expected a mixdown at ${outputPath}` }
    )
    .toBeGreaterThan(1024)

  // Let the engine finish flushing before parsing, so the chunk walk reads a
  // complete document rather than a partial one.
  await expect(page.getByRole('alertdialog')).toBeHidden({ timeout: 60_000 })

  const wav = readWav(outputPath)
  expect(wav.dataBytes).toBeGreaterThan(0)

  // The render covers the clip and nothing more. With "Trim to end of last clip"
  // selected the artefact's length is the clip's length, so this is a real check on
  // what was rendered rather than a restatement of the default project duration.
  expect(wav.seconds).toBeGreaterThan(SOURCE_SECONDS * 0.75)
  expect(wav.seconds).toBeLessThan(SOURCE_SECONDS * 1.5)
})
