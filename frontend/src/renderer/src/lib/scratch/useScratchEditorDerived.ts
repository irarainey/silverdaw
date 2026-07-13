import { computed, type ComputedRef, type Ref } from 'vue'
import { useLibraryStore } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useScratchSessionStore } from '@/stores/scratchSessionStore'
import type { useScratchEditorSession } from '@/lib/scratch/useScratchEditorSession'

export interface ScratchEditorDerivedState {
  clip: ComputedRef<ReturnType<typeof useProjectStore>['clips'][string] | null>
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
  isTouched: ComputedRef<boolean>
  clipName: ComputedRef<string>
  statusMessage: ComputedRef<string | null>
  isError: ComputedRef<boolean>
  isRecording: ComputedRef<boolean>
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
  const peaks = computed(() => {
    const item = clip.value ? (library.byId[clip.value.libraryItemId] ?? null) : null
    return item?.peaks ?? clip.value?.peaks ?? new Float32Array()
  })
  const peaksPerSecond = computed(() => {
    const item = clip.value ? (library.byId[clip.value.libraryItemId] ?? null) : null
    return item?.peaksPerSecond ?? clip.value?.peaksPerSecond ?? 0
  })
  const channelPeakEntry = computed(() => {
    const item = clip.value ? (library.byId[clip.value.libraryItemId] ?? null) : null
    const sourceId = item?.kind === 'clip' ? item.derivedFrom?.sourceItemId : item?.id
    return sourceId ? library.channelPeaksByItemId[sourceId] : undefined
  })
  const channelPeaks = computed<readonly Float32Array[]>(() =>
    channelPeakEntry.value?.channels.length === 2
      ? channelPeakEntry.value.channels
      : []
  )
  const channelPeaksPerSecond = computed(() =>
    channelPeakEntry.value?.peaksPerSecond ?? 0
  )
  const clipInMs = computed(() => clip.value?.inMs ?? 0)
  const clipReversed = computed(() => clip.value?.reversed ?? false)
  const sourceBpm = computed(() => {
    const item = clip.value ? (library.byId[clip.value.libraryItemId] ?? null) : null
    return item?.bpm
  })
  const beatAnchorSec = computed(() => {
    const item = clip.value ? (library.byId[clip.value.libraryItemId] ?? null) : null
    return item?.beatAnchorSec ?? item?.beats?.[0]
  })
  // Peak coordinates remain in source time; the session supplies the separate
  // prepared duration used for playback and playhead positioning.
  const waveformDurationMs = computed(() => clip.value?.durationMs ?? 0)
  const positionMs = computed(() => (session.state.value?.positionUs ?? 0) / 1000)
  const platterTurns = computed(() => session.state.value?.platterTurns ?? 0)
  const crossfaderValue = computed(() => session.state.value?.crossfader ?? 0.5)
  const isTouched = computed(() => session.state.value?.touched ?? false)
  const clipName = computed(() => {
    const c = clip.value
    if (c?.name?.trim()) return c.name.trim()
    const item = c ? (library.byId[c.libraryItemId] ?? null) : null
    return item?.name ?? item?.fileName ?? ''
  })
  const statusMessage = computed(() => {
    const s = session.state.value
    if (!s || s.status === 'preparing') return 'Preparing scratch session…'
    if (s.status === 'error') return s.error ?? 'The scratch session could not be prepared.'
    return null
  })
  const isError = computed(() => session.state.value?.status === 'error')
  const isRecording = computed(() => session.state.value?.status === 'recording')
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
    clip, peaks, peaksPerSecond, channelPeaks, channelPeaksPerSecond,
    clipInMs, clipReversed, sourceBpm, beatAnchorSec, waveformDurationMs,
    positionMs, platterTurns, crossfaderValue, isTouched, clipName,
    statusMessage, isError, isRecording, recordingStatus, canRecord, hasPattern,
    deckLabel
  }
}
