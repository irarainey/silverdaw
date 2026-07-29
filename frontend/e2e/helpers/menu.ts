// Drives the custom HTML menu bar.
//
// Silverdaw calls `Menu.setApplicationMenu(null)` and renders its own menu in
// the title bar, so menu commands are ordinary DOM clicks. Going through the
// menu rather than firing an accelerator exercises the same path a user takes,
// and avoids depending on keyboard focus being where a test assumes.

import { type Page } from '@playwright/test'

/**
 * Opens a top-level menu and invokes one of its items. Item labels are matched
 * on their leading text so the trailing accelerator hint (for example
 * "Ctrl+Shift+S") does not have to be repeated by the caller.
 */
export async function invokeMenuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click()
  await page.getByRole('button', { name: new RegExp(`^${escapeForRegExp(item)}`) }).click()
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
