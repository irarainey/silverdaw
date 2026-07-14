import { computed, ref, watch, type Ref } from 'vue'
import { send as sendBridge } from '@/lib/bridgeService'
import { useProjectStore } from '@/stores/projectStore'
import {
  buildBackingClearPayload,
  buildBackingGainPayload,
  buildBackingPreparePayload,
  buildScratchGainPayload
} from '@/lib/scratch/scratchControlHelpers'
import type {
  ScratchBackingDurationSec,
  ScratchBackingStartAnchor,
  ScratchBackingStatus,
  ScratchSessionStatePayload
} from '@shared/bridge-protocol'

const DEFAULT_DURATION_SEC: ScratchBackingDurationSec = 60

/**
 * Backing accompaniment monitor controller (ADR 0021, Amendment 1). Owns the
 * renderer-side selection state (tracks, start anchor, duration) and issues the
 * offline-render prepare/clear requests. The authoritative readiness comes back
 * on the scratch session state, so status here mirrors the backend.
 */
export function useScratchBacking(
  sessionId: Ref<string | null>,
  state: Ref<ScratchSessionStatePayload | null>,
  clipId: Ref<string | null>
) {
  const project = useProjectStore()

  const startAnchor = ref<ScratchBackingStartAnchor>('arrangement')
  const durationSec = ref<ScratchBackingDurationSec>(DEFAULT_DURATION_SEC)
  const selectedTrackIds = ref<Set<string>>(new Set())

  /** The track that owns the clip being scratched — excluded from the bed by default. */
  const owningTrackId = computed(() => {
    const id = clipId.value
    if (!id) return null
    return project.tracks.find((track) => track.clipIds.includes(id))?.id ?? null
  })

  const tracks = computed(() =>
    project.tracks.map((track) => ({ id: track.id, name: track.name }))
  )

  // Seed the default selection (every track except the one being scratched)
  // whenever the clip changes. The user can freely override afterwards.
  watch(
    clipId,
    () => {
      const next = new Set<string>()
      for (const track of project.tracks) {
        if (track.id !== owningTrackId.value) next.add(track.id)
      }
      selectedTrackIds.value = next
    },
    { immediate: true }
  )

  const status = computed<ScratchBackingStatus>(() => state.value?.backingStatus ?? 'none')
  const isPreparing = computed(() => status.value === 'preparing')
  const isReady = computed(() => status.value === 'ready')
  const hasError = computed(() => status.value === 'error')
  const errorMessage = computed(() => state.value?.backingError ?? null)
  const readyDurationSec = computed(() => {
    const us = state.value?.backingDurationUs ?? 0
    return us > 0 ? Math.round(us / 1_000_000) : 0
  })

  const selectedCount = computed(() => selectedTrackIds.value.size)
  const canPrepare = computed(
    () => sessionId.value !== null && selectedCount.value > 0 && !isPreparing.value
  )

  function isSelected(trackId: string): boolean {
    return selectedTrackIds.value.has(trackId)
  }

  function toggleTrack(trackId: string): void {
    const next = new Set(selectedTrackIds.value)
    if (next.has(trackId)) next.delete(trackId)
    else next.add(trackId)
    selectedTrackIds.value = next
  }

  function setStartAnchor(anchor: ScratchBackingStartAnchor): void {
    startAnchor.value = anchor
  }

  function setDuration(seconds: ScratchBackingDurationSec): void {
    durationSec.value = seconds
  }

  // Monitor-only balance while auditioning; never baked into recorded patterns.
  // Values mirror the authoritative session state so external changes reconcile.
  const monitorGain = computed(() => state.value?.backingGain ?? 1)
  const scratchGain = computed(() => state.value?.scratchMonitorGain ?? 0.75)

  function setMonitorGain(value: number): void {
    const sid = sessionId.value
    if (!sid) return
    sendBridge('SCRATCH_SESSION_CONTROL', buildBackingGainPayload(sid, value))
  }

  function setScratchGain(value: number): void {
    const sid = sessionId.value
    if (!sid) return
    sendBridge('SCRATCH_SESSION_CONTROL', buildScratchGainPayload(sid, value))
  }

  function prepare(): void {
    const sid = sessionId.value
    if (!sid || selectedCount.value === 0) return
    sendBridge(
      'SCRATCH_BACKING_PREPARE',
      buildBackingPreparePayload(
        sid,
        [...selectedTrackIds.value],
        startAnchor.value,
        durationSec.value
      )
    )
  }

  function clear(): void {
    const sid = sessionId.value
    if (!sid) return
    sendBridge('SCRATCH_BACKING_CLEAR', buildBackingClearPayload(sid))
  }

  return {
    tracks,
    owningTrackId,
    startAnchor,
    durationSec,
    selectedTrackIds,
    selectedCount,
    status,
    isPreparing,
    isReady,
    hasError,
    errorMessage,
    readyDurationSec,
    canPrepare,
    monitorGain,
    scratchGain,
    isSelected,
    toggleTrack,
    setStartAnchor,
    setDuration,
    setMonitorGain,
    setScratchGain,
    prepare,
    clear
  }
}
