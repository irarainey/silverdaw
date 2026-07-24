import { computed, type ComputedRef, type Ref } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type { useScratchEditorSession } from '@/lib/scratch/useScratchEditorSession'

export interface ScratchEditorDerivedState {
  clip: ComputedRef<ReturnType<typeof useProjectStore>['clips'][string] | null>
  /** Resolved id of the source item that actually carries the displayed peaks. */
  sourceItemId: ComputedRef<string | null>
  peaks: ComputedRef<Float32Array>
  peaksPerSecond: ComputedRef<number>
  channelPeaks: ComputedRef<readonly Float32Array[]>
  channelPeaksPerSecond: ComputedRef<number>
  clipInMs: ComputedRef<number>
  clipReversed: ComputedRef<boolean>
  sourceBpm: ComputedRef<number | undefined>
  beatAnchorSec: ComputedRef<number | undefined>
  waveformDurationMs: ComputedRef<number>
  positionMs: ComputedRef<number>
  platterTurns: ComputedRef<number>
  crossfaderValue: ComputedRef<number>
  crossfaderReversed: ComputedRef<boolean>
  isTouched: ComputedRef<boolean>
  clipName: ComputedRef<string>
  statusMessage: ComputedRef<string | null>
  isError: ComputedRef<boolean>
  isRecording: ComputedRef<boolean>
  isArmed: ComputedRef<boolean>
  recordingStatus: ComputedRef<string>
  canRecord: ComputedRef<boolean>
  hasPattern: ComputedRef<boolean>
  /** Cue-selected deck label from the authoritative scratch session. */
  deckLabel: ComputedRef<string | null>
}

export function useScratchEditorDerived(
  clipId: Ref<string | null>,
  session: ReturnType<typeof useScratchEditorSession>
): ScratchEditorDerivedState {
  const project = useProjectStore()
  const library = useLibraryStore()
  const scratchStore = useScratchSessionStore()

  const clip = computed(() => (clipId.value ? project.clips[clipId.value] ?? null : null))
  // The item the session identity points at: a timeline clip's library item, or
  // a library item opened directly from the Library panel (id === item id).
  const metaItem = computed(() => {
    const c = clip.value
    if (c) return library.byId[c.libraryItemId] ?? null
    return clipId.value ? library.byId[clipId.value] ?? null : null
  })
  // Saved clips carry no audio of their own — they window a source item. Resolve
  // the underlying source (mirroring the Clip Editor) so the waveform always has
  // peaks to draw, applying the clip's window via `clipInMs`/`waveformDurationMs`.
  // A baked-scratch sample is likewise a derived item: display its original source
  // (not the already-scratched baked waveform) so the playhead lines up with what
  // the backend re-prepares from the source snapshot.
  const sourceItem = computed(() => {
    const meta = metaItem.value
    if ((meta?.kind === 'clip' || meta?.scratchOrigin === true) && meta?.derivedFrom?.sourceItemId) {
      return library.byId[meta.derivedFrom.sourceItemId] ?? meta
    }
    return meta
  })
  const sourceItemId = computed<string | null>(() => sourceItem.value?.id ?? null)
  const scratchSourcePeaks = computed(() => {
    const source = scratchStore.sourcePeaks
    return source?.sessionId === session.state.value?.sessionId ? source : null
  })
  const peaks = computed(
    () => scratchSourcePeaks.value?.peaks ?? sourceItem.value?.peaks ?? clip.value?.peaks ?? new Float32Array()
  )
  const peaksPerSecond = computed(
    () => scratchSourcePeaks.value?.peaksPerSecond ?? sourceItem.value?.peaksPerSecond ?? clip.value?.peaksPerSecond ?? 0
  )
  const channelPeakEntry = computed(() => {
    const id = sourceItem.value?.id
    return id ? library.channelPeaksByItemId[id] : undefined
  })
  const channelPeaks = computed<readonly Float32Array[]>(() =>
    scratchSourcePeaks.value?.channels.length === 2
      ? scratchSourcePeaks.value.channels
      : channelPeakEntry.value?.channels.length === 2
      ? channelPeakEntry.value.channels
      : []
  )
  const channelPeaksPerSecond = computed(
    () => scratchSourcePeaks.value?.peaksPerSecond ?? channelPeakEntry.value?.peaksPerSecond ?? 0
  )
  // Window into the source: a timeline clip supplies its own in/duration; a
  // directly-opened saved clip its `derivedFrom` window; a raw source the whole file.
  const clipInMs = computed(() => {
    if (scratchSourcePeaks.value) return 0
    if (clip.value) return clip.value.inMs
    const meta = metaItem.value
    return meta?.kind === 'clip' || meta?.scratchOrigin === true
      ? meta?.derivedFrom?.inMs ?? 0
      : 0
  })
  const clipReversed = computed(() => clip.value?.reversed ?? false)
  const sourceBpm = computed(() => sourceItem.value?.bpm)
  const beatAnchorSec = computed(
    () => sourceItem.value?.beatAnchorSec ?? sourceItem.value?.beats?.[0]
  )
  // Peak coordinates remain in source time; the session supplies the separate
  // prepared duration used for playback and playhead positioning.
  const waveformDurationMs = computed(() => {
    if (scratchSourcePeaks.value) return (session.state.value?.durationUs ?? 0) / 1000
    if (clip.value) return clip.value.durationMs
    const meta = metaItem.value
    if (meta?.kind === 'clip' || meta?.scratchOrigin === true) {
      return meta?.derivedFrom?.durationMs ?? meta?.durationMs ?? 0
    }
    return meta?.durationMs ?? 0
  })
  const positionMs = computed(() => (session.state.value?.positionUs ?? 0) / 1000)
  const platterTurns = computed(() => session.state.value?.platterTurns ?? 0)
  const crossfaderValue = computed(() => session.state.value?.crossfader ?? 0.5)
  // The backend keeps this display direction after a platter release. Tying it
  // to transient platter ownership would recolour an unchanged fader.
  const crossfaderReversed = computed(() => session.state.value?.crossfaderReversed ?? false)
  const isTouched = computed(() => session.state.value?.touched ?? false)
  const clipName = computed(() => {
    const c = clip.value
    if (c?.name?.trim()) return c.name.trim()
    return metaItem.value?.name ?? metaItem.value?.fileName ?? ''
  })
  const statusMessage = computed(() => {
    const s = session.state.value
    if (!s || s.status === 'preparing') return 'Preparing scratch session…'
    if (s.status === 'error') return s.error ?? 'The scratch session could not be prepared.'
    return null
  })
  const isError = computed(() => session.state.value?.status === 'error')
  const isRecording = computed(() => session.state.value?.status === 'recording')
  const isArmed = computed(() => session.state.value?.armed === true)
  const recordingStatus = computed(() => scratchStore.recordingStatus)
  const canRecord = computed(() => {
    const status = session.state.value?.status
    return status === 'ready' || status === 'paused' || status === 'playing' || status === 'recording'
  })
  const hasPattern = computed(() => recordingStatus.value === 'completed')
  const deckLabel = computed<string | null>(() => {
    const deck = session.state.value?.selectedDeck ?? null
    if (deck === 1) return 'Deck 1 (Left)'
    if (deck === 2) return 'Deck 2 (Right)'
    return null
  })

  return {
    clip, sourceItemId, peaks, peaksPerSecond, channelPeaks, channelPeaksPerSecond,
    clipInMs, clipReversed, sourceBpm, beatAnchorSec, waveformDurationMs,
    positionMs, platterTurns, crossfaderValue, crossfaderReversed, isTouched, clipName,
    statusMessage, isError, isRecording, isArmed, recordingStatus, canRecord, hasPattern,
    deckLabel
  }
}
