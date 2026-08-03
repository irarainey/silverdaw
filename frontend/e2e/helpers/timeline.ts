// Pointer input over the timeline ruler.
//
// The timeline is a PixiJS canvas with no DOM, so a journey that needs the
// playhead somewhere other than the origin, or a range selected, has to drive
// real pointer input. Only the ruler is used, and only with the two gestures a
// user has there: a plain press seeks, and a drag draws a range
// (`lib/timeline/useTimelineRangeSelection.ts`). Neither synthesises
// drag-and-drop, and nothing is read back from the canvas — every assertion
// around these calls is DOM state or the saved project document.

import { type Page } from '@playwright/test'

/** Height of the ruler band in CSS px (`lib/timeline/constants.ts`). */
const RULER_HEIGHT = 28

/**
 * The divider hit area is 6 px wide and straddles the header seam, so its left
 * edge sits 3 px before the first content pixel (`TimelineView.vue`).
 */
const DIVIDER_STRADDLE_PX = 3

interface RulerGeometry {
  /** Client x of the first timeline pixel past the track-header column. */
  firstContentX: number
  /** Client y inside the ruler band. */
  rulerY: number
}

/**
 * Locates the ruler from the header-resize divider rather than from constants:
 * the header column is user-resizable, and the divider spans the full canvas
 * height, so its box gives both the seam and the canvas top in one read.
 */
async function rulerGeometry(page: Page): Promise<RulerGeometry> {
  const divider = await page.getByTitle('Drag to resize track header column').boundingBox()
  if (!divider) throw new Error('timeline header divider has no bounding box')
  return {
    firstContentX: divider.x + DIVIDER_STRADDLE_PX,
    rulerY: divider.y + RULER_HEIGHT / 2
  }
}

/** Moves the playhead by pressing the ruler `offsetPx` past the header column. */
export async function seekOnRuler(page: Page, offsetPx: number): Promise<void> {
  const { firstContentX, rulerY } = await rulerGeometry(page)
  await page.mouse.click(firstContentX + offsetPx, rulerY)
}

/** Drags a range across the ruler between two offsets past the header column. */
export async function dragRulerRange(page: Page, fromPx: number, toPx: number): Promise<void> {
  const { firstContentX, rulerY } = await rulerGeometry(page)
  await page.mouse.move(firstContentX + fromPx, rulerY)
  await page.mouse.down()
  // Stepped, because the drag only starts once the pointer clears a 3 px
  // threshold — a single jump would be taken for a click and seek instead.
  await page.mouse.move(firstContentX + toPx, rulerY, { steps: 20 })
  await page.mouse.up()
}
