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
 */
export function menuItem(page: Page, item: string): Locator {
  return page.getByRole('button', { name: new RegExp(`^${escapeForRegExp(item)}`) })
}

/**
 * Opens a top-level menu and invokes one of its items. Item labels are matched
 * on their leading text so the trailing accelerator hint (for example
 * "Ctrl+Shift+S") does not have to be repeated by the caller.
 */
export async function invokeMenuItem(page: Page, menu: string, item: string): Promise<void> {
  await openMenu(page, menu)
  await menuItem(page, item).click()
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
