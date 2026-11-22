import { readFileSync, writeFileSync } from 'node:fs'
import { expect, test } from '../fixtures/silverdaw'
import { stubOpenDialog } from '../helpers/dialogs'
import { invokeMenuItem } from '../helpers/menu'
import { findNode, readProjectDocument, type ProjectNode } from '../helpers/projectDocument'
import { copyProjectFixture } from '../helpers/projectFixtures'
import { waitForStartupReady } from '../helpers/startup'

test('stacked gain handles can be picked, nudged and saved independently', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  const file = copyProjectFixture()
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { project: ProjectNode }
  const points = [{ timeMs: 0, value: 0 }, { timeMs: 1000, value: 0 },
    { timeMs: 1200, value: -24 }, { timeMs: 2000, value: -24 }]
  doc.project.$children!.push({ $type: 'TRACK', id: 't1', name: 'Steps', gain: 1,
    automationLaneView: [{ paramId: 'level', heightPx: 120 }],
    automation: [{ paramId: 'level', points }] })
  writeFileSync(file, JSON.stringify(doc))
  const saved = () => {
    const root = readProjectDocument(file)
    return root && findNode(root, 'TRACK')?.automation
  }
  await waitForStartupReady(page)
  await stubOpenDialog(electronApp, [file])
  await page.getByRole('button', { name: 'Open Project…' }).click()
  const picker = page.getByTitle('Automation parameter — Gain')
  const canvas = page.locator('canvas')
  await expect(canvas).toBeVisible()
  await picker.click({ trial: true }) // wait for the restored lane layout to settle
  const lane = await picker.locator('../..').boundingBox()
  const divider = await page.getByTitle('Drag to resize track header column').boundingBox()
  if (!lane || !divider) throw new Error('Missing automation lane geometry')
  const x = divider.x + 3 + 100 // fixture zoom: 100 px/s
  const y = (db: number) => Math.round(lane.y + 8 + (6 - db) / 66 * (lane.height - 16))
  await page.mouse.move(x + 20, y(-24)) // second handle starts at 1200 ms
  await expect(page.getByText('-24.0 dB', { exact: true })).toBeVisible()
  await page.mouse.down()
  await page.mouse.move(x - 4, y(-24), { steps: 5 })
  await page.mouse.up()
  await invokeMenuItem(page, 'File', 'Save', { exact: true })
  await expect.poll(saved).toEqual([{ paramId: 'level', points: [
    points[0], points[1], { timeMs: 1000, value: -24 }, points[3]
  ] }])

  await page.mouse.move(x, y(-24))
  await page.mouse.down()
  await page.keyboard.press('ArrowRight')
  await page.mouse.up() // finishing the pointer gesture must not replay the pre-nudge curve
  await page.mouse.click(x, y(0))
  await page.keyboard.press('ArrowLeft')
  await picker.focus()
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft') // no longer controls a point
  await invokeMenuItem(page, 'File', 'Save', { exact: true })
  await expect.poll(saved).toEqual([{ paramId: 'level', points: [
    points[0], { timeMs: 995, value: 0 }, { timeMs: 1005, value: -24 }, points[3]
  ] }])

  await page.mouse.move(x - 0.5, y(0) - 4)
  await page.mouse.down()
  await page.mouse.move(x - 0.5, lane.y - 10)
  await page.mouse.up()
  await invokeMenuItem(page, 'File', 'Save', { exact: true })
  await expect.poll(saved).toEqual([{ paramId: 'level', points: [
    points[0], { timeMs: 995, value: 6 }, { timeMs: 1005, value: -24 }, points[3]
  ] }])
})
