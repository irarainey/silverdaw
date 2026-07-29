// Native-dialog stubs for the end-to-end tier.
//
// Open/save/message dialogs are OS-owned windows: Playwright drives the
// renderer's DOM and cannot click them, so any journey that imports audio,
// opens or saves a project, or exports a mixdown would deadlock waiting for a
// human. Silverdaw calls these from `main/ipc/{audio,project,mixdown,
// preferences}Handlers.ts` and `main/writableTarget.ts`.
//
// The stubs are installed by monkey-patching Electron's `dialog` module inside
// the already-running main process. That keeps the seam entirely in test code —
// production stays free of test-only branches, and the handler under test runs
// its real path right up to the dialog boundary.

import type { ElectronApplication } from '@playwright/test'

/**
 * Makes the next (and every subsequent) open dialog resolve immediately with
 * `filePaths`, as though the user had picked them. Pass an empty array to
 * simulate cancelling.
 */
export async function stubOpenDialog(
  electronApp: ElectronApplication,
  filePaths: readonly string[]
): Promise<void> {
  await electronApp.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: paths.length === 0, filePaths: [...paths] })
  }, filePaths)
}

/**
 * Makes save dialogs resolve with `filePath`. Pass `null` to simulate the user
 * cancelling the save.
 */
export async function stubSaveDialog(
  electronApp: ElectronApplication,
  filePath: string | null
): Promise<void> {
  await electronApp.evaluate(({ dialog }, target) => {
    // Electron types `filePath` as a plain string, so a cancelled result carries
    // an empty path; callers must branch on `canceled`, exactly as in production.
    dialog.showSaveDialog = async () => ({ canceled: target === null, filePath: target ?? '' })
  }, filePath)
}

/**
 * Makes message boxes resolve by choosing `responseIndex`, so confirmation
 * prompts (such as the overwrite check in `mixdownHandlers`) cannot block a run.
 */
export async function stubMessageBox(
  electronApp: ElectronApplication,
  responseIndex: number
): Promise<void> {
  await electronApp.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = async () => ({ response, checkboxChecked: false })
  }, responseIndex)
}
