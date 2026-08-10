// Owns the transport bar's BPM box: the text the user sees, and *when* a tempo
// edit is actually applied.
//
// Applying a tempo is expensive and global — `projectStore.applyProjectBpm`
// retimes every clip, marker, envelope and automation lane, moves the playhead
// and the timeline selection, repaints the timeline and sends PROJECT_SET_BPM.
// Held arrows, the spinner buttons and the scroll wheel all emit a stream of
// single-step bumps, so applying each one made the arrangement visibly crawl to
// its new tempo and lag behind a large change. Bumps therefore accumulate into a
// pending target and are applied once the user settles, giving one retime across
// one old→new ratio. Blur/Enter commits immediately, so a typed tempo still feels
// instant.

import { getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useTransportStore } from '@/stores/transportStore'
import { clampBpm } from '@/lib/musicTime'

/** Quiet period after the last bump before the tempo is applied. */
const BPM_SETTLE_MS = 250

/** The BPM box's text as a number, or null when it is blank or not a number.
 *  `v-model` on a `type="number"` input hands back a number, not a string. */
function parseBpmInput(value: string | number): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function useProjectBpmEditor() {
  const project = useProjectStore()
  const transport = useTransportStore()

  const bpmInput = ref<string | number>(transport.bpm.toFixed(2))
  const isEditingBpm = ref(false)
  /** Target the user is bumping towards, or null when there is no pending edit. */
  const pendingBpm = ref<number | null>(null)
  let settleTimer: ReturnType<typeof setTimeout> | null = null

  function cancelPending(): void {
    if (settleTimer !== null) {
      clearTimeout(settleTimer)
      settleTimer = null
    }
    pendingBpm.value = null
  }

  function applyPending(): void {
    const next = pendingBpm.value
    cancelPending()
    if (next !== null && next !== transport.bpm) project.applyProjectBpm(next)
    bpmInput.value = transport.bpm.toFixed(2)
  }

  function schedulePending(bpm: number): void {
    pendingBpm.value = bpm
    bpmInput.value = bpm.toFixed(2)
    if (settleTimer !== null) clearTimeout(settleTimer)
    settleTimer = setTimeout(applyPending, BPM_SETTLE_MS)
  }

  // A tempo arriving from anywhere else (seeding from the first clip, a project
  // load, the properties dialog) wins: an in-flight bump was measured against a
  // base that no longer exists.
  watch(
    () => transport.bpm,
    (bpm) => {
      cancelPending()
      if (!isEditingBpm.value) bpmInput.value = bpm.toFixed(2)
    }
  )

  /** Bump BPM towards a pending target; applied once the user settles. */
  function bumpBpm(delta: number): void {
    const typed = isEditingBpm.value ? parseBpmInput(bpmInput.value) : null
    const base = pendingBpm.value ?? typed ?? transport.bpm
    schedulePending(clampBpm(base + delta))
  }

  function onBpmCommit(): void {
    isEditingBpm.value = false
    const typed = parseBpmInput(bpmInput.value)
    if (typed === null) {
      cancelPending()
      bpmInput.value = transport.bpm.toFixed(2)
      return
    }
    pendingBpm.value = clampBpm(typed)
    applyPending()
  }

  function onBpmKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
    else if (e.key === 'Escape') {
      cancelPending()
      bpmInput.value = transport.bpm.toFixed(2)
        ; (e.target as HTMLInputElement).blur()
    }
    else if (e.key === 'ArrowUp') {
      e.preventDefault()
      bumpBpm(e.altKey ? 0.01 : 1)
    }
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      bumpBpm(e.altKey ? -0.01 : -1)
    }
  }

  // Never lose a bump the user has already made to a timer that outlives the bar.
  if (getCurrentScope()) onScopeDispose(applyPending)

  return { bpmInput, isEditingBpm, bumpBpm, onBpmCommit, onBpmKeydown }
}
