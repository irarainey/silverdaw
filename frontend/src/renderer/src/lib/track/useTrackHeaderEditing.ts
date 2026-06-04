// Inline editing for track headers: click-to-rename the track name and
// click-to-type the gain (dB) value. Both are single-row-at-a-time text
// overlays — Enter / blur commits, Escape cancels, and the input is
// auto-focused with its current value pre-selected. Extracted from
// TrackHeaderPanel.vue so the component stays focused on layout + drag.

import { nextTick, ref, type ComponentPublicInstance, type Ref } from 'vue'
import { useProjectStore, MAX_TRACK_VOLUME } from '@/stores/projectStore'
import { dbToLinear, formatLinearAsDb, parseDbInput } from '@/lib/audio/db'

/** Smallest linear-gain delta worth pushing through the bridge.
 *  Prevents text-input round-trip noise (typing "-3", parsing back to
 *  `0.708`, and emitting a `TRACK_GAIN` for a value that's
 *  indistinguishable from the current one) from spamming the undo
 *  history. ≈0.0001 ≈ 0.0009 dB at unity — finer than perceptible. */
const VOLUME_EPSILON = 1e-4

export interface TrackHeaderEditing {
  editingTrackId: Ref<string | null>
  editingValue: Ref<string>
  editingGainTrackId: Ref<string | null>
  editingGainValue: Ref<string>
  setNameInputEl: (el: Element | ComponentPublicInstance | null) => void
  setGainInputEl: (el: Element | ComponentPublicInstance | null) => void
  startRename: (trackId: string, currentName: string) => Promise<void>
  commitRename: (trackId: string) => void
  cancelRename: () => void
  onRenameKeydown: (e: KeyboardEvent, trackId: string) => void
  volumeDbText: (volume: number) => string
  startGainEdit: (trackId: string, volume: number) => Promise<void>
  commitGainEdit: (trackId: string) => void
  onGainInput: (e: Event) => void
  cancelGainEdit: () => void
  onGainKeydown: (e: KeyboardEvent, trackId: string) => void
}

export function useTrackHeaderEditing(): TrackHeaderEditing {
  const project = useProjectStore()

  const editingTrackId = ref<string | null>(null)
  const editingValue = ref('')
  let nameInputEl: HTMLInputElement | null = null
  const editingGainTrackId = ref<string | null>(null)
  const editingGainValue = ref('')
  let gainInputEl: HTMLInputElement | null = null

  function setNameInputEl(el: Element | ComponentPublicInstance | null): void {
    // Function-style template ref — avoids the Vue-3-inside-v-for array
    // behaviour, since at most one input is rendered at a time anyway.
    // Vue's VNodeRef signature passes either an Element or a
    // ComponentPublicInstance (the latter for components, not raw DOM
    // nodes); for a plain <input> we only ever get an HTMLInputElement.
    nameInputEl = el as HTMLInputElement | null
  }

  function setGainInputEl(el: Element | ComponentPublicInstance | null): void {
    gainInputEl = el as HTMLInputElement | null
  }

  async function startRename(trackId: string, currentName: string): Promise<void> {
    editingTrackId.value = trackId
    editingValue.value = currentName
    await nextTick()
    if (nameInputEl) {
      nameInputEl.focus()
      nameInputEl.select()
    }
  }

  function commitRename(trackId: string): void {
    if (editingTrackId.value !== trackId) return
    project.setTrackName(trackId, editingValue.value)
    editingTrackId.value = null
  }

  function cancelRename(): void {
    editingTrackId.value = null
  }

  function onRenameKeydown(e: KeyboardEvent, trackId: string): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename(trackId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelRename()
    }
  }

  function volumeDbText(volume: number): string {
    return formatLinearAsDb(volume)
  }

  async function startGainEdit(trackId: string, volume: number): Promise<void> {
    editingGainTrackId.value = trackId
    // Pre-fill with the canonical signed dB text. The user can edit
    // freely, e.g. `-3`, `+1.5`, `-inf`.
    editingGainValue.value = formatLinearAsDb(volume)
    await nextTick()
    if (gainInputEl) {
      gainInputEl.focus()
      gainInputEl.select()
    }
  }

  function commitGainEdit(trackId: string): void {
    if (editingGainTrackId.value !== trackId) return
    const parsedDb = parseDbInput(editingGainValue.value)
    if (parsedDb !== null) {
      const linear = parsedDb === -Infinity ? 0 : dbToLinear(parsedDb)
      const clamped = Math.min(MAX_TRACK_VOLUME, Math.max(0, linear))
      const current = project.tracks.find((t) => t.id === trackId)?.volume ?? 0
      if (Math.abs(clamped - current) > VOLUME_EPSILON) {
        project.setTrackVolume(trackId, clamped)
      }
    }
    editingGainTrackId.value = null
  }

  function onGainInput(e: Event): void {
    // The text input is freeform; just mirror the raw value into the
    // ref so the user sees what they typed. Validation / clamping
    // happens on commit, not on every keystroke.
    const input = e.target as HTMLInputElement
    editingGainValue.value = input.value
  }

  function cancelGainEdit(): void {
    editingGainTrackId.value = null
  }

  function onGainKeydown(e: KeyboardEvent, trackId: string): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitGainEdit(trackId)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelGainEdit()
    }
  }

  return {
    editingTrackId,
    editingValue,
    editingGainTrackId,
    editingGainValue,
    setNameInputEl,
    setGainInputEl,
    startRename,
    commitRename,
    cancelRename,
    onRenameKeydown,
    volumeDbText,
    startGainEdit,
    commitGainEdit,
    onGainInput,
    cancelGainEdit,
    onGainKeydown
  }
}
