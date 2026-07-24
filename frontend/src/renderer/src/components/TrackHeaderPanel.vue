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
import { RULER_HEIGHT, AUTOMATION_LANE_HEIGHT, MIN_TRACK_HEIGHT, MAX_TRACK_HEIGHT } from '@/lib/timeline/constants'
import { buildTrackRowLayout, trackHeightOf } from '@/lib/timeline/trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import { automationLaneOffset } from '@/lib/automation/automationLanes'
import {
  AUTOMATABLE_PARAM_IDS,
  AUTOMATION_PARAMS,
  translateAutomationCurve
} from '@/lib/automation/automationParams'
import { sampleBreakpoints } from '@/lib/automation/breakpoints'
import { trackStaticAutomationValue } from '@/stores/projectTrackActions'
import { TRACK_PALETTE, type Track } from '@/stores/projectTypes'
import { useTransportStore } from '@/stores/transportStore'
import type { AutomationParamId } from '@shared/bridge-protocol'
import { useTrackHeaderEditing } from '@/lib/track/useTrackHeaderEditing'
import { useTrackPan } from '@/lib/track/useTrackPan'
import { useTrackResizeDrag } from '@/lib/track/useTrackResizeDrag'
import { useTrackReorderDrag } from '@/lib/track/useTrackReorderDrag'
import TrackMeter from '@/components/TrackMeter.vue'

withDefaults(defineProps<{ scrollY?: number; onWheel?: (e: WheelEvent) => void }>(), {
  scrollY: 0,
  onWheel: undefined
})

const project = useProjectStore()
const ui = useUiStore()

const headerWidth = computed(() => ui.trackHeaderWidth)

// Mirror the timeline row's selection outline on the header so the border is
// continuous across both: the selected track's own palette colour at 2px,
// matching the PixiJS stroke (`palette.border`, width 2). `drop` suppresses the
// edge that seams into an open automation lane so the outline stays unbroken.
function selectionBorderStyle(
  track: Track,
  drop?: 'top' | 'bottom'
): Record<string, string> | undefined {
  if (project.selectedTrackId !== track.id) return undefined
  const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
  const style: Record<string, string> = { borderColor: palette.cssHex, borderWidth: '2px' }
  if (drop === 'bottom' && hasVisibleAutomationLanes(track.id)) style.borderBottomWidth = '0px'
  if (drop === 'top') style.borderTopWidth = '0px'
  return style
}

function laneSelectionBorderStyle(
  track: Track,
  laneIndex: number
): Record<string, string> | undefined {
  if (project.selectedTrackId !== track.id) return undefined
  const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
  const laneCount = visibleAutomationLanes(track.id).length
  const style: Record<string, string> = { borderColor: palette.cssHex, borderWidth: '2px' }
  if (laneIndex < laneCount - 1) style.borderBottomWidth = '0px'
  return style
}

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

// ─── Pan slider (under the gain fader) ──────────────────────────────────────
const { panDisplay, onPanInput, onPanChange, onPanReset } = useTrackPan()

/** Pan value to show on the header slider/readout: the automation curve at the
 *  playhead when pan is automated (so it follows playback), else the static pan. */
function panValue(track: { pan?: number; automation?: { pan?: { timeMs: number; value: number }[] } }): number {
  const pts = track.automation?.pan
  if (Array.isArray(pts) && pts.length >= 2) return sampleBreakpoints(pts, transport.positionMs)
  return track.pan ?? 0
}

// Cache per-track row layout for template lookups.
const rowLayout = computed(() => buildTrackRowLayout(project.tracks, makeLaneHeightOf()))
const transport = useTransportStore()

/** Min / current (at playhead) / max readout labels for a track's lane. */
function laneScale(
  trackId: string,
  param: AutomationParamId
): { min: string; cur: string; max: string; curVal: number } {
  const d = AUTOMATION_PARAMS[param]
  const track = project.tracks.find((t) => t.id === trackId)
  const pts = track?.automation?.[param]
  const v = pts && pts.length >= 2
    ? sampleBreakpoints(pts, transport.positionMs)
    : track ? trackStaticAutomationValue(track, param) : d.defaultValue
  return { min: d.format(d.min), cur: d.format(v), max: d.format(d.max), curVal: v }
}

/** Nudge the whole curve up (+1) or down (-1) by 5% of the param range,
 *  snapping to the default value when a step would otherwise skip over it. */
function nudgeLane(trackId: string, param: AutomationParamId, dir: 1 | -1): void {
  const d = AUTOMATION_PARAMS[param]
  const step = (d.max - d.min) * 0.05 * dir
  const cur = laneScale(trackId, param).curVal
  let delta = step
  if ((cur - d.defaultValue) * (cur + step - d.defaultValue) < 0) delta = d.defaultValue - cur
  project.shiftTrackAutomation(trackId, param, delta)
}

/** Hint for the editable value box, naming the sign convention per param. */
function editHint(param: AutomationParamId): string {
  if (param === 'filter') return 'Negative = LPF, positive = HPF, 0 = off (−1…1)'
  const d = AUTOMATION_PARAMS[param]
  return `${d.format(d.min)} … ${d.format(d.max)}`
}

/** Double-click the readout to type the value at the current playhead. */
const editingLane = ref<{ trackId: string; paramId: AutomationParamId } | null>(null)
const editValue = ref('')
function startEditValue(trackId: string, paramId: AutomationParamId): void {
  editingLane.value = { trackId, paramId }
  editValue.value = String(Number(laneScale(trackId, paramId).curVal.toFixed(2)))
}
function commitEditValue(trackId: string, param: AutomationParamId): void {
  const num = Number(editValue.value)
  if (editValue.value.trim() !== '' && Number.isFinite(num)) {
    const d = AUTOMATION_PARAMS[param]
    const clamped = Math.min(d.max, Math.max(d.min, num))
    project.setAutomationValueAt(trackId, param, transport.positionMs, clamped)
  }
  editingLane.value = null
}

function hasAutomation(trackId: string): boolean {
  const map = project.tracks.find((t) => t.id === trackId)?.automation
  if (!map) return false
  return Object.values(map).some((pts) => Array.isArray(pts) && pts.length >= 2)
}

/** True when a specific param already has a drawn curve on this track. */
function paramAutomated(trackId: string, pid: AutomationParamId): boolean {
  const pts = project.tracks.find((t) => t.id === trackId)?.automation?.[pid]
  return Array.isArray(pts) && pts.length >= 2
}

function visibleAutomationLanes(trackId: string) {
  return ui.automationLanes[trackId] ?? []
}

function hasVisibleAutomationLanes(trackId: string): boolean {
  return visibleAutomationLanes(trackId).length > 0
}

function isVisibleAutomationLane(trackId: string, paramId: AutomationParamId): boolean {
  return visibleAutomationLanes(trackId).some((lane) => lane.paramId === paramId)
}

function laneOffset(trackId: string, laneIndex: number): number {
  return automationLaneOffset(visibleAutomationLanes(trackId), laneIndex)
}

function canAddAutomationLane(trackId: string): boolean {
  return visibleAutomationLanes(trackId).length < AUTOMATABLE_PARAM_IDS.length
}

function addAutomationLane(trackId: string): void {
  const visible = new Set(visibleAutomationLanes(trackId).map((lane) => lane.paramId))
  const paramId = AUTOMATABLE_PARAM_IDS.find((id) => !visible.has(id))
  if (paramId) ui.addTrackAutomationLane(trackId, paramId)
}

/** Open a param's automation lane from a static control (Option A link). */
function automateParam(trackId: string, pid: AutomationParamId): void {
  project.selectTrack(trackId)
  ui.toggleTrackAutomationLane(trackId, pid)
}

/** Reset the visible param's curve to its default (clears all breakpoints). */
function resetAutomation(trackId: string, param: AutomationParamId): void {
  project.setTrackAutomation(trackId, param, [])
}

/** Copy the visible lane's curve; paste preserves its shape in the current parameter's range. */
function copyAutomation(trackId: string, param: AutomationParamId): void {
  const pts = project.tracks.find((t) => t.id === trackId)?.automation?.[param]
  if (!pts || pts.length < 2) return
  ui.copyAutomationCurve(param, pts)
}
function pasteAutomation(trackId: string, param: AutomationParamId): void {
  const clip = ui.automationClipboard
  if (!clip) return
  project.setTrackAutomation(
    trackId,
    param,
    translateAutomationCurve(clip.points, clip.paramId, param)
  )
}

// ─── Lane resize: track-header and per-lane edges ──────────────────────────
let laneResize:
  | {
      trackId: string
      paramId: AutomationParamId
      startY: number
      startClip: number
      startLane: number
      mode: 'track' | 'lane'
      moved: boolean
    }
  | null = null

function laneHeightOfTrack(trackId: string, paramId: AutomationParamId): number {
  return visibleAutomationLanes(trackId).find((lane) => lane.paramId === paramId)?.heightPx
    ?? AUTOMATION_LANE_HEIGHT
}

function beginLaneResize(
  trackId: string,
  paramId: AutomationParamId,
  mode: 'track' | 'lane',
  ev: PointerEvent
): void {
  if (ev.button !== 0) return
  ev.preventDefault()
  ev.stopPropagation()
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return
  laneResize = {
    trackId,
    paramId,
    startY: ev.clientY,
    startClip: trackHeightOf(track),
    startLane: laneHeightOfTrack(trackId, paramId),
    mode,
    moved: false
  }
  window.addEventListener('pointermove', onLaneResizeMove)
  window.addEventListener('pointerup', onLaneResizeUp)
  window.addEventListener('pointercancel', onLaneResizeUp)
}

function onLaneResizeMove(ev: PointerEvent): void {
  if (!laneResize) return
  const dy = ev.clientY - laneResize.startY
  if (!laneResize.moved && Math.abs(dy) < 1) return
  laneResize.moved = true
  if (laneResize.mode === 'track') {
    const clip = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(laneResize.startClip + dy)))
    project.setTrackHeightLocal(laneResize.trackId, clip)
  } else {
    ui.setTrackAutomationLaneHeight(
      laneResize.trackId,
      laneResize.paramId,
      laneResize.startLane + dy
    )
  }
}

function onLaneResizeUp(): void {
  window.removeEventListener('pointermove', onLaneResizeMove)
  window.removeEventListener('pointerup', onLaneResizeUp)
  window.removeEventListener('pointercancel', onLaneResizeUp)
  const drag = laneResize
  laneResize = null
  if (!drag || !drag.moved) return
  if (drag.mode === 'track') {
    const track = project.tracks.find((candidate) => candidate.id === drag.trackId)
    if (track) project.setTrackHeight(drag.trackId, trackHeightOf(track))
  } else {
    ui.persistTrackAutomationLaneView(drag.trackId)
  }
}

// ─── Resize-handle drag ───────────────────────────────────────────────────
// Visual height of the resize-handle strip (template geometry).
const HANDLE_PX = 5

const { onHandlePointerDown } = useTrackResizeDrag()

// ─── Reorder drag ─────────────────────────────────────────────────────────
const { rowsHostEl, dropIndicatorIndex, reorderingTrackId, dropIndicatorTopPx, onGripPointerDown } =
  useTrackReorderDrag(rowLayout)

function onHeaderClick(track: { id: string }, ev: MouseEvent): void {
  // Ignore clicks on controls so selection never steals their gesture.
  const target = ev.target as HTMLElement | null
  if (
    target?.closest(
      'button, input, select, a, [role="slider"], .track-grip, .track-resize-handle, .track-volume-slider'
    )
  ) {
    return
  }
  project.selectTrack(track.id)
}

/** Solo click: a plain click toggles solo as before. When another track is soloed (so
 *  this button is in its blocked / disabled-look state), a Ctrl/Cmd-click switches the
 *  solo to THIS track — soloing it and unsoloing the other in one step — so you can jump
 *  the solo without unsoloing then re-soloing. A plain click while blocked is a no-op,
 *  preserving the one-solo-at-a-time behaviour. */
function onSoloClick(track: { id: string; soloed: boolean }, ev: MouseEvent): void {
  const blockedByOtherSolo = project.anySoloed && !track.soloed
  if (blockedByOtherSolo) {
    if (ev.ctrlKey || ev.metaKey) project.soloOnly(track.id)
    return
  }
  project.toggleSolo(track.id)
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
    @wheel="onWheel"
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
          class="pointer-events-auto absolute flex flex-col gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs"
          :class="{
            'opacity-50': track.muted || (project.anySoloed && !track.soloed),
            'ring-1 ring-inset ring-sky-500/60': track.soloed,
            'opacity-30': reorderingTrackId === track.id,
            'bg-zinc-800/40': project.selectedTrackId === track.id,
            'rounded-b-none border-b-0': hasVisibleAutomationLanes(track.id)
          }"
          :style="[{
            top: ((rowLayout[i]?.top ?? 0) - RULER_HEIGHT) + 'px',
            height: (rowLayout[i]?.clipHeight ?? 0) + 'px',
            width: headerWidth + 'px'
          }, selectionBorderStyle(track, 'bottom')]"
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
                class="w-full rounded border border-zinc-600 bg-zinc-950 px-1 py-px text-xs font-medium text-zinc-100 outline-none focus:border-sky-500"
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

          <!-- Middle: volume slider + matching meter, with pan below. -->
          <div class="mt-2.5 flex flex-col gap-1.5">
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
                class="w-10 shrink-0 rounded border border-zinc-600 bg-zinc-950 px-0.5 py-px text-right font-mono text-[10px] tabular-nums text-zinc-100 outline-none focus:border-sky-500"
                @input="onGainInput"
                @blur="commitGainEdit(track.id)"
                @keydown="(e) => onGainKeydown(e, track.id)"
              >
              <button
                v-else
                type="button"
                data-borderless-button="true"
                class="w-10 shrink-0 cursor-text appearance-none border-0 bg-transparent p-0 text-right font-mono text-[10px] tabular-nums text-zinc-500 outline-none hover:text-zinc-200 focus-visible:text-sky-300"
                :title="`Volume ${formatLinearAsDb(track.volume, { unit: true })} — double-click to type a dB value (e.g. -3, +1.5, -inf)`"
                @dblclick.stop="startGainEdit(track.id, track.volume)"
              >
                {{ volumeDbText(track.volume) }}
              </button>
            </div>

            <!-- Pan: bipolar slider directly under the gain fader. -->
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
                <path d="M8 7l-4 5 4 5M16 7l4 5-4 5" />
              </svg>
              <input
                v-slider-detent="0"
                type="range"
                min="-1"
                max="1"
                step="0.01"
                :value="panValue(track)"
                :title="paramAutomated(track.id, 'pan') ? 'Automated over the timeline — edit the lane to change pan' : ('Pan ' + panDisplay(track.pan) + ' — double-click to centre')"
                aria-label="Track pan"
                class="track-pan h-1 min-w-0 flex-1 appearance-none rounded-full bg-zinc-700"
                :class="paramAutomated(track.id, 'pan') ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'"
                :disabled="paramAutomated(track.id, 'pan')"
                @input="(e) => onPanInput(track.id, Number((e.target as HTMLInputElement).value))"
                @change="(e) => onPanChange(track.id, Number((e.target as HTMLInputElement).value))"
                @dblclick.stop="onPanReset(track.id)"
              >
              <span class="w-10 shrink-0 text-right font-mono text-[10px] tabular-nums text-zinc-500">
                {{ panDisplay(panValue(track)) }}
              </span>
              <button
                type="button"
                class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border text-[8px] font-bold leading-none transition-colors"
                :class="paramAutomated(track.id, 'pan')
                  ? 'border-sky-400 bg-sky-500 text-zinc-950'
                  : isVisibleAutomationLane(track.id, 'pan')
                    ? 'border-sky-500 bg-zinc-800 text-sky-300'
                    : 'border-zinc-600 bg-zinc-800 text-zinc-400 hover:border-sky-500 hover:text-sky-300'"
                :title="isVisibleAutomationLane(track.id, 'pan') ? 'Editing pan automation lane' : 'Automate pan over the timeline'"
                aria-label="Automate pan"
                @click="automateParam(track.id, 'pan')"
              >
                A
              </button>
            </div>
          </div>

          <div class="mt-auto flex items-center gap-1 pt-2.5">
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
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors"
              :class="track.soloed
                ? 'border-sky-400 bg-sky-500 text-zinc-950 hover:bg-sky-400'
                : (project.anySoloed
                  ? 'border-zinc-800 bg-zinc-800 text-zinc-600 hover:border-zinc-600 hover:text-zinc-300'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100')
              "
              :title="project.anySoloed && !track.soloed ? 'Another track is soloed — Ctrl-click to solo this one instead' : (track.soloed ? 'Unsolo' : 'Solo')"
              @click="onSoloClick(track, $event)"
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
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold transition-colors"
              :class="hasVisibleAutomationLanes(track.id)
                ? 'border-sky-400 bg-sky-500 text-zinc-950 hover:bg-sky-400'
                : hasAutomation(track.id)
                  ? 'border-sky-700 bg-sky-900/50 text-sky-300 hover:border-sky-500 hover:bg-sky-800'
                  : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-500 hover:bg-zinc-700 hover:text-zinc-100'
              "
              :title="hasVisibleAutomationLanes(track.id) ? 'Hide automation lanes' : hasAutomation(track.id) ? 'Show automation lane (has automation)' : 'Show automation lane'"
              aria-label="Toggle track automation lane"
              :aria-pressed="hasVisibleAutomationLanes(track.id)"
              @click="ui.toggleTrackAutomationLanes(track.id)"
            >
              A
            </button>
          </div>
        </div>

        <!-- Full-width lane header: param picker, min/mid/max scale, live value. -->
        <template
          v-for="(track, i) in project.tracks"
          :key="'lanes-' + track.id"
        >
          <div
            v-for="(lane, laneIndex) in visibleAutomationLanes(track.id)"
            :key="'lane-' + track.id + '-' + lane.paramId"
            class="pointer-events-auto absolute left-0 flex flex-col border border-t-0 border-zinc-700 bg-zinc-900/40 px-2 py-1.5"
            :class="{
              'rounded-b': laneIndex === visibleAutomationLanes(track.id).length - 1,
              'bg-zinc-800/40': project.selectedTrackId === track.id
            }"
            :style="[{
              top: ((rowLayout[i]?.top ?? 0) + (rowLayout[i]?.clipHeight ?? 0) + laneOffset(track.id, laneIndex) - RULER_HEIGHT) + 'px',
              height: lane.heightPx + 'px',
              width: headerWidth + 'px'
            }, laneSelectionBorderStyle(track, laneIndex)]"
            @click="onHeaderClick(track, $event)"
          >
            <div class="mb-1.5 flex items-center gap-1">
              <select
                class="h-5 min-w-0 flex-1 rounded border border-sky-700 bg-zinc-900 px-1 text-[10px] text-sky-200 outline-none focus:border-sky-400"
                title="Automation parameter"
                :value="lane.paramId"
                @change="ui.setTrackAutomationLaneParam(track.id, lane.paramId, ($event.target as HTMLSelectElement).value as AutomationParamId); ($event.target as HTMLSelectElement).blur()"
              >
                <option
                  v-for="pid in AUTOMATABLE_PARAM_IDS"
                  :key="pid"
                  :value="pid"
                  :disabled="pid !== lane.paramId && isVisibleAutomationLane(track.id, pid)"
                >
                  {{ paramAutomated(track.id, pid) ? '● ' : '' }}{{ AUTOMATION_PARAMS[pid].label }}
                </option>
              </select>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white"
                title="Raise the whole curve"
                aria-label="Raise automation"
                @click="nudgeLane(track.id, lane.paramId, 1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <path d="M6 15l6-6 6 6" />
                </svg>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white"
                title="Lower the whole curve"
                aria-label="Lower automation"
                @click="nudgeLane(track.id, lane.paramId, -1)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white"
                title="Copy this automation curve"
                aria-label="Copy automation"
                @click="copyAutomation(track.id, lane.paramId)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <rect
                    x="9"
                    y="9"
                    width="11"
                    height="11"
                    rx="1"
                  />
                  <path d="M5 15V5a1 1 0 011-1h10" />
                </svg>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                title="Paste automation curve"
                aria-label="Paste automation"
                :disabled="!ui.automationClipboard"
                @click="pasteAutomation(track.id, lane.paramId)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <rect
                    x="8"
                    y="2"
                    width="8"
                    height="4"
                    rx="1"
                  />
                  <path d="M16 4h2a1 1 0 011 1v15a1 1 0 01-1 1H6a1 1 0 01-1-1V5a1 1 0 011-1h2" />
                </svg>
              </button>
              <button
                type="button"
                class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white"
                title="Reset this automation to default"
                aria-label="Reset automation"
                @click="resetAutomation(track.id, lane.paramId)"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  class="h-3 w-3"
                >
                  <path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </div>
            <div class="flex items-start justify-between text-[9px] leading-none text-zinc-400">
              <div class="flex flex-col gap-1">
                <span>{{ laneScale(track.id, lane.paramId).max }}</span>
                <input
                  v-if="editingLane?.trackId === track.id && editingLane.paramId === lane.paramId"
                  v-model="editValue"
                  type="text"
                  inputmode="decimal"
                  autofocus
                  :title="editHint(lane.paramId)"
                  :placeholder="editHint(lane.paramId)"
                  class="relative top-px w-16 rounded border border-sky-500 bg-zinc-950 px-1 text-[10px] text-sky-200 outline-none"
                  @keydown.enter.prevent="commitEditValue(track.id, lane.paramId)"
                  @keydown.esc.prevent="editingLane = null"
                  @blur="commitEditValue(track.id, lane.paramId)"
                >
                <span
                  v-else
                  class="relative top-px cursor-text text-sky-300"
                  :title="'Double-click to set the value at the playhead. ' + editHint(lane.paramId)"
                  @dblclick="startEditValue(track.id, lane.paramId)"
                >{{ laneScale(track.id, lane.paramId).cur }}</span>
                <span class="relative top-0.5">{{ laneScale(track.id, lane.paramId).min }}</span>
              </div>
              <div class="relative top-0.5 flex self-end gap-1">
                <button
                  type="button"
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-[14px] leading-none text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  title="Add automation lane"
                  aria-label="Add automation lane"
                  :disabled="!canAddAutomationLane(track.id)"
                  @click="addAutomationLane(track.id)"
                >
                  +
                </button>
                <button
                  type="button"
                  class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-[14px] leading-none text-zinc-400 transition-colors hover:border-red-500 hover:bg-red-600 hover:text-white"
                  title="Remove this automation lane"
                  aria-label="Remove automation lane"
                  @click="ui.removeTrackAutomationLane(track.id, lane.paramId)"
                >
                  x
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- Bottom edge of the track header resizes only the clip area. -->
        <div
          v-for="(track, i) in project.tracks"
          v-show="hasVisibleAutomationLanes(track.id)"
          :key="'lh-' + track.id"
          class="track-resize-handle track-header-resize-handle pointer-events-auto absolute left-0"
          :style="{
            top: ((rowLayout[i]?.top ?? 0) + (rowLayout[i]?.clipHeight ?? 0) - RULER_HEIGHT - Math.floor(HANDLE_PX / 2)) + 'px',
            height: HANDLE_PX + 'px',
            width: headerWidth + 'px'
          }"
          title="Drag to resize track header"
          @pointerdown="beginLaneResize(track.id, visibleAutomationLanes(track.id)[0]!.paramId, 'track', $event)"
        />

        <!-- Bottom edge resizes the final lane when automation is open. -->
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
          @pointerdown="hasVisibleAutomationLanes(track.id) ? beginLaneResize(track.id, visibleAutomationLanes(track.id).at(-1)!.paramId, 'lane', $event) : onHandlePointerDown(track, $event)"
        />

        <!-- Lane edges resize their own lane without changing any stored curve. -->
        <template
          v-for="(track, i) in project.tracks"
          :key="'lane-resize-' + track.id"
        >
          <div
            v-for="(lane, laneIndex) in visibleAutomationLanes(track.id)"

            :key="'lane-resize-' + track.id + '-' + lane.paramId"
            class="track-resize-handle pointer-events-auto absolute left-0"
            :style="{
              top: ((rowLayout[i]?.top ?? 0) + (rowLayout[i]?.clipHeight ?? 0) + laneOffset(track.id, laneIndex) + lane.heightPx - RULER_HEIGHT - Math.floor(HANDLE_PX / 2)) + 'px',
              height: HANDLE_PX + 'px',
              width: headerWidth + 'px'
            }"
            title="Drag to resize this automation header"
            @pointerdown="beginLaneResize(track.id, lane.paramId, 'lane', $event)"
          />
        </template>

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

/* Pan slider: same thumb as the volume fader, with a subtle centre detent on the
   track so 0 (centre) reads at a glance. */
.track-pan {
  outline: none;
}

.track-pan::-webkit-slider-thumb {
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

.track-pan::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.track-pan::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  /* Flat zinc track with a 1px centre tick. */
  background:
    linear-gradient(#71717a, #71717a) 50% / 1px 100% no-repeat,
    #3f3f46;
}

.track-pan::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background:
    linear-gradient(#71717a, #71717a) 50% / 1px 100% no-repeat,
    #3f3f46;
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

/* Thin persistent divider marks the track-header resize edge. */
.track-header-resize-handle {
  background: linear-gradient(
    to bottom,
    transparent 2px,
    rgba(82, 82, 91, 0.85) 2px,
    rgba(82, 82, 91, 0.85) 3px,
    transparent 3px
  );
}
.track-header-resize-handle:hover {
  background: linear-gradient(
    to bottom,
    transparent 1px,
    rgba(56, 189, 248, 0.75) 1px,
    rgba(56, 189, 248, 0.75) 4px,
    transparent 4px
  );
}

/* Drop indicator for the current reorder slot. */
.track-drop-indicator {
  height: 2px;
  background: #10b981; /* emerald-500 */
  box-shadow: 0 0 0 1px rgba(16, 185, 129, 0.35);
  z-index: 10;
}
</style>
