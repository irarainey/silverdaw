<script setup lang="ts">
// Track-header overlay aligned to the PixiJS timeline rows.

import { computed, ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { importAudioIntoTrack } from '@/lib/importAudio'
import {
  formatLinearAsDb,
  linearToTaperPosition,
  MAX_TRACK_DB,
  taperPositionToLinear
} from '@/lib/audio/db'
import {
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  RULER_HEIGHT
} from '@/lib/timeline/constants'
import { buildTrackRowLayout, trackHeightOf } from '@/lib/timeline/trackLayout'
import { useTrackHeaderEditing } from '@/lib/track/useTrackHeaderEditing'
import TrackMeter from '@/components/TrackMeter.vue'

withDefaults(defineProps<{ scrollY?: number }>(), { scrollY: 0 })

const project = useProjectStore()
const ui = useUiStore()

const headerWidth = computed(() => ui.trackHeaderWidth)

/** Tapered fader mapping keeps most travel in the audible attenuation range. */
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

// ─── Inline rename + gain editing ───────────────────────────────────────────
const {
  editingTrackId,
  editingValue,
  editingGainTrackId,
  editingGainValue,
  setNameInputEl,
  setGainInputEl,
  startRename,
  commitRename,
  onRenameKeydown,
  volumeDbText,
  startGainEdit,
  commitGainEdit,
  onGainInput,
  onGainKeydown
} = useTrackHeaderEditing()

// Cache per-track row layout for template lookups.
const rowLayout = computed(() => buildTrackRowLayout(project.tracks))

// ─── Resize-handle drag ───────────────────────────────────────────────────
// Pointermove previews locally; pointerup commits one undoable backend change.
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
  // Commit once per drag.
  project.setTrackHeight(drag.trackId, trackHeightOf(t))
}

// ─── Reorder drag ─────────────────────────────────────────────────────────
// A movement threshold prevents accidental reorder commits from grip misclicks.
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
  // Convert pointer y into row-layout content space.
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
  // Ignore clicks on controls so selection never steals their gesture.
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

/** Toggle this track's FX panel, retargeting or collapsing as needed. */
function onToggleFx(track: { id: string }): void {
  if (isTrackFxShowing(track.id)) {
    project.setFxPanelOpen(false)
    return
  }
  project.selectTrack(track.id)
  project.setFxTab('track')
  project.setFxPanelOpen(true)
  ui.setLibraryPanelCollapsed(false)
}

/** True only when this track's FX rack is visibly open. */
function isTrackFxShowing(trackId: string): boolean {
  return (
    project.fxPanelOpen &&
    project.fxTab === 'track' &&
    project.selectedTrackId === trackId &&
    !ui.libraryPanelCollapsed
  )
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
  const host = rowsHostEl.value
  if (!host) return
  const rect = host.getBoundingClientRect()
  let target = computeDropIndex(ev.clientY, rect)
  // Convert visual slot to post-removal target; hide no-op indicators.
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

// Drop-indicator top in rows-host content space.
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
    <!-- Add-track strip aligned with the ruler row. -->
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

    <!-- Clip rows below the ruler; inner div mirrors Pixi scroll offset. -->
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
            'border-sky-400! bg-zinc-800/40': project.selectedTrackId === track.id
          }"
          :style="{
            top: ((rowLayout[i]?.top ?? 0) - RULER_HEIGHT) + 'px',
            height: (rowLayout[i]?.height ?? 0) + 'px',
            width: headerWidth + 'px'
          }"
          @click="onHeaderClick(track, $event)"
        >
          <!-- Top row: reorder grip + name. -->
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

          <!-- Middle: volume slider + matching track meter. -->
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

            <!-- Import is disabled once the track already has a clip. -->
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
              :title="project.anySoloed && !track.soloed ? 'Another track is soloed' : (track.soloed ? 'Unsolo' : 'Solo')"
              :disabled="project.anySoloed && !track.soloed"
              @click="project.toggleSolo(track.id)"
            >
              S
            </button>
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors"
              :class="isTrackFxShowing(track.id)
                ? 'border-sky-400 bg-sky-500 text-zinc-950 hover:bg-sky-400'
                : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="isTrackFxShowing(track.id) ? 'Hide track effects' : 'Show track effects'"
              :aria-pressed="isTrackFxShowing(track.id)"
              @click="onToggleFx(track)"
            >
              Fx
            </button>
          </div>
        </div>

        <!-- Resize handles straddle row gaps for a larger hit zone. -->
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

        <!-- Drop indicator for the current reorder slot. -->
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
/* Compact range slider fitted to the dark zinc chrome. */
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
  border: 1px solid #71717a;
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
}

.track-volume::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}

/* Invisible until hover/drag so row chrome stays clean. */
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

/* Drop indicator for the current reorder slot. */
.track-drop-indicator {
  height: 2px;
  background: #10b981; /* emerald-500 */
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.35);
  z-index: 10;
}
</style>
