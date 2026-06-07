<script setup lang="ts">
// Clip Editor view/zoom toolbar: the Volume-shape toggle, non-destructive Trim,
// Source/Clip view switch, and zoom controls. Two-way `volumeEditMode` and
// `viewExpanded` flow through v-model; action intents are emitted to the parent.
import { MAX_ZOOM } from '@/lib/clipEditor/useClipEditorViewport'

const volumeEditMode = defineModel<boolean>('volumeEditMode', { required: true })
const viewExpanded = defineModel<boolean>('viewExpanded', { required: true })

defineProps<{
  editsSingleTimelineClip: boolean
  editsExistingClip: boolean
  canApplyCrop: boolean
  zoom: number
  zoomPercent: number
}>()

defineEmits<{
  (e: 'apply-crop'): void
  (e: 'zoom-out'): void
  (e: 'reset-zoom'): void
  (e: 'zoom-in'): void
}>()
</script>

<template>
  <div class="flex shrink-0 items-center gap-1">
    <!-- Volume Shape edit toggle. -->
    <button
      v-if="editsSingleTimelineClip"
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
            ? 'Volume shaping on — click the waveform to add or drag breakpoints'
            : 'Shape the clip volume over time on the waveform'
      "
      @click="volumeEditMode = !volumeEditMode"
    >
      Volume
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
