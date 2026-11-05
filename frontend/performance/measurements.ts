/// <reference lib="dom" />

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { stubOpenDialog, stubSaveDialog } from '../e2e/helpers/dialogs.ts'
import { invokeMenuItem } from '../e2e/helpers/menu.ts'
import { projectFolderPath } from '../src/main/projectPaths.ts'
import { findNodes, readProjectDocument } from '../e2e/helpers/projectDocument.ts'
import { summarizeFrames } from './statistics.ts'
import type { FrameSummary, Manifest, Report } from './contracts.ts'
import { assertProjectContent, expandedLaneHeight } from './project-content.ts'

declare global {
  interface Window {
    __silverdawPerfFrames: { id: number; last: number; values: number[] }
  }
}

export async function waitFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

async function captureFrames(page: Page, action: () => Promise<void>): Promise<FrameSummary> {
  await page.evaluate(() => {
    const state = { id: 0, last: 0, values: [] as number[] }
    window.__silverdawPerfFrames = state
    const tick = (now: number): void => {
      if (state.last > 0) state.values.push(now - state.last)
      state.last = now
      state.id = requestAnimationFrame(tick)
    }
    state.id = requestAnimationFrame(tick)
  })
  try {
    await action()
    await waitFrames(page, 2)
    return summarizeFrames(await page.evaluate(() => window.__silverdawPerfFrames.values))
  } finally {
    await page.evaluate(() => cancelAnimationFrame(window.__silverdawPerfFrames.id))
  }
}

export async function measureProject(
  app: ElectronApplication,
  page: Page,
  projectFile: string,
  manifest: Manifest,
  config: Report['config'],
  onPhase: (phase: string) => void
): Promise<Omit<Report['runs'][number], 'resources' | 'bridgeReceived'>> {
  onPhase('project open')
  const check = expect.configure({ timeout: config.timeoutMs })
  const expectedDocument = readProjectDocument(projectFile)
  assert.ok(expectedDocument, 'Input project must be parseable')
  const scrollSpan = manifest.scenario.tracks * 120 + expandedLaneHeight(expectedDocument)
  await stubOpenDialog(app, [projectFile])
  const started = performance.now()
  await page.getByRole('button', { name: 'Open Project\u2026', exact: true }).click()
  await check(page.getByRole('button', { name: manifest.scenario.id, exact: true })).toBeVisible()
  await check(page.getByText('Benchmark 1', { exact: true })).toBeVisible()
  await check(page.locator('canvas').first()).toBeVisible()
  const webgl = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')
    const context = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    return !!context && !context.isContextLost()
  })
  assert.ok(webgl, 'Timeline must use a live WebGL context')
  await waitFrames(page, 2)
  const openToShellPaintMs = performance.now() - started

  onPhase('warmup frames')
  await waitFrames(page, config.warmupFrames)
  onPhase('idle frames')
  const idleFrames = await captureFrames(page, () => waitFrames(page, config.idleFrames))
  const canvas = await page.locator('canvas').first().boundingBox()
  if (!canvas) throw new Error('Timeline canvas has no bounds')
  await page.mouse.move(canvas.x + canvas.width * 0.75, canvas.y + canvas.height * 0.5)
  const wheel = async (zoom: boolean): Promise<FrameSummary> =>
    captureFrames(page, async () => {
      if (zoom) await page.keyboard.down('Control')
      try {
        for (let i = 0; i < config.wheelSteps; i++) {
          const direction = Math.floor(i / 12) % 2 === 0 ? 1 : -1
          await page.mouse.wheel(0, direction * (zoom ? 30 : Math.ceil(scrollSpan / 12)))
          await page.waitForTimeout(50)
        }
      } finally {
        if (zoom) await page.keyboard.up('Control')
      }
    })
  onPhase('scroll frames')
  const scrollFrames = await wheel(false)
  onPhase('zoom frames')
  const zoomFrames = await wheel(true)

  onPhase('save menu')
  const savedFile = projectFolderPath(join(dirname(projectFile), 'benchmark-roundtrip.silverdaw'))
  await stubSaveDialog(app, savedFile)
  await invokeMenuItem(page, 'File', 'Save As\u2026', { exact: true })
  onPhase('save file write')
  await check
    .poll(() => readProjectDocument(savedFile), {
      message: 'Backend must write the generated project through its real project writer'
    })
    .not.toBeNull()
  onPhase('save clean state')
  await check(page.getByLabel('Unsaved changes')).toBeHidden()
  onPhase('save content verification')
  const savedDocument = readProjectDocument(savedFile)
  assert.ok(savedDocument, 'Saved project must be parseable')
  const savedCounts = {
    tracks: findNodes(savedDocument, 'TRACK').length,
    clips: findNodes(savedDocument, 'CLIP').length,
    sources: findNodes(savedDocument, 'ITEM').length
  }
  assert.deepEqual(savedCounts, {
    tracks: manifest.scenario.tracks,
    clips: manifest.scenario.clips,
    sources: manifest.scenario.sources
  })
  assertProjectContent(expectedDocument, savedDocument)
  return { openToShellPaintMs, idleFrames, scrollFrames, zoomFrames, savedCounts }
}
