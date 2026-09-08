// Shared beat-grid inheritance for derived library items (separated stems and
// saved music samples). Copies the source item's tempo/beats/anchor/key onto the
// derived item, shifting beats back by the derived item's window start so they
// land on the derived item's own timeline (its sample 0 = source time
// `windowStartSec`). Classification (`audioType`) and the `lowConfidence`
// auto-flag are deliberately NOT copied — each caller owns those.

import { libraryItemSourceBpm } from '@/stores/libraryItemHelpers'
import { buildRigidBeatGrid } from '@/lib/library/rigidBeatGrid'
import { useLibraryStore } from '@/stores/libraryStore'

type LibraryStore = ReturnType<typeof useLibraryStore>
type SourceItem = ReturnType<LibraryStore['getItem']>

export function inheritSourceAnalysis(
  library: LibraryStore,
  targetId: string,
  source: SourceItem,
  windowStartSec: number
): void {
  // Resolved, not raw: a source that holds its own tempo only by inheritance — a
  // saved clip, a sample, an older stem — must still be able to pass it on, and a
  // one-shot must pass on nothing. Reading `source.bpm` here left stems separated
  // from such an item with no grid at all (ADR 0024: one resolver per process).
  const sourceBpm = source ? libraryItemSourceBpm(source, library.byId) : undefined
  if (!source || sourceBpm === undefined || !(sourceBpm > 0)) return
  const shift = windowStartSec > 0 ? windowStartSec : 0
  const anchor = (source.beatAnchorSec ?? source.beats?.[0] ?? 0) - shift
  let beats = source.beats ? source.beats.map((b) => b - shift).filter((b) => b >= 0) : []
  // A window that begins after the source's last detected beat drops every beat
  // above, leaving an empty list even though the inherited tempo + phase fully
  // describe the grid. `setItemAnalysis` treats an empty list as "no grid" and
  // nulls the anchor, so the derived item would show no beat markers despite a
  // valid BPM. Synthesise the rigid grid from (bpm, anchor) across the derived
  // item's own window — both the timeline and the Clip Editor render the grid
  // by extrapolating from those two values, so the synthesised beats restore the
  // markers without changing where they land.
  if (beats.length === 0) {
    const durationSec = Math.max(0, (library.getItem(targetId)?.durationMs ?? 0) / 1000)
    beats = buildRigidBeatGrid(sourceBpm, anchor, durationSec)
  }
  library.setItemAnalysis(
    targetId,
    sourceBpm,
    anchor,
    beats,
    source.variableTempo === true,
    undefined,
    false
  )
  if (source.key) library.setItemKey(targetId, source.key)
}
