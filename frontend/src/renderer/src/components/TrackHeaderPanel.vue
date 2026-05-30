<script setup lang="ts">
// Vertical column of track headers sitting on top of the timeline canvas.
//
// Each header shows the track name + id, plus its primary controls:
//
//   M  — mute       (yellow when active, sends TRACK_GAIN=0)
//   S  — solo       (cyan when active, mutes every non-soloed track)
//   ↓  — import     (opens an audio file and adds it as a clip on the track)
//   X  — remove     (sends TRACK_REMOVE and drops the track locally)
//
// Layout is absolute-positioned so it stays in sync with the PixiJS-drawn
// row backgrounds. RULER_HEIGHT / TRACK_HEIGHT / TRACK_GAP must match the
// values in TimelineView.vue. The column WIDTH is user-resizable and lives
// on `uiStore.trackHeaderWidth`; the drag handle is in TimelineView (it
// straddles the seam between this column and the canvas).

import { computed, nextTick, ref, type ComponentPublicInstance } from 'vue'
import { useProjectStore, MAX_TRACK_VOLUME } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { importAudioIntoTrack } from '@/lib/importAudio'
import {
  dbToLinear,
  formatLinearAsDb,
  linearToTaperPosition,
  MAX_TRACK_DB,
  parseDbInput,
  taperPositionToLinear
} from '@/lib/audio/db'
import {
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  RULER_HEIGHT
} from '@/lib/timeline/constants'
import { buildTrackRowLayout, trackHeightOf } from '@/lib/timeline/trackLayout'
import TrackMeter from '@/components/TrackMeter.vue'

withDefaults(defineProps<{ scrollY?: number }>(), { scrollY: 0 })

const project = useProjectStore()
const ui = useUiStore()

const headerWidth = computed(() => ui.trackHeaderWidth)

/**
 * Map a linear gain (0 .. MAX_TRACK_VOLUME) onto the slider's 0..1
 * visual domain using a real-DAW tapered curve: 0 dB sits near the
 * top of fader travel (≈91% for the +6 dB ceiling) so the bulk of
 * the bar covers the audible attenuation range. See `lib/audio/db`
 * for the maths.
 */
function volumeToSliderPosition(volume: number): number {
  return linearToTaperPosition(volume, MAX_TRACK_DB)
}

/** Inverse of `volumeToSliderPosition`. */
function sliderPositionToVolume(position: number): number {
  return taperPositionToLinear(position, MAX_TRACK_DB)
}

function onImportClick(trackId: string): void {
  // Fire-and-forget; failures are logged inside the helper.
  void importAudioIntoTrack(trackId)
}

// ─── Inline rename ────────────────────────────────────────────────────────
// Clicking the track name swaps it for a text input. Enter / blur commits;
// Escape cancels. The input is auto-focused and pre-selects the current
// name so the user can either retype from scratch or tweak a few chars.
// Only one row can be in edit mode at a time, so a single ref is enough.

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

/** Smallest linear-gain delta worth pushing through the bridge.
 *  Prevents text-input round-trip noise (typing "-3", parsing back to
 *  `0.708`, and emitting a `TRACK_GAIN` for a value that's
 *  indistinguishable from the current one) from spamming the undo
 *  history. ≈0.0001 ≈ 0.0009 dB at unity — finer than perceptible. */
const VOLUME_EPSILON = 1e-4

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

// Layout constants (RULER_HEIGHT / MIN/MAX_TRACK_HEIGHT / TRACK_GAP) are
// imported above from `@/lib/timeline/constants` so the column stays
// aligned with the PixiJS-drawn rows regardless of any future tweaks.

// Cached per-track {top, height} so the v-for can do a single lookup per
// row rather than each row re-computing its prefix-sum. `buildTrackRowLayout`
// is pure and cheap, so a `computed` is the natural fit.
const rowLayout = computed(() => buildTrackRowLayout(project.tracks))

// ─── Resize-handle drag ───────────────────────────────────────────────────
// Each track header carries a 5 px tall handle on its bottom edge. While
// the user drags it we mutate the local `heightPx` every pointermove
// (cheap; just a Pinia write + Pixi redraw via the project.tracks watcher
// in TimelineView). On pointerup we commit the final value via
// `setTrackHeight` so the backend captures one undo step per drag rather
// than dozens of intermediate values.
const HANDLE_PX = 5

interface ResizeDragState {
  trackId: string
  startY: number
  startHeightPx: number
  moved: boolean
}
let resizeDrag: ResizeDragState | null = null

function onHandlePointerDown(track: { id: string }, ev: PointerEvent): void {
  if (ev.button !== 0) return
  const current = project.tracks.find((t) => t.id === track.id)
  if (!current) return
  ev.preventDefault()
  ev.stopPropagation()
  resizeDrag = {
    trackId: track.id,
    startY: ev.clientY,
    startHeightPx: trackHeightOf(current),
    moved: false
  }
  ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
  window.addEventListener('pointermove', onHandlePointerMove)
  window.addEventListener('pointerup', onHandlePointerUp)
  window.addEventListener('pointercancel', onHandlePointerUp)
}

function onHandlePointerMove(ev: PointerEvent): void {
  if (!resizeDrag) return
  const dy = ev.clientY - resizeDrag.startY
  if (!resizeDrag.moved && Math.abs(dy) < 1) return
  resizeDrag.moved = true
  const next = Math.max(
    MIN_TRACK_HEIGHT,
    Math.min(MAX_TRACK_HEIGHT, Math.round(resizeDrag.startHeightPx + dy))
  )
  project.setTrackHeightLocal(resizeDrag.trackId, next)
}

function onHandlePointerUp(): void {
  window.removeEventListener('pointermove', onHandlePointerMove)
  window.removeEventListener('pointerup', onHandlePointerUp)
  window.removeEventListener('pointercancel', onHandlePointerUp)
  const drag = resizeDrag
  resizeDrag = null
  if (!drag || !drag.moved) return
  const t = project.tracks.find((x) => x.id === drag.trackId)
  if (!t) return
  // Commit once on release — captures a single undo step covering the
  // whole drag, not one per pixel of motion.
  project.setTrackHeight(drag.trackId, trackHeightOf(t))
}

// ─── Reorder drag ─────────────────────────────────────────────────────────
// The grip icon at the top-left of each header carries a pointerdown
// handler that promotes to a drag once the pointer has moved past a
// small threshold. Below the threshold we treat the gesture as a stray
// click and abort, so a misclick on the grip doesn't accidentally
// trigger a reorder commit. During the drag we track the pointer's y
// against the row layout to compute the target slot index; the
// `dropIndicator` ref drives a thin green line rendered between rows so
// the user sees exactly where the dropped track will land.
const REORDER_THRESHOLD_PX = 4

interface ReorderDragState {
  trackId: string
  startY: number
  startIndex: number
  moved: boolean
}
let reorderDrag: ReorderDragState | null = null
const dropIndicatorIndex = ref<number | null>(null)
const reorderingTrackId = ref<string | null>(null)

function computeDropIndex(clientY: number, rowsHostRect: DOMRect): number {
  // Convert the pointer into the rows-host content space (the same
  // coordinate space the rowLayout entries use, modulo the
  // RULER_HEIGHT subtraction the template applies for `top`).
  const localY = clientY - rowsHostRect.top + RULER_HEIGHT
  const layout = rowLayout.value
  for (let i = 0; i < layout.length; i++) {
    const row = layout[i]!
    const mid = row.top + row.height / 2
    if (localY < mid) return i
  }
  return layout.length
}

function onHeaderClick(track: { id: string }, ev: MouseEvent): void {
  // GarageBand-style: clicking a track header selects it (the Track FX
  // surface edits the selected track). Gate out clicks that land on the
  // header's interactive controls (buttons, the name input, the volume
  // slider, the grip / resize handles) so selection never steals a click
  // meant for those.
  const target = ev.target as HTMLElement | null
  if (
    target?.closest(
      'button, input, a, [role="slider"], .track-grip, .track-resize-handle, .track-volume-slider'
    )
  ) {
    return
  }
  project.selectTrack(track.id)
}

function onGripPointerDown(track: { id: string }, ev: PointerEvent): void {
  if (ev.button !== 0) return
  ev.preventDefault()
  ev.stopPropagation()
  const startIndex = project.tracks.findIndex((t) => t.id === track.id)
  if (startIndex < 0) return
  reorderDrag = {
    trackId: track.id,
    startY: ev.clientY,
    startIndex,
    moved: false
  }
  ;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
  window.addEventListener('pointermove', onGripPointerMove)
  window.addEventListener('pointerup', onGripPointerUp)
  window.addEventListener('pointercancel', onGripPointerUp)
}

function onGripPointerMove(ev: PointerEvent): void {
  if (!reorderDrag) return
  const dy = ev.clientY - reorderDrag.startY
  if (!reorderDrag.moved && Math.abs(dy) < REORDER_THRESHOLD_PX) return
  reorderDrag.moved = true
  reorderingTrackId.value = reorderDrag.trackId
  // Find the rows host so we can compute drop index relative to it.
  const host = rowsHostEl.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  let target = computeDropIndex(ev.clientY, rect)
  // Translate "slot index in current array" to "would-be index after
  // removing the dragged track". If the user drags within the same
  // visual region as the original slot we don't want to flicker the
  // drop indicator between two equivalent positions.
  if (target > reorderDrag.startIndex) target -= 1
  dropIndicatorIndex.value = target === reorderDrag.startIndex ? null : target
}

function onGripPointerUp(): void {
  window.removeEventListener('pointermove', onGripPointerMove)
  window.removeEventListener('pointerup', onGripPointerUp)
  window.removeEventListener('pointercancel', onGripPointerUp)
  const drag = reorderDrag
  reorderDrag = null
  reorderingTrackId.value = null
  const indicator = dropIndicatorIndex.value
  dropIndicatorIndex.value = null
  if (!drag || !drag.moved || indicator === null) return
  project.reorderTrack(drag.trackId, indicator)
}

const rowsHostEl = ref<HTMLDivElement | null>(null)

// Top position of the drop-indicator line, in the rows-host content
// space (i.e. matching the per-track `top` style). When the drop slot
// is at index `i`, the line sits at the top edge of row `i` minus half
// the inter-row gap; at the end of the list it sits below the last
// row.
const dropIndicatorTopPx = computed<number>(() => {
  const idx = dropIndicatorIndex.value
  const layout = rowLayout.value
  if (idx === null) return 0
  if (idx >= layout.length) {
    const last = layout[layout.length - 1]
    if (!last) return 0
    return last.top + last.height - RULER_HEIGHT
  }
  const row = layout[idx]
  if (!row) return 0
  return row.top - RULER_HEIGHT - 1
})
</script>

<template>
  <!--
      `inset-y-0` makes the container span the full timeline height so the
      track-row contents stay aligned with the PixiJS-drawn rows. The vertical
      divider line that visually separates the column from the waveform area
      is drawn by PixiJS (see `drawHeaderDivider` in TimelineView.vue) so the
      playhead can render *above* it \u2014 an HTML `border-r` here would always
      sit on top of the canvas and cover the playhead at t=0.
    -->
  <div
    class="pointer-events-none absolute inset-y-0 left-0 select-none"
    :style="{ width: headerWidth + 'px' }"
  >
    <!--
          Add-track button sits in the strip above the first track, aligned
          with the ruler row. Clicking it appends a new empty track via the
          project store (matching the File ▸ Add Track menu action).
        -->
    <button
      type="button"
      data-borderless-button="true"
      class="pointer-events-auto absolute left-0 right-0 top-0 flex items-center justify-center gap-1.5 bg-zinc-900 text-[11px] font-medium uppercase tracking-wide text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
      :style="{ height: RULER_HEIGHT + 'px' }"
      title="Add a new track"
      @click="project.addTrack()"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        class="h-3.5 w-3.5"
      >
        <path d="M12 5v14M5 12h14" />
      </svg>
      Add Track
    </button>

    <!--
          Rows container clipped to the area below the ruler so that vertical
          scrolling of tracks doesn't reveal row headers on top of the ruler.
          The inner div applies the actual translation, matching the PixiJS
          tracks-layer scroll offset.
        -->
    <div
      ref="rowsHostEl"
      class="absolute left-0 right-0 overflow-hidden"
      :style="{ top: RULER_HEIGHT + 'px', bottom: '0px' }"
    >
      <div :style="{ transform: 'translateY(' + (-scrollY) + 'px)' }">
        <div
          v-for="(track, i) in project.tracks"
          :key="track.id"
          class="pointer-events-auto absolute flex flex-col justify-between rounded border border-zinc-700 px-2 py-1.5 text-xs"
          :class="{
            'opacity-50': track.muted || (project.anySoloed && !track.soloed),
            'ring-1 ring-inset ring-cyan-500/60': track.soloed,
            'opacity-30': reorderingTrackId === track.id,
            '!border-sky-400 bg-zinc-800/40': project.selectedTrackId === track.id
          }"
          :style="{
            top: ((rowLayout[i]?.top ?? 0) - RULER_HEIGHT) + 'px',
            height: (rowLayout[i]?.height ?? 0) + 'px',
            width: headerWidth + 'px'
          }"
          @click="onHeaderClick(track, $event)"
        >
          <!-- Top row: grip + name. The grip is the dedicated drag
                         handle for reordering tracks — dragging it
                         vertically promotes to a reorder gesture with
                         a drop indicator across the header column. -->
          <div class="flex items-start gap-1">
            <div
              class="track-grip flex h-4 w-3 shrink-0 cursor-grab items-center justify-center text-zinc-500 hover:text-zinc-200 active:cursor-grabbing"
              title="Drag to reorder"
              @pointerdown="onGripPointerDown(track, $event)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 8 12"
                fill="currentColor"
                aria-hidden="true"
                class="h-3 w-2"
              >
                <circle
                  cx="2"
                  cy="2"
                  r="1"
                />
                <circle
                  cx="6"
                  cy="2"
                  r="1"
                />
                <circle
                  cx="2"
                  cy="6"
                  r="1"
                />
                <circle
                  cx="6"
                  cy="6"
                  r="1"
                />
                <circle
                  cx="2"
                  cy="10"
                  r="1"
                />
                <circle
                  cx="6"
                  cy="10"
                  r="1"
                />
              </svg>
            </div>
            <div class="min-w-0 flex-1">
              <input
                v-if="editingTrackId === track.id"
                :ref="setNameInputEl"
                v-model="editingValue"
                type="text"
                spellcheck="false"
                class="w-full rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-xs font-medium text-zinc-100 outline-none focus:border-cyan-500"
                @blur="commitRename(track.id)"
                @keydown="(e) => onRenameKeydown(e, track.id)"
              >
              <div
                v-else
                class="truncate font-medium text-zinc-100"
                :title="track.name + ' \u2014 click to rename'"
                @click="startRename(track.id, track.name)"
              >
                {{ track.name }}
              </div>
            </div>
          </div>

          <!-- Middle: volume slider stacked with a thin stereo peak
                         meter so the visual association between fader
                         and the resulting level is immediate. Meter
                         sources from `trackLevelsChannel` keyed by
                         track id (Phase 5 step 1c — see TrackMeter.vue). -->
          <div class="flex items-center gap-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="h-3.5 w-3.5 shrink-0 text-zinc-500"
              aria-hidden="true"
            >
              <path d="M11 5L6 9H2v6h4l5 4V5z" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <input
                type="range"
                min="0"
                max="1"
                step="0.001"
                :value="volumeToSliderPosition(track.volume)"
                :title="'Volume ' + formatLinearAsDb(track.volume, { unit: true })"
                class="track-volume h-1 w-full cursor-pointer appearance-none rounded-full bg-zinc-700"
                @input="(e) => project.setTrackVolumeLocal(track.id, sliderPositionToVolume(Number((e.target as HTMLInputElement).value)))"
                @change="(e) => project.setTrackVolume(track.id, sliderPositionToVolume(Number((e.target as HTMLInputElement).value)))"
              >
              <TrackMeter
                :track-id="track.id"
                :width="120"
                :height="6"
              />
            </div>
            <input
              v-if="editingGainTrackId === track.id"
              :ref="setGainInputEl"
              v-model="editingGainValue"
              type="text"
              inputmode="text"
              spellcheck="false"
              autocomplete="off"
              class="w-10 shrink-0 rounded border border-zinc-600 bg-zinc-950 px-0.5 py-px text-right font-mono text-[10px] tabular-nums text-zinc-100 outline-none focus:border-cyan-500"
              @input="onGainInput"
              @blur="commitGainEdit(track.id)"
              @keydown="(e) => onGainKeydown(e, track.id)"
            >
            <button
              v-else
              type="button"
              data-borderless-button="true"
              class="w-10 shrink-0 cursor-text appearance-none border-0 bg-transparent p-0 text-right font-mono text-[10px] tabular-nums text-zinc-500 outline-none hover:text-zinc-200 focus-visible:text-cyan-300"
              :title="`Volume ${formatLinearAsDb(track.volume, { unit: true })} — double-click to type a dB value (e.g. -3, +1.5, -inf)`"
              @dblclick.stop="startGainEdit(track.id, track.volume)"
            >
              {{ volumeDbText(track.volume) }}
            </button>
          </div>

          <!-- Bottom row: close / import / mute / solo. -->
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white"
              title="Remove track"
              @click="project.removeTrack(track.id)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
                stroke-linecap="round"
                class="h-3.5 w-3.5"
              >
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>

            <!-- Import: opens an audio file and adds it as a clip
                             on this track. Disabled once a clip already
                             exists — multi-clip editing comes later. -->
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
              :title="track.clipIds.length > 0 ? 'Track already has a clip' : 'Import audio file...'"
              :disabled="track.clipIds.length > 0"
              @click="onImportClick(track.id)"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="h-3.5 w-3.5"
              >
                <path d="M9 18V5l12-2v13" />
                <circle
                  cx="6"
                  cy="18"
                  r="3"
                />
                <circle
                  cx="18"
                  cy="16"
                  r="3"
                />
              </svg>
            </button>

            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
              :class="(track.muted || (project.anySoloed && !track.soloed))
                ? 'border-amber-400 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="project.anySoloed && !track.soloed ? 'Muted by solo on another track' : (track.muted ? 'Unmute' : 'Mute')"
              :disabled="project.anySoloed && !track.soloed"
              @click="project.toggleMute(track.id)"
            >
              M
            </button>
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors disabled:cursor-not-allowed"
              :class="track.soloed
                ? 'border-cyan-400 bg-cyan-500 text-zinc-950 hover:bg-cyan-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="project.anySoloed && !track.soloed ? 'Another track is soloed' : (track.soloed ? 'Un-solo' : 'Solo')"
              :disabled="project.anySoloed && !track.soloed"
              @click="project.toggleSolo(track.id)"
            >
              S
            </button>
          </div>
        </div>

        <!-- Resize handles. Sit on each track's bottom edge, straddling
             the inter-track gap so the user has a comfortable hit zone
             without intruding on the track contents. Pointer-events
             only fire on the handle itself; the cursor is `ns-resize`
             so the affordance is unambiguous. -->
        <div
          v-for="(track, i) in project.tracks"
          :key="'rh-' + track.id"
          class="track-resize-handle pointer-events-auto absolute left-0"
          :style="{
            top: (((rowLayout[i]?.top ?? 0) + (rowLayout[i]?.height ?? 0)) - RULER_HEIGHT - Math.floor(HANDLE_PX / 2)) + 'px',
            height: HANDLE_PX + 'px',
            width: headerWidth + 'px'
          }"
          :title="'Drag to resize track \u2014 ' + Math.round(rowLayout[i]?.height ?? 0) + 'px'"
          @pointerdown="onHandlePointerDown(track, $event)"
        />

        <!-- Drop indicator. A thin emerald line across the column at
             the inter-track seam corresponding to the current drop
             slot. Mounted only while a reorder drag is active and a
             non-noop target has been computed. -->
        <div
          v-if="dropIndicatorIndex !== null"
          class="track-drop-indicator pointer-events-none absolute left-0"
          :style="{
            top: dropIndicatorTopPx + 'px',
            width: headerWidth + 'px'
          }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Compact range slider styled to match the dark zinc chrome. The default
   browser thumb is too tall for our 1px track, so we shrink it and
   colour it to match the track palette. */
.track-volume {
  outline: none;
}

.track-volume::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  /* zinc-200 */
  border: 1px solid #71717a;
  /* zinc-500 */
  cursor: pointer;
  margin-top: -5px;
}

.track-volume::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.track-volume::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
  /* zinc-700 */
}

.track-volume::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}

/* Bottom-edge drag affordance for resizing a track row. Default state is
   invisible (so it doesn't draw a line on every row); hovering or
   dragging surfaces a subtle accent so the user sees what they're
   about to grab without ever wondering if the whole row is a button. */
.track-resize-handle {
  cursor: ns-resize;
  background: transparent;
  z-index: 5;
}
.track-resize-handle:hover {
  background: rgba(113, 113, 122, 0.45); /* zinc-500 @ 45% */
}
.track-resize-handle:active {
  background: rgba(244, 244, 245, 0.6); /* zinc-100 while dragging */
}

/* Drop indicator line for the reorder drag. Sits over the inter-track
   gap pointing to the slot the dropped track would land in. 2 px tall
   so it reads as a positive affordance without obscuring the row
   below. */
.track-drop-indicator {
  height: 2px;
  background: #10b981; /* emerald-500 */
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.35);
  z-index: 10;
}
</style>
