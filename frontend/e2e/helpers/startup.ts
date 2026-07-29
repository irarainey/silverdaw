// Shared startup and project-shell steps.
//
// Every journey begins the same way — wait for the engine handshake, then get
// past the startup screen into the arrangement view. Centralising that keeps
// each spec about the behaviour it actually tests, and means a change to the
// startup flow is fixed in one place rather than in every journey.

import { expect, type Locator, type Page } from '@playwright/test'

/**
 * A cold engine start pays for process spawn, bridge AUTH, and audio-device
 * open, none of which is under the test's control.
 */
export const STARTUP_TIMEOUT_MS = 60_000

/**
 * Waits for the startup screen's ready state. The project buttons render only
 * once `transport.handshakeReady` is true, so their presence is proof that the
 * whole cross-process chain — spawn, port resolution, AUTH, handshake —
 * completed, without needing a test hook in production code.
 */
export async function waitForStartupReady(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible({
    timeout: STARTUP_TIMEOUT_MS
  })
}

/** Waits for readiness, then enters an empty project's arrangement view. */
export async function startNewProject(page: Page): Promise<void> {
  await waitForStartupReady(page)
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.getByRole('button', { name: 'New Project' })).toBeHidden()
}

/**
 * A row in the start screen's recent list, located by the full project path it
 * carries as its tooltip.
 *
 * The path rather than the display name, because each row also has a "Remove
 * <name> from recent projects" button — matching on the name alone is ambiguous
 * and would risk a spec clicking Remove while believing it clicked Open.
 */
export function recentProjectEntry(page: Page, projectFilePath: string): Locator {
  return page.getByTitle(projectFilePath, { exact: true })
}
