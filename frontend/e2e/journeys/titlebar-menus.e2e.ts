import { expect, test } from '../fixtures/silverdaw'
import { startNewProject } from '../helpers/startup'
import { closeMenu, menuItem, openMenu } from '../helpers/menu'
import { windowHitTest } from '../helpers/windowHitTest'

test('clicking outside the menu dismisses it without consuming the click', async ({ silverdaw }) => {
  const { page, electronApp } = silverdaw
  await startNewProject(page)
  const titlebar = page.locator('header.titlebar')
  const about = menuItem(page, 'About Silverdaw')

  await openMenu(page, 'Help')
  await titlebar.getByRole('button', { name: 'Rename project' }).click()
  await expect(about).toBeHidden()
  await expect(titlebar.getByRole('textbox')).toBeFocused()
  await page.keyboard.press('Escape')

  await openMenu(page, 'Help')
  const spacer = await titlebar.locator(':scope > .flex-1').boundingBox()
  if (!spacer) throw new Error('Title-bar drag spacer has no visible bounds')
  const point = { x: spacer.x + spacer.width * 0.9, y: spacer.y + spacer.height / 2 }
  // DOM clicks bypass Windows routing. The caption must actually receive this press,
  // then become a native drag region again once the menu has closed.
  await expect.poll(() => windowHitTest(electronApp, [point])).toEqual([1])
  await page.mouse.click(point.x, point.y)
  await expect(about).toBeHidden()
  await expect.poll(() => windowHitTest(electronApp, [point])).toEqual([2])

  await openMenu(page, 'Help')
  await page.getByRole('button', { name: 'Add Track', exact: true }).click()
  await expect(about).toBeHidden()
  await openMenu(page, 'Help')
  await page.getByTitle('Mute', { exact: true }).click()
  await expect(about).toBeHidden()
  await expect(page.getByTitle('Unmute', { exact: true })).toBeVisible()
})

test('Windows routes title-bar controls to the app and preserves window dragging', async ({
  silverdaw
}) => {
  const { page, electronApp } = silverdaw
  await startNewProject(page)

  for (const maximized of [false, true]) {
    await electronApp.evaluate(({ BrowserWindow }, maximized) => {
      const win = BrowserWindow.getAllWindows()[0]!
      if (maximized) win.maximize()
      else {
        win.unmaximize()
        win.setSize(1100, 750)
      }
    }, maximized)

    await expect.poll(async () => {
      const titlebar = page.locator('header.titlebar')
      const controls = [
        ...['File', 'Edit', 'View', 'Help'].map((name) =>
          titlebar.getByRole('button', { name, exact: true })
        ),
        titlebar.getByRole('button', { name: 'Untitled', exact: true }),
        titlebar.getByRole('button', { name: 'Rename project', exact: true }),
        ...['Minimise', 'Maximise or restore', 'Close'].map((name) =>
          titlebar.getByRole('button', { name, exact: true })
        ),
        titlebar.getByLabel('Silverdaw', { exact: true })
      ]
      const points = await Promise.all(controls.map(async (control) => {
        const box = await control.boundingBox()
        if (!box) throw new Error('Title-bar control has no visible bounds')
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      }))
      const spacer = await titlebar.locator(':scope > .flex-1').boundingBox()
      if (!spacer) throw new Error('Title-bar drag spacer has no visible bounds')
      points.push({ x: spacer.x + spacer.width * 0.9, y: spacer.y + spacer.height / 2 })
      return windowHitTest(electronApp, points)
    }, { message: `Windows hit regions (maximised: ${maximized})` }).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2 // HTCLIENT for controls; HTCAPTION for drag areas.
    ])

    for (const { menu, item } of [
      { menu: 'File', item: 'Open Project' },
      { menu: 'Edit', item: 'Preferences' },
      { menu: 'View', item: 'Zoom In' },
      { menu: 'Help', item: 'About Silverdaw' }
    ]) {
      await openMenu(page, menu)
      await expect(menuItem(page, item)).toBeVisible()
      await closeMenu(page)
    }
    await openMenu(page, 'Help')
    await menuItem(page, 'About Silverdaw').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  }
})
