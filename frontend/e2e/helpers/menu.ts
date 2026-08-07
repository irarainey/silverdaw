// Drives the custom HTML menu bar.
//
// Silverdaw calls `Menu.setApplicationMenu(null)` and renders its own menu in
// the title bar, so menu commands are ordinary DOM clicks. Going through the
// menu rather than firing an accelerator exercises the same path a user takes,
// and avoids depending on keyboard focus being where a test assumes.

import { type Locator, type Page } from '@playwright/test'

/**
 * Opens a top-level menu and leaves it open, so callers can inspect an item's
 * state (Undo and Redo grey out from backend-driven store state) rather than
 * only invoking it.
 */
export async function openMenu(page: Page, menu: string): Promise<void> {
  await page.getByRole('button', { name: menu, exact: true }).click()
}

/** Closes any open menu without invoking anything. */
export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
}

/**
 * Locates an item inside the currently-open menu. Matched on leading text so the
 * trailing accelerator hint (for example "Ctrl+Z") does not have to be repeated.
 *
 * Pass `exact` for a label that is a prefix of another in the same menu — "Save"
 * sits beside "Save As…", so the default prefix match is ambiguous and Playwright
 * refuses it. Each row renders its label in its own `<span>` next to the
 * accelerator (`AppTitleBar.vue`), so an exact match on that span picks the row
 * out without the caller having to spell out an accelerator it does not care
 * about.
 */
export function menuItem(page: Page, item: string, options: { exact?: boolean } = {}): Locator {
  if (options.exact) {
    return page.getByRole('button').filter({ has: page.getByText(item, { exact: true }) })
  }
  return page.getByRole('button', { name: new RegExp(`^${escapeForRegExp(item)}`) })
}

/**
 * Opens a top-level menu and invokes one of its items. Item labels are matched
 * on their leading text so the trailing accelerator hint (for example
 * "Ctrl+Shift+S") does not have to be repeated by the caller; see `menuItem` for
 * when `exact` is needed.
 */
export async function invokeMenuItem(
  page: Page,
  menu: string,
  item: string,
  options: { exact?: boolean } = {}
): Promise<void> {
  await openMenu(page, menu)
  await menuItem(page, item, options).click()
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
