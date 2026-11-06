import { expect, test } from '../fixtures/silverdaw'
import { startNewProject } from '../helpers/startup'
import { closeMenu, menuItem, openMenu } from '../helpers/menu'
import { windowHitTest } from '../helpers/windowHitTest'

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
