// Shared beat-grid inheritance for derived library items (separated stems and
// saved music samples). Copies the source item's tempo/beats/anchor/key onto the
// derived item, shifting beats back by the derived item's window start so they
// land on the derived item's own timeline (its sample 0 = source time
// `windowStartSec`). Classification (`audioType`) and the `lowConfidence`
// auto-flag are deliberately NOT copied — each caller owns those.

import { useLibraryStore } from '@/stores/libraryStore'

type LibraryStore = ReturnType<typeof useLibraryStore>
type SourceItem = ReturnType<LibraryStore['getItem']>

export function inheritSourceAnalysis(
  library: LibraryStore,
  targetId: string,
  source: SourceItem,
  windowStartSec: number
): void {
  if (!source || !(source.bpm && source.bpm > 0)) return
  const shift = windowStartSec > 0 ? windowStartSec : 0
  const anchor = (source.beatAnchorSec ?? source.beats?.[0] ?? 0) - shift
  const beats = source.beats ? source.beats.map((b) => b - shift).filter((b) => b >= 0) : []
  library.setItemAnalysis(
    targetId,
    source.bpm,
    anchor,
    beats,
    source.variableTempo === true,
    undefined,
    false
  )
  if (source.key) library.setItemKey(targetId, source.key)
}
