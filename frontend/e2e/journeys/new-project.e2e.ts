// J4 — Starting a new project the instant the start screen appears.
//
// The start screen offers its buttons as soon as the engine handshake lands, which
// is before the engine will accept instructions. A click in that window used to be
// dropped outright, leaving the user on the engine's boot state instead of a real
// new project — silently at unity master volume rather than the headroom PROJECT_NEW
// sets. Master volume is the assertion precisely because it is the part that failed
// invisibly: the timeline looked correct either way.

import { expect, test } from '../fixtures/silverdaw'
import { libraryItems } from '../helpers/library'
import { startNewProject } from '../helpers/startup'

test('a new project started immediately still gets its own default mix', async ({
  silverdaw
}) => {
  // `startNewProject` clicks as soon as the button is actionable, which is the
  // window this journey exists to cover.
  await startNewProject(silverdaw.page)

  await expect(silverdaw.page.getByTitle(/^Master volume:/)).toHaveAttribute(
    'title',
    'Master volume: -10.0 dB'
  )
  await expect(libraryItems(silverdaw.page)).toHaveCount(0)
})
