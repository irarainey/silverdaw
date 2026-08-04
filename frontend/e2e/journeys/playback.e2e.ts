// J17 — Transport playback actually runs.
//
// Every other journey asserts on the DOM, the filesystem, or a saved project,
// and none of them ever press Play. That left the one thing a DAW must do
// completely uncovered: a regression that froze the playhead — the transport
// reported "playing" while the clock never advanced — shipped past the whole
// suite because nothing in it started the transport.
//
// The gap is structural rather than accidental. The playhead is driven by
// `MasterClockSource`, which only advances from inside the audio device
// callback, so a position that moves is proof that the engine opened a device,
// the callback is firing, and the transport state reached the renderer. No
// offline test can stand in for that: with no device there is no callback, so
// there is no clock. This journey is therefore the one tier that needs a real
// audio endpoint, and on CI that is what the virtual output device is for.
//
// The play button's own tooltip is the device canary. The renderer disables
// Play and titles it "No audio output available…" when the engine reports
// `no_device`, so asserting the button is enabled and titled "Play" fails
// loudly — and legibly — on a machine where the output device never opened,
// rather than timing out later on a playhead that was never going to move.
//
// Position is read from the Bar.Beat.Sub readout because it is the only timing
// field carrying a stable title. The assertion is that the value *changes*,
// never that it reaches a particular bar: the exact distance covered depends on
// how fast the run gets scheduled, and pinning it would buy flakiness for no
// extra proof. Pausing then asserts the opposite — that the value goes still —
// which is what separates a running clock from a display that free-runs.

import { closeSilverdaw, expect, test } from '../fixtures/silverdaw'
import { createToneWav } from '../helpers/audioFixtures'
import { stubOpenDialog } from '../helpers/dialogs'
import { libraryItem } from '../helpers/library'
import { startNewProject } from '../helpers/startup'

const AUDIO_FILE = 'e2e-playback.wav'

/** Long enough that playback cannot reach the end while the journey watches. */
const TONE_SECONDS = 30
/** A paused transport must hold still for this long to count as stopped. */
const PAUSE_SETTLE_MS = 750

test('the transport plays and the playhead advances', async ({ launchApp }) => {
  // Digital silence, deliberately. The playhead is driven by the device
  // callback, which fires on its own timer regardless of what the samples
  // contain, so silence proves exactly as much as a tone would — without the
  // suite making an audible noise on a developer's machine or a runner's
  // virtual output.
  const wavPath = createToneWav({ fileName: AUDIO_FILE, seconds: TONE_SECONDS, amplitude: 0 })

  const app = await launchApp()
  const { page, electronApp } = app
  await startNewProject(page)
  await page.getByRole('button', { name: 'Add Track' }).click()

  // ── Something to play ─────────────────────────────────────────────────────
  // Play stays disabled while the project has no duration, so the transport
  // needs a clip before any of this is meaningful.
  await stubOpenDialog(electronApp, [wavPath])
  await page.getByTitle('Import audio file...').click()
  await expect(libraryItem(page, AUDIO_FILE)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTitle('Track already has a clip')).toBeDisabled({ timeout: 30_000 })

  // ── The audio device opened ───────────────────────────────────────────────
  // Exact role matching: several unrelated controls carry tooltips containing
  // the word "Play" (follow-playback, the metronome), so a title substring
  // match collides with all of them.
  //
  // Waiting for the button to read "Play" is also the device canary. It reads
  // "Starting audio engine…" until the engine is ready and "No audio output
  // available…" when there is no device, so this waits out the device open
  // rather than racing it — and on a machine with no output it fails here,
  // naming the real cause, instead of timing out later on a playhead that was
  // never going to move.
  const playButton = page.getByRole('button', { name: 'Play', exact: true })
  const pauseButton = page.getByRole('button', { name: 'Pause', exact: true })
  await expect(playButton).toBeVisible({ timeout: 30_000 })
  await expect(playButton).toBeEnabled()

  const barPosition = page.getByTitle('Bar.Beat.Sub', { exact: true })

  /** The bar component of a `bar.beat.sub` readout, which starts at 0. */
  const currentBar = async (): Promise<number> => {
    const text = (await barPosition.textContent())?.trim() ?? ''
    return Number(text.split('.')[0])
  }

  expect(await currentBar()).toBe(0)

  // ── Play ──────────────────────────────────────────────────────────────────
  await playButton.click()

  // The button becoming Pause only proves the renderer's transport state
  // flipped — exactly what the frozen-playhead regression already did — so it
  // is a precondition here, not the assertion.
  await expect(pauseButton).toBeVisible({ timeout: 30_000 })

  // The assertion: the clock is running, which can only come from the audio
  // callback. Waiting for a whole bar rather than merely a changed readout is
  // deliberate — a clock that ticked once and then died would satisfy "the
  // value changed", and that is very nearly the regression this exists to
  // catch. Crossing a bar line means the position advanced continuously for
  // roughly two seconds of wall clock.
  await expect
    .poll(currentBar, {
      timeout: 30_000,
      message: 'expected the playhead to advance by a full bar while playing'
    })
    .toBeGreaterThanOrEqual(1)

  // ── Pause ─────────────────────────────────────────────────────────────────
  await pauseButton.click()
  await expect(playButton).toBeVisible({ timeout: 30_000 })

  // Let any in-flight position update land, then require stillness. A display
  // that kept ticking here would mean the readout was not following the engine.
  await page.waitForTimeout(PAUSE_SETTLE_MS)
  const pausedPosition = (await barPosition.textContent())?.trim()
  await page.waitForTimeout(PAUSE_SETTLE_MS)
  expect((await barPosition.textContent())?.trim()).toBe(pausedPosition)

  await closeSilverdaw(app)
})
