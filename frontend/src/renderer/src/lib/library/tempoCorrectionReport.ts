// User-facing wording for the result of a tempo correction (ADR 0027).
//
// A correction reconciles more than the number the user typed: every clip following the
// corrected tempo re-derives its ratio and therefore its length, which can scale volume
// shapes, invalidate transitions and push a clip past the project length. ADR 0027
// requires the operation to report what it did AND what it left alone, so it is never a
// silent rewrite of someone's arrangement.
//
// The wording lives here rather than in the bridge handler so it can be tested directly
// and stays identical wherever the result is surfaced.

import type { TempoCorrectionAppliedPayload } from '@shared/bridge-protocol'

/** Tempi are shown to two decimals throughout the tempo UI; a correction is typically a
 *  few percent, so rounding to whole numbers would hide the very error being fixed. */
function formatBpm(bpm: number): string {
  return bpm.toFixed(2)
}

function pluralise(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

/**
 * A one-line summary of what the correction changed, in sentence case.
 *
 * `itemName` is the name of the item the user acted on. When the correction landed on an
 * ancestor instead, the caller passes `ownerName` so the message can say so — silently
 * writing to a different item than the one the user selected is exactly the surprise the
 * report exists to prevent.
 */
export function describeTempoCorrection(
  payload: Extract<TempoCorrectionAppliedPayload, { ok: true }>,
  itemName: string,
  ownerName?: string
): string {
  const parts: string[] = []

  const target =
    payload.ownerReason === 'inheritedBpm' && ownerName && ownerName !== itemName
      ? `"${ownerName}", which "${itemName}" was made from,`
      : `"${itemName}"`
  parts.push(
    `Corrected ${target} from ${formatBpm(payload.previousBpm)} to ${formatBpm(payload.appliedBpm)} BPM.`
  )

  if (payload.clipsUpdated > 0) {
    parts.push(`${pluralise(payload.clipsUpdated, 'clip', 'clips')} re-warped.`)
  }

  return parts.join(' ')
}

/**
 * The things the user may want to act on, as separate lines: exclusions the command made
 * by their own earlier choice, and consequences it could not avoid.
 *
 * Returned separately from the summary because these are not failures and must not read
 * as errors — a pinned clip was pinned deliberately.
 */
export function describeTempoCorrectionCaveats(
  payload: Extract<TempoCorrectionAppliedPayload, { ok: true }>
): string[] {
  const caveats: string[] = []

  if (payload.musicalLengthDiscarded) {
    caveats.push(
      'This item had a measured bar length, which the correction replaced with the tempo you typed.'
    )
  }

  const excluded = payload.clipsPinnedExcluded + payload.clipsUnwarpedExcluded
  if (excluded > 0) {
    const pinned = payload.clipsPinnedExcluded
    const unwarped = payload.clipsUnwarpedExcluded
    if (pinned > 0 && unwarped > 0) {
      // Both reasons apply, so the counts have to be split out to say which is which.
      // `excluded` is at least 2 here, so the plural is always right.
      caveats.push(
        `${excluded} clips were left as they are: ${pinned} ${pinned === 1 ? 'is' : 'are'} pinned and ${unwarped} ${unwarped === 1 ? 'has' : 'have'} warp off.`
      )
    } else {
      // One reason, so repeating the count in it reads as a second, unrelated number.
      const one = excluded === 1
      const reason = pinned > 0 ? (one ? 'is pinned' : 'are pinned') : one ? 'has warp off' : 'have warp off'
      caveats.push(
        `${pluralise(excluded, 'clip was left as it is', 'clips were left as they are')} because ${one ? 'it' : 'they'} ${reason}.`
      )
    }
  }

  if (payload.transitionsRemoved > 0) {
    caveats.push(
      `${pluralise(payload.transitionsRemoved, 'transition', 'transitions')} no longer had an overlap and ${payload.transitionsRemoved === 1 ? 'was' : 'were'} removed.`
    )
  }

  if (payload.clipsPastProjectLength > 0) {
    caveats.push(
      `${pluralise(payload.clipsPastProjectLength, 'clip now extends', 'clips now extend')} past the project length. You can change it in Project Properties.`
    )
  }

  return caveats
}
