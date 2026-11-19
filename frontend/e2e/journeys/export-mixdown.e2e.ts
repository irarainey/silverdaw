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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFile } from 'music-metadata'

import { expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog, stubSaveDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { invokeMenuItem } from '../helpers/menu'
import { readProjectDocument } from '../helpers/projectDocument'
import { startNewProject } from '../helpers/startup'
import { makeTrackedTempDir } from '../helpers/tempDirs'
import { dragRulerRange } from '../helpers/timeline'

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

async function publishedBatch(parent: string): Promise<string> {
  const batches = (): string[] => existsSync(parent)
    ? readdirSync(parent).filter(name => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?$/.test(name))
    : []
  await expect.poll(batches, { timeout: 60_000 }).toHaveLength(1)
  return join(parent, batches()[0])
}

test('both export dialogs opt in to exactly the selected ruler range', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const root = makeTrackedTempDir('range-export')
  const name = 'Range export'
  const dialog = page.getByRole('dialog')
  const checkbox = dialog.getByRole('checkbox', { name: 'Export selected range only' })
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubOpenDialog(electronApp, [createToneWav({ fileName: AUDIO_FILE, seconds: 4 })])
  await page.getByTitle('Import audio file...').click()
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add Track' }).click()
  for (const command of ['Export Mixdown', 'Export Tracks']) {
    await invokeMenuItem(page, 'File', command)
    await expect(checkbox).toBeDisabled()
    await expect(checkbox).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  }
  await dragRulerRange(page, 40, 220)
  await expect(page.getByTitle('Loop Selection (off) (L)')).toBeEnabled()
  await stubSaveDialog(electronApp, join(root, `${name}.silverdaw`))
  await invokeMenuItem(page, 'File', 'Save As')
  const projectFile = join(root, name, `${name}.silverdaw`)
  await expect.poll(() => readProjectDocument(projectFile)?.viewTimelineSelectionStartMs).toBeGreaterThan(0)
  const project = readProjectDocument(projectFile)!
  const startMs = Number(project.viewTimelineSelectionStartMs)
  const endMs = Number(project.viewTimelineSelectionEndMs)
  const sampleRate = 48000
  const frames = Math.round(endMs * sampleRate / 1000) - Math.round(startMs * sampleRate / 1000)
  expect(frames).toBeGreaterThan(0)
  for (const command of ['Export Mixdown', 'Export Tracks']) {
    await invokeMenuItem(page, 'File', command)
    await expect(checkbox).toBeEnabled()
    await expect(checkbox).not.toBeChecked()
    await checkbox.check()
    await dialog.getByLabel('Sample rate').selectOption(String(sampleRate))
    const mixFile = join(root, 'mix.wav')
    if (command === 'Export Mixdown') {
      await expect(dialog.getByRole('radio', { name: 'Trim to end of last clip' })).toBeDisabled()
      await dialog.getByRole('textbox').first().fill(mixFile)
    } else {
      await expect(dialog.getByLabel('Tail (seconds)', { exact: true })).toBeDisabled()
    }
    await dialog.getByRole('button', { name: 'Export', exact: true }).click()
    if (command === 'Export Mixdown') {
      await expect.poll(() => existsSync(mixFile), { timeout: 60_000 }).toBe(true)
      expect(Math.round(readWav(mixFile).seconds * sampleRate)).toBe(frames)
    } else {
      const batch = await publishedBatch(join(root, name, 'export'))
      const tracks = readdirSync(batch)
      expect(tracks).toHaveLength(2)
      for (const track of tracks) expect(Math.round(readWav(join(batch, track)).seconds * sampleRate)).toBe(frames)
    }
    await expect(page.getByRole('alertdialog')).toBeHidden()
    await invokeMenuItem(page, 'File', command)
    await expect(checkbox).toBeEnabled()
    await expect(checkbox).not.toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  }
})

test('Export Tracks remembers a selective export and preserves full arrangement length', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const projects = makeTrackedTempDir('track-export')
  const name = 'Aligned Tracks'
  const defaultFolder = join(projects, name, 'export')
  const source = createToneWav({ fileName: AUDIO_FILE, seconds: SOURCE_SECONDS })
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubOpenDialog(electronApp, [source])
  await page.getByTitle('Import audio file...').click()
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Add Track' }).click()
  await stubSaveDialog(electronApp, join(projects, `${name}.silverdaw`))
  await invokeMenuItem(page, 'File', 'Export Tracks')
  const dialog = page.getByRole('dialog', { name: 'Export Tracks' })
  const format = dialog.getByLabel('Format', { exact: true })
  await expect(format).toHaveValue('wav')
  await expect(dialog.getByLabel('Bit depth')).toHaveValue('24')
  const tail = dialog.getByLabel('Tail (seconds)', { exact: true })
  expect(Math.abs(await tail.evaluate(el => el.getBoundingClientRect().top)
    - await dialog.getByLabel('Sample rate').evaluate(el => el.getBoundingClientRect().top))).toBeLessThanOrEqual(2)
  await tail.fill('0.5')
  await expect(tail).toHaveAttribute('aria-invalid', 'true')
  await expect(dialog.getByRole('button', { name: 'Save and Export' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Increase tail' }).click()
  await expect(tail).toHaveValue('1')
  await expect(tail).toHaveAttribute('aria-invalid', 'false')
  await dialog.getByRole('button', { name: 'Decrease tail' }).click()
  await expect(dialog.getByLabel('Include track effects')).toBeChecked()
  await expect(dialog.getByRole('button', { name: 'Tracks: All 2 selected' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save and Export' }).click()
  const batch = await publishedBatch(defaultFolder)
  const files = readdirSync(batch)
  expect(files.sort()).toEqual(['Track 2.wav', AUDIO_FILE])
  const first = readWav(join(batch, AUDIO_FILE))
  expect(first.seconds).toBeGreaterThan(1)
  expect(readWav(join(batch, 'Track 2.wav'))).toEqual(first)
  await expect(page.getByRole('alertdialog')).toBeHidden()

  // App accelerators defer while the imported source is still being analysed.
  await expect(page.getByText('Processing audio', { exact: true })).toBeHidden({ timeout: 30_000 })
  await invokeMenuItem(page, 'File', 'Save', { exact: true })
  const dirty = page.getByTitle('Unsaved changes', { exact: true })
  await expect(dirty).toBeHidden()
  await page.keyboard.press('Control+Shift+M')
  const folder = dialog.getByLabel('Output folder')
  await expect(folder).toHaveValue(defaultFolder)
  const alternate = makeTrackedTempDir('selected-tracks')
  await stubOpenDialog(electronApp, [alternate])
  await dialog.getByRole('button', { name: 'Browse' }).click()
  await expect(folder).toHaveValue(alternate)
  await dialog.getByRole('button', { name: 'Tracks: All 2 selected' }).click()
  await dialog.getByText('Select all tracks', { exact: true }).click()
  const start = dialog.getByRole('button', { name: 'Export', exact: true })
  await expect(start).toBeDisabled()
  const secondTrack = dialog.getByRole('checkbox', { name: 'Track 2', exact: true })
  const secondRow = dialog.locator('label').filter({ hasText: /^Track 2$/ })
  await secondRow.click() // Middle of the row, beyond the name and checkbox.
  await expect(secondTrack).toBeChecked()
  await dialog.getByText('Track 2', { exact: true }).click()
  await expect(secondTrack).not.toBeChecked()
  await secondTrack.press('Space')
  await expect(secondTrack).toBeChecked()
  await dialog.getByLabel('Bit depth').selectOption('32')
  const reference = (await parseFile(join(batch, 'Track 2.wav'))).format
  for (const [type, container] of [['flac', 'FLAC'], ['aiff', 'AIFF'], ['mp3', 'MPEG']] as const) {
    await format.selectOption(type)
    if (type === 'mp3') {
      await dialog.getByLabel('Bitrate').selectOption('320')
    } else {
      await expect(dialog.getByLabel('Bit depth')).toHaveValue('24')
    }
    const output = type === 'flac' ? alternate : makeTrackedTempDir(type)
    await folder.fill(output)
    await start.click()
    const selectiveBatch = await publishedBatch(output)
    const filename = `Track 2.${type}`
    expect(readdirSync(selectiveBatch)).toEqual([filename])
    const audio = (await parseFile(join(selectiveBatch, filename))).format
    expect(audio.container).toContain(container)
    expect(audio.sampleRate).toBe(reference.sampleRate)
    if (type === 'mp3') {
      expect(audio.bitrate).toBe(320_000)
    } else {
      expect(audio.duration).toBe(first.seconds)
      expect(audio.bitsPerSample).toBe(24)
    }

    await expect(page.getByRole('alertdialog')).toBeHidden()
    await expect(dirty).toBeHidden()
    await page.keyboard.press('Control+Shift+M')
    await expect(folder).toHaveValue(output)
    await expect(format).toHaveValue(type)
  }
  await dialog.getByRole('button', { name: 'Tracks: 1 of 2 selected' }).click()
  await expect(secondTrack).toBeChecked()
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  const firstName = await page.getByTitle(/ — click to rename$/).first().innerText()
  await page.getByRole('button', { name: `Export ${firstName}…`, exact: true }).click()
  await dialog.getByRole('button', { name: 'Tracks: 1 of 2 selected' }).click()
  await expect(dialog.getByRole('checkbox', { name: firstName, exact: true })).toBeChecked()
  await expect(secondTrack).not.toBeChecked()
  const singleFolder = makeTrackedTempDir('header-track')
  await folder.fill(singleFolder)
  await start.click()
  expect(readdirSync(await publishedBatch(singleFolder))).toEqual([`${firstName}.mp3`])
  await expect(page.getByRole('alertdialog')).toBeHidden()
  await expect(dirty).toBeHidden()
  await page.getByRole('button', { name: 'Add Track' }).click()
  await expect(dirty).toBeVisible()
  await stubOpenDialog(electronApp, [join(projects, name, `${name}.silverdaw`)])
  await invokeMenuItem(page, 'File', 'Open Project')
  await page.getByRole('button', { name: "Don't Save" }).click()
  await expect(dirty).toBeHidden()
  await invokeMenuItem(page, 'File', 'Export Tracks')
  await expect(folder).toHaveValue(singleFolder)
  await expect(format).toHaveValue('mp3')
  await dialog.getByRole('button', { name: 'Tracks: 1 of 2 selected' }).click()
  await expect(secondTrack).toBeChecked()
})
