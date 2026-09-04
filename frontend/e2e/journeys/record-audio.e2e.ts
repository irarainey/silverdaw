// J27 — Record Audio: the dialog opens against a real backend session, and closes without a trace.
//
// Recording is the one feature whose interesting behaviour cannot be asserted on an arbitrary
// machine: whether a take can be captured at all depends on the capture hardware the runner
// happens to have, and on Windows microphone consent. A journey that pressed Record would pass
// or fail on the machine rather than on Silverdaw. So this journey stops at the boundary that
// *is* deterministic — the dialog opens a real backend session over the bridge, the session
// reports what it found, and closing the dialog releases it — and leaves capture, finalise and
// commit to the backend unit tests and the renderer's own suite, where they are exact.
//
// The one thing that cannot be proven anywhere else is that the round trip happens at all: the
// dialog's controls are driven entirely by RECORD_SESSION_STATE, so a device select that is
// populated (or a plain "no input" message when the machine has none) is proof the envelope
// made it out to the JUCE process and back.

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { menuItem, openMenu } from '../helpers/menu'
import { startNewProject } from '../helpers/startup'

test('the Record Audio dialog opens a backend session and releases it on close', async ({
  launchApp
}) => {
  const app = await launchApp()
  const { page } = app

  await startNewProject(page)

  const recordButton = page.getByRole('button', { name: /^Record Audio…/ })
  await expect(recordButton).toBeVisible()
  await recordButton.click()

  const dialog = page.getByRole('dialog', { name: 'Record Audio' })
  await expect(dialog).toBeVisible()

  // A recording belongs to a window in time, not a track. With nothing selected the
  // range option is offered but inert, so it cannot be chosen without a selection.
  const fromPlayhead = dialog.getByRole('radio', { name: /From Playhead/ })
  await expect(fromPlayhead).toBeChecked({ timeout: 30_000 })
  await expect(dialog.getByRole('radio', { name: /Over the Selected Range/ })).toBeDisabled()

  // Count-in is off unless asked for, and switching it on is a dialog-local choice.
  const countIn = dialog.getByRole('checkbox', { name: /Count Me In/ })
  await expect(countIn).not.toBeChecked()
  await countIn.click()
  await expect(countIn).toBeChecked()

  // Either the session found a capture device or it did not; both are real answers from the
  // backend, and both must leave the dialog honest rather than showing an empty picker.
  const deviceSelect = dialog.getByLabel('Recording input device')
  const noInput = dialog.getByText('No microphone or audio input was found.', { exact: false })
  await expect(deviceSelect.or(noInput).first()).toBeVisible()
  if (await noInput.isVisible()) {
    await expect(dialog.getByRole('button', { name: 'Record', exact: true })).toBeDisabled()
  } else {
    await expect(deviceSelect).toBeEnabled()
    await expect(dialog.getByRole('button', { name: 'Record', exact: true })).toBeEnabled()
  }

  // Escape closes the dialog, which closes the session and releases the capture device.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // The File menu reaches the same single dialog, and Cancel closes it just as Escape does.
  await openMenu(page, 'File')
  const menuRow = menuItem(page, 'Record Audio…', { exact: true })
  await expect(menuRow).toBeVisible()
  await menuRow.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  // Nothing was recorded, so nothing was added: the project is still empty.
  await expect(page.getByRole('button', { name: 'Add Track' })).toBeVisible()

  await closeSilverdaw(app)
})
