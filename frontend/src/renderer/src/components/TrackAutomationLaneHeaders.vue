<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useProjectStore } from '@/stores/projectStore'
import { useUiStore } from '@/stores/uiStore'
import { AUTOMATION_LANE_HEIGHT, MAX_TRACK_HEIGHT, MIN_TRACK_HEIGHT, RULER_HEIGHT } from '@/lib/timeline/constants'
import { trackHeightOf } from '@/lib/timeline/trackLayout'
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

interface TrackRowLayout {
  top: number
  height: number
  clipHeight: number
}

const { track, row, headerWidth } = defineProps<{
  track: Track
  row: TrackRowLayout | undefined
  headerWidth: number
}>()

const project = useProjectStore()
const ui = useUiStore()
const transport = useTransportStore()
const lanes = computed(() => ui.automationLanes[track.id] ?? [])

function laneSelectionBorderStyle(laneIndex: number): Record<string, string> | undefined {
  if (project.selectedTrackId !== track.id) return undefined
  const palette = TRACK_PALETTE[track.colorIndex % TRACK_PALETTE.length]!
  const style: Record<string, string> = { borderColor: palette.cssHex, borderWidth: '2px' }
  if (laneIndex < lanes.value.length - 1) style.borderBottomWidth = '0px'
  return style
}

function onHeaderClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null
  if (target?.closest('button, input, select, a, [role="slider"]')) return
  project.selectTrack(track.id)
}

// Swap a lane's parameter, then hand focus back to the shell so the timeline
// keyboard shortcuts keep working instead of going to the dropdown. Escape does
// the same for a popup dismissed without a change.
function onLaneParamChange(fromParamId: AutomationParamId, ev: Event): void {
  const select = ev.target as HTMLSelectElement
  ui.setTrackAutomationLaneParam(track.id, fromParamId, select.value as AutomationParamId)
  select.blur()
}

function laneScale(param: AutomationParamId): { min: string; cur: string; max: string; curVal: number } {
  const d = AUTOMATION_PARAMS[param]
  const points = track.automation?.[param]
  const value = points && points.length >= 2
    ? sampleBreakpoints(points, transport.positionMs)
    : trackStaticAutomationValue(track, param)
  return { min: d.format(d.min), cur: d.format(value), max: d.format(d.max), curVal: value }
}

function nudgeLane(param: AutomationParamId, dir: 1 | -1): void {
  const d = AUTOMATION_PARAMS[param]
  const step = (d.max - d.min) * 0.05 * dir
  const current = laneScale(param).curVal
  const delta = (current - d.defaultValue) * (current + step - d.defaultValue) < 0
    ? d.defaultValue - current
    : step
  project.shiftTrackAutomation(track.id, param, delta)
}

function editHint(param: AutomationParamId): string {
  if (param === 'filter') return 'Negative = LPF, positive = HPF, 0 = off (−1…1)'
  const d = AUTOMATION_PARAMS[param]
  return `${d.format(d.min)} … ${d.format(d.max)}`
}

const editingParamId = ref<AutomationParamId | null>(null)
const editValue = ref('')

function startEditValue(paramId: AutomationParamId): void {
  editingParamId.value = paramId
  editValue.value = String(Number(laneScale(paramId).curVal.toFixed(2)))
}

function commitEditValue(param: AutomationParamId): void {
  const value = Number(editValue.value)
  if (editValue.value.trim() !== '' && Number.isFinite(value)) {
    const d = AUTOMATION_PARAMS[param]
    project.setAutomationValueAt(track.id, param, transport.positionMs, Math.min(d.max, Math.max(d.min, value)))
  }
  editingParamId.value = null
}

function paramAutomated(param: AutomationParamId): boolean {
  const points = track.automation?.[param]
  return Array.isArray(points) && points.length >= 2
}

function isVisibleAutomationLane(paramId: AutomationParamId): boolean {
  return lanes.value.some((lane) => lane.paramId === paramId)
}

function laneOffset(laneIndex: number): number {
  return automationLaneOffset(lanes.value, laneIndex)
}

function canAddAutomationLane(): boolean {
  return lanes.value.length < AUTOMATABLE_PARAM_IDS.length
}

function addAutomationLane(): void {
  const visible = new Set(lanes.value.map((lane) => lane.paramId))
  const paramId = AUTOMATABLE_PARAM_IDS.find((id) => !visible.has(id))
  if (paramId) ui.addTrackAutomationLane(track.id, paramId)
}

function resetAutomation(param: AutomationParamId): void {
  project.setTrackAutomation(track.id, param, [])
}

function copyAutomation(param: AutomationParamId): void {
  const points = track.automation?.[param]
  if (!points || points.length < 2) return
  ui.copyAutomationCurve(param, points)
}

function pasteAutomation(param: AutomationParamId): void {
  const clipboard = ui.automationClipboard
  if (!clipboard) return
  project.setTrackAutomation(
    track.id,
    param,
    translateAutomationCurve(clipboard.points, clipboard.paramId, param)
  )
}

let resize:
  | {
      paramId: AutomationParamId
      startY: number
      startClipHeight: number
      startLaneHeight: number
      mode: 'track' | 'lane'
      moved: boolean
    }
  | null = null

function laneHeight(paramId: AutomationParamId): number {
  return lanes.value.find((lane) => lane.paramId === paramId)?.heightPx ?? AUTOMATION_LANE_HEIGHT
}

function clearResizeListeners(): void {
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', onResizeUp)
  window.removeEventListener('pointercancel', onResizeUp)
}

function beginResize(paramId: AutomationParamId, mode: 'track' | 'lane', ev: PointerEvent): void {
  if (ev.button !== 0) return
  ev.preventDefault()
  ev.stopPropagation()
  resize = {
    paramId,
    startY: ev.clientY,
    startClipHeight: trackHeightOf(track),
    startLaneHeight: laneHeight(paramId),
    mode,
    moved: false
  }
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', onResizeUp)
  window.addEventListener('pointercancel', onResizeUp)
}

function onResizeMove(ev: PointerEvent): void {
  if (!resize) return
  const deltaY = ev.clientY - resize.startY
  if (!resize.moved && Math.abs(deltaY) < 1) return
  resize.moved = true
  if (resize.mode === 'track') {
    const height = Math.max(MIN_TRACK_HEIGHT, Math.min(MAX_TRACK_HEIGHT, Math.round(resize.startClipHeight + deltaY)))
    project.setTrackHeightLocal(track.id, height)
    return
  }
  ui.setTrackAutomationLaneHeight(track.id, resize.paramId, resize.startLaneHeight + deltaY)
}

function onResizeUp(): void {
  clearResizeListeners()
  const drag = resize
  resize = null
  if (!drag || !drag.moved) return
  if (drag.mode === 'track') {
    project.setTrackHeight(track.id, trackHeightOf(track))
  } else {
    ui.persistTrackAutomationLaneView(track.id)
  }
}

onBeforeUnmount(clearResizeListeners)

const HANDLE_PX = 5
</script>

<template>
  <template
    v-for="(lane, laneIndex) in lanes"
    :key="lane.paramId"
  >
    <div
      class="pointer-events-auto absolute left-0 flex flex-col border border-t-0 border-zinc-700 bg-zinc-900/40 px-2 py-1.5"
      :class="{
        'rounded-b': laneIndex === lanes.length - 1,
        'bg-zinc-800/40': project.selectedTrackId === track.id
      }"
      :style="[{
        top: ((row?.top ?? 0) + (row?.clipHeight ?? 0) + laneOffset(laneIndex) - RULER_HEIGHT) + 'px',
        height: lane.heightPx + 'px',
        width: headerWidth + 'px'
      }, laneSelectionBorderStyle(laneIndex)]"
      @click="onHeaderClick"
    >
      <div class="mb-1.5 flex items-center gap-1">
        <select
          class="app-select app-select-dense min-w-0 flex-1 truncate border-sky-700 text-sky-200 focus:border-sky-400"
          :title="'Automation parameter — ' + AUTOMATION_PARAMS[lane.paramId].label"
          :value="lane.paramId"
          @change="onLaneParamChange(lane.paramId, $event)"
          @keyup.esc="($event.target as HTMLSelectElement).blur()"
        >
          <option
            v-for="paramId in AUTOMATABLE_PARAM_IDS"
            :key="paramId"
            :value="paramId"
            :disabled="paramId !== lane.paramId && isVisibleAutomationLane(paramId)"
          >
            {{ paramAutomated(paramId) ? '● ' : '' }}{{ AUTOMATION_PARAMS[paramId].label }}
          </option>
        </select>
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white"
          title="Raise the whole curve"
          aria-label="Raise automation"
          @click="nudgeLane(lane.paramId, 1)"
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
          @click="nudgeLane(lane.paramId, -1)"
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
          @click="copyAutomation(lane.paramId)"
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
          @click="pasteAutomation(lane.paramId)"
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
          @click="resetAutomation(lane.paramId)"
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
          <span>{{ laneScale(lane.paramId).max }}</span>
          <input
            v-if="editingParamId === lane.paramId"
            v-model="editValue"
            type="text"
            inputmode="decimal"
            autofocus
            :title="editHint(lane.paramId)"
            :placeholder="editHint(lane.paramId)"
            class="relative top-px w-16 rounded border border-sky-500 bg-zinc-950 px-1 text-[10px] text-sky-200 outline-none"
            @keydown.enter.prevent="commitEditValue(lane.paramId)"
            @keydown.esc.prevent="editingParamId = null"
            @blur="commitEditValue(lane.paramId)"
          >
          <span
            v-else
            class="relative top-px cursor-text text-sky-300"
            :title="'Double-click to set the value at the playhead. ' + editHint(lane.paramId)"
            @dblclick="startEditValue(lane.paramId)"
          >{{ laneScale(lane.paramId).cur }}</span>
          <span class="relative top-0.5">{{ laneScale(lane.paramId).min }}</span>
        </div>
        <div class="relative top-0.5 flex self-end gap-1">
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-[14px] leading-none text-zinc-400 transition-colors hover:border-sky-500 hover:bg-sky-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            title="Add automation lane"
            aria-label="Add automation lane"
            :disabled="!canAddAutomationLane()"
            @click="addAutomationLane"
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
    <div
      v-if="laneIndex === 0"
      class="track-resize-handle track-header-resize-handle pointer-events-auto absolute left-0"
      :style="{
        top: ((row?.top ?? 0) + (row?.clipHeight ?? 0) - RULER_HEIGHT - Math.floor(HANDLE_PX / 2)) + 'px',
        height: HANDLE_PX + 'px',
        width: headerWidth + 'px'
      }"
      title="Drag to resize track header"
      @pointerdown="beginResize(lane.paramId, 'track', $event)"
    />
    <div
      class="track-resize-handle pointer-events-auto absolute left-0"
      :style="{
        top: ((row?.top ?? 0) + (row?.clipHeight ?? 0) + laneOffset(laneIndex) + lane.heightPx - RULER_HEIGHT - Math.floor(HANDLE_PX / 2)) + 'px',
        height: HANDLE_PX + 'px',
        width: headerWidth + 'px'
      }"
      :title="laneIndex === lanes.length - 1
        ? 'Drag to resize track — ' + Math.round(row?.height ?? 0) + 'px'
        : 'Drag to resize this automation header'"
      @pointerdown="beginResize(lane.paramId, 'lane', $event)"
    />
  </template>
</template>

<style scoped>
.track-resize-handle {
  cursor: ns-resize;
  background: transparent;
  z-index: 5;
}
.track-resize-handle:hover {
  background: rgba(113, 113, 122, 0.45);
}
.track-resize-handle:active {
  background: rgba(244, 244, 245, 0.6);
}
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
</style>
