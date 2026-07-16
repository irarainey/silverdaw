<script setup lang="ts">
// Clip Editor view/zoom toolbar: the Volume-shape toggle, non-destructive Trim,
// and Source/Clip view switch. Two-way `volumeEditMode` and `viewExpanded` flow
// through v-model; action intents are emitted to the parent. Zoom controls live
// as an overlay on the waveform panel itself.
const volumeEditMode = defineModel<boolean>('volumeEditMode', { required: true })
const sliceEditMode = defineModel<boolean>('sliceEditMode', { required: true })
const viewExpanded = defineModel<boolean>('viewExpanded', { required: true })

defineProps<{
  editsTimelineClip: boolean
  editsExistingClip: boolean
  canApplyCrop: boolean
  canResetVolume: boolean
  canGateSelection: boolean
  reverseAvailable: boolean
  reverseActive: boolean
  djEffectAvailable: boolean
  brakeActive: boolean
  backspinActive: boolean
}>()

defineEmits<{
  (e: 'apply-crop'): void
  (e: 'reset-volume'): void
  (e: 'silence-selection'): void
  (e: 'full-selection'): void
  (e: 'toggle-reverse'): void
  (e: 'toggle-brake'): void
  (e: 'toggle-backspin'): void
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
    <!-- Loop-slice mode toggle: chop the clip into adjacent clips on a grid or
         by hand. Shares the Volume toggle's gating (timeline clip, Clip view). -->
    <button
      v-if="editsTimelineClip"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium"
      :class="
        sliceEditMode && !viewExpanded
          ? 'bg-emerald-600 text-white hover:bg-emerald-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40'
      "
      :disabled="viewExpanded"
      :title="
        viewExpanded
          ? 'Switch to the Clip view to slice'
          : sliceEditMode
            ? 'Slice mode on — drag to add markers, Alt-click to remove'
            : 'Chop the clip into slices on a grid or by hand'
      "
      @click="sliceEditMode = !sliceEditMode"
    >
      Slice
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
         when on; linked clips reverse every instance. Mutually exclusive with the
         Brake / Backspin tail effects, so it is disabled while one of those is set. -->
    <button
      v-if="reverseAvailable"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
      :class="
        reverseActive
          ? 'bg-violet-600 text-white hover:bg-violet-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      "
      :disabled="!reverseActive && (brakeActive || backspinActive)"
      :title="
        !reverseActive && brakeActive
          ? 'Turn off Brake first — a clip can be reversed or have a turntable effect, not both'
          : !reverseActive && backspinActive
            ? 'Turn off Backspin first — a clip can be reversed or have a turntable effect, not both'
            : reverseActive
              ? 'Reverse on — the clip plays backwards (non-destructive)'
              : 'Play the clip backwards (non-destructive)'
      "
      @click="$emit('toggle-reverse')"
    >
      Reverse
    </button>
    <!-- Turntable brake (record-stop): non-destructive tail effect that
         decelerates the clip to a stop at its end. Kept visible but disabled on
         reversed clips, and while Backspin is on (one or the other, not both). -->
    <button
      v-if="djEffectAvailable"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
      :class="
        brakeActive
          ? 'bg-red-600 text-white hover:bg-red-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      "
      :disabled="reverseActive || (!brakeActive && backspinActive)"
      :title="
        reverseActive
          ? 'Not available on a reversed clip — turn off Reverse first'
          : !brakeActive && backspinActive
            ? 'Turn off Backspin first — a clip can have a brake or a backspin, not both'
            : brakeActive
              ? 'Brake on — the clip decelerates to a stop at its end (non-destructive)'
              : 'Decelerate the clip to a stop at its end, like a turntable record-stop'
      "
      @click="$emit('toggle-brake')"
    >
      Brake
    </button>
    <!-- Turntable backspin (reverse rewind): non-destructive tail effect that
         rewinds the clip backwards at its end. Kept visible but disabled on
         reversed clips, and while Brake is on. -->
    <button
      v-if="djEffectAvailable"
      type="button"
      class="rounded px-2 py-1 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
      :class="
        backspinActive
          ? 'bg-violet-600 text-white hover:bg-violet-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      "
      :disabled="reverseActive || (!backspinActive && brakeActive)"
      :title="
        reverseActive
          ? 'Not available on a reversed clip — turn off Reverse first'
          : !backspinActive && brakeActive
            ? 'Turn off Brake first — a clip can have a brake or a backspin, not both'
            : backspinActive
              ? 'Backspin on — the clip rewinds backwards at its end (non-destructive)'
              : 'Rewind the clip backwards at its end, like a DJ pulling the vinyl back'
      "
      @click="$emit('toggle-backspin')"
    >
      Backspin
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
  </div>
</template>
