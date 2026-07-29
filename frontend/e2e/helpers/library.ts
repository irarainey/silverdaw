// Locators for the library panel.
//
// Both source tiles (`LibrarySourceGroup`) and the clip rows nested under them
// (`LibraryClipRow`) carry `data-testid="library-item"` plus a
// `data-library-item-name` attribute. Addressing them through that hook keeps
// journeys stable against copy and layout changes — matching on visible text
// alone is ambiguous, because an import also raises a toast containing the same
// file name.

import { type Locator, type Page } from '@playwright/test'

/** All library rows currently listed, in display order. */
export function libraryItems(page: Page): Locator {
  return page.locator('[data-testid="library-item"]')
}

/** The library row for a specific item, by its displayed name. */
export function libraryItem(page: Page, name: string): Locator {
  return page.locator(`[data-testid="library-item"][data-library-item-name="${name}"]`)
}
