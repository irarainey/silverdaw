<script setup lang="ts">
// Clip Editor view/zoom toolbar: the Volume-shape toggle, non-destructive Trim,
// Source/Clip view switch, and zoom controls. Two-way `volumeEditMode` and
// `viewExpanded` flow through v-model; action intents are emitted to the parent.
import { MAX_ZOOM } from '@/lib/clipEditor/useClipEditorViewport'

const volumeEditMode = defineModel<boolean>('volumeEditMode', { required: true })
const viewExpanded = defineModel<boolean>('viewExpanded', { required: true })

defineProps<{
  editsTimelineClip: boolean
  editsExistingClip: boolean
  canApplyCrop: boolean
  canResetVolume: boolean
  canGateSelection: boolean
  reverseAvailable: boolean
  reverseActive: boolean
  zoom: number
  zoomPercent: number
}>()

defineEmits<{
  (e: 'apply-crop'): void
  (e: 'reset-volume'): void
  (e: 'silence-selection'): void
  (e: 'full-selection'): void
  (e: 'toggle-reverse'): void
  (e: 'zoom-out'): void
  (e: 'reset-zoom'): void
  (e: 'zoom-in'): void
}>()
</script>

<template>
  <div class="flex shrink-0 items-center gap-1">
    <!-- Reset the volume shape back to standard (flat unity). Shares the Volume
         toggle's visibility so entering/leaving volume-edit mode never reflows
         the toolbar; enabled whenever a shape exists, without needing edit mode. -->
    <button
      v-if="editsTimelineClip"
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canResetVolume"
      title="Reset the volume shape to standard"
      @click="$emit('reset-volume')"
    >
      <span class="text-base leading-none">↺</span>
    </button>
    <!-- Volume Shape edit toggle. -->
    <button
      v-if="editsTimelineClip"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium"
      :class="
        volumeEditMode && !viewExpanded
          ? 'bg-violet-600 text-white hover:bg-violet-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40'
      "
      :disabled="viewExpanded"
      :title="
        viewExpanded
          ? 'Switch to the Clip view to shape volume'
          : volumeEditMode
            ? 'Volume shaping on — drag to add or move breakpoints; hold Shift to snap to beats'
            : 'Shape the clip volume over time on the waveform'
      "
      @click="volumeEditMode = !volumeEditMode"
    >
      Volume
    </button>
    <!-- Region gate: flatten the selected range to silence or full volume with
         hard edges. Acts on the current selection; enabled once a range exists. -->
    <button
      v-if="editsTimelineClip"
      type="button"
      class="rounded bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canGateSelection"
      :title="
        canGateSelection
          ? 'Silence the selected range with hard edges (S)'
          : 'Select a range on the waveform first'
      "
      @click="$emit('silence-selection')"
    >
      Silence
    </button>
    <button
      v-if="editsTimelineClip"
      type="button"
      class="rounded bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canGateSelection"
      :title="
        canGateSelection
          ? 'Set the selected range to full volume with hard edges (F)'
          : 'Select a range on the waveform first'
      "
      @click="$emit('full-selection')"
    >
      Full
    </button>
    <!-- Reverse: non-destructive whole-clip backwards playback toggle. Highlights
         when on; linked clips reverse every instance. -->
    <button
      v-if="reverseAvailable"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium"
      :class="
        reverseActive
          ? 'bg-violet-600 text-white hover:bg-violet-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      "
      :title="
        reverseActive
          ? 'Reverse on — the clip plays backwards (non-destructive)'
          : 'Play the clip backwards (non-destructive)'
      "
      @click="$emit('toggle-reverse')"
    >
      Reverse
    </button>
    <!-- Non-destructive crop with dialog-local undo/redo. -->
    <button
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
      :disabled="!canApplyCrop"
      title="Trim the working view to the selection (Ctrl+Z to undo)"
      @click="$emit('apply-crop')"
    >
      Trim
    </button>
    <button
      v-if="editsExistingClip"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium"
      :class="
        viewExpanded
          ? 'bg-blue-600 text-white hover:bg-blue-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      "
      :title="
        viewExpanded
          ? 'Showing full source — click to crop back to the clip'
          : 'Show full source so you can extend the clip past its current bounds'
      "
      @click="viewExpanded = !viewExpanded"
    >
      {{ viewExpanded ? 'Clip' : 'Source' }}
    </button>
    <button
      type="button"
      class="ml-1 flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      title="Zoom out (-)"
      :disabled="zoom <= 1.0001"
      @click="$emit('zoom-out')"
    >
      <span class="text-base leading-none">−</span>
    </button>
    <button
      type="button"
      class="rounded bg-zinc-800 px-2 py-1 font-mono text-[11px] tabular-nums text-zinc-200 hover:bg-zinc-700"
      title="Reset zoom (0)"
      @click="$emit('reset-zoom')"
    >
      {{ zoomPercent }}%
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40"
      title="Zoom in (+)"
      :disabled="zoom >= MAX_ZOOM - 0.01"
      @click="$emit('zoom-in')"
    >
      <span class="text-base leading-none">+</span>
    </button>
  </div>
</template>
