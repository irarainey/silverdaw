<script setup lang="ts">
import { computed, ref } from 'vue'
import ClipEditorWarpPanel from '@/components/ClipEditorWarpPanel.vue'
import ClipEditorPitchPanel from '@/components/ClipEditorPitchPanel.vue'
import ClipEditorBeatGridPanel from '@/components/ClipEditorBeatGridPanel.vue'
import ClipEditorPlaybackControls from '@/components/ClipEditorPlaybackControls.vue'
import ClipEditorSelectionInfo from '@/components/ClipEditorSelectionInfo.vue'
import ClipEditorViewControls from '@/components/ClipEditorViewControls.vue'
import ClipEditorSlicePanel from '@/components/ClipEditorSlicePanel.vue'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import { useClipEditorController, type ClipEditorProps } from '@/lib/clipEditor/useClipEditorController'
import { MAX_ZOOM } from '@/lib/clipEditor/useClipEditorViewport'

const props = defineProps<ClipEditorProps>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)
const waveformHost = ref<HTMLDivElement | null>(null)

const {
  preview,
  transport,
  warpDraft,
  beatGrid,
  titleText,
  warpActive,
  loopEnabled,
  onSkipToStart,
  onTogglePlay,
  onSkipToEnd,
  onToggleLoop,
  clipMetronomeEnabled,
  onToggleClipMetronome,
  volumeEditActive,
  onCanvasMouseDown,
  onCanvasContextMenu,
  onCanvasWheel,
  onScrollbarMouseDown,
  zoomPercent,
  viewDurationMs,
  scrollMs,
  visibleDurationMs,
  selectionInMs,
  selectionEndMs,
  selectionDurationMs,
  playheadAbsMs,
  viewInMs,
  volumeEditMode,
  sliceEditMode,
  sliceEditActive,
  sliceAvailable,
  sliceSubdivision,
  sliceCount,
  onGenerateSliceGrid,
  onSliceToTimeline,
  onSliceToSamples,
  viewExpanded,
  editsTimelineClip,
  editsExistingClip,
  canApplyCrop,
  canResetVolumeShape,
  onResetVolumeShape,
  canGateSelection,
  onSilenceSelection,
  onFullSelection,
  reverseAvailable,
  reverseActive,
  onToggleReverse,
  djEffectAvailable,
  brakeActive,
  backspinActive,
  onToggleBrake,
  onToggleBackspin,
  zoom,
  onApplyCrop,
  zoomOut,
  resetZoom,
  zoomIn,
  warpSourceBpm,
  sourceKey,
  sourceItem,
  editorItem,
  canSaveChanges,
  editsLibraryClipLibrary,
  onSaveChanges,
  canSaveAsNew,
  onSaveAsNew,
  onKeydown
} = useClipEditorController(props, emit, dialogEl, waveformHost)

// Grid-align mode repurposes the canvas drag; reflect it in the cursor.
const gridAligning = computed(() => beatGrid.alignActive.value)
</script>

<template>
  <Transition
    enter-active-class="transition-opacity duration-150"
    enter-from-class="opacity-0"
    enter-to-class="opacity-100"
    leave-active-class="transition-opacity duration-100"
    leave-from-class="opacity-100"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open && editorItem && sourceItem"
      class="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="clip-editor-title"
    >
      <div
        ref="dialogEl"
        tabindex="-1"
        class="dialog-card w-[min(1440px,98vw)]"
        :class="editsExistingClip ? 'h-[min(980px,96vh)]' : 'h-[min(620px,90vh)]'"
        @keydown="onKeydown"
      >
        <header class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-zinc-800 px-6 py-3">
          <div class="min-w-0 justify-self-start">
            <div class="flex min-w-0 items-center gap-2">
              <h2
                id="clip-editor-title"
                class="truncate text-base font-semibold text-zinc-100"
              >
                {{ titleText }}
              </h2>
              <span
                v-if="warpActive"
                class="shrink-0 rounded border border-white/90 bg-slate-950 px-2 py-0.5 text-[10px] font-bold leading-none tracking-wide text-yellow-300"
                title="This clip is warped"
              >
                WARP
              </span>
              <span
                v-if="!editsExistingClip"
                class="shrink-0 rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-zinc-300"
                title="Previewing the original file — warp, pitch, and effects are edited per clip on the timeline"
              >
                Preview
              </span>
            </div>
            <p class="mt-0.5 truncate text-xs text-zinc-500">
              {{ sourceItem.fileName }}
            </p>
          </div>
          <ClipEditorPlaybackControls
            :is-playing="preview.isPlaying"
            :is-loaded="preview.isLoaded"
            :loop-enabled="loopEnabled"
            :metronome-enabled="clipMetronomeEnabled"
            :show-metronome="editsExistingClip"
            @skip-to-start="onSkipToStart"
            @toggle-play="onTogglePlay"
            @skip-to-end="onSkipToEnd"
            @toggle-loop="onToggleLoop"
            @toggle-metronome="onToggleClipMetronome"
          />
          <div class="justify-self-end" />
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
          <div class="flex min-w-0 flex-col gap-3">
            <div class="relative w-full">
              <div
                ref="waveformHost"
                class="relative h-[min(260px,26vh)] w-full overflow-hidden rounded border border-zinc-800 bg-zinc-950"
                :class="gridAligning ? 'cursor-grab' : volumeEditActive ? 'cursor-pointer' : 'cursor-crosshair'"
                @mousedown="onCanvasMouseDown"
                @contextmenu="onCanvasContextMenu"
                @wheel="onCanvasWheel"
              />
              <!-- Horizontal scrollbar, flush to the bottom edge of the waveform
                   window and full width, matching how the main timeline renders it. -->
              <div
                class="absolute inset-x-0 bottom-0 h-2 cursor-pointer bg-zinc-900/80"
                :title="`Scroll (zoom ${zoomPercent}%)`"
                @mousedown="onScrollbarMouseDown"
              >
                <div
                  class="absolute top-0 h-full rounded bg-zinc-600 hover:bg-zinc-500"
                  :style="{
                    left: viewDurationMs > 0 ? `${(scrollMs / viewDurationMs) * 100}%` : '0%',
                    width: viewDurationMs > 0
                      ? `${Math.max(2, (visibleDurationMs / viewDurationMs) * 100)}%`
                      : '100%'
                  }"
                />
              </div>
              <!-- Zoom controls overlaid in the bottom-right corner as a single
                   grouped box, matching the scratch editor's preview panel. -->
              <div class="absolute bottom-3 right-1.5 inline-flex items-center overflow-hidden rounded border border-zinc-700 bg-zinc-900/90">
                <button
                  type="button"
                  class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Zoom out (-)"
                  :disabled="zoom <= 1.0001"
                  @click="zoomOut"
                >
                  <span class="text-sm leading-none">−</span>
                </button>
                <button
                  type="button"
                  class="min-w-10 border-x border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-zinc-200 hover:bg-zinc-800"
                  title="Reset zoom (0)"
                  @click="resetZoom"
                >
                  {{ zoomPercent }}%
                </button>
                <button
                  type="button"
                  class="flex h-5 w-5 items-center justify-center text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Zoom in (+)"
                  :disabled="zoom >= MAX_ZOOM - 0.01"
                  @click="zoomIn"
                >
                  <span class="text-sm leading-none">+</span>
                </button>
              </div>
            </div>
            <div class="flex items-center justify-between gap-4 text-xs text-zinc-400">
              <ClipEditorSelectionInfo
                :selection-in-ms="selectionInMs"
                :selection-end-ms="selectionEndMs"
                :selection-duration-ms="selectionDurationMs"
                :playhead-abs-ms="playheadAbsMs"
                :view-in-ms="viewInMs"
              />
              <ClipEditorViewControls
                v-model:volume-edit-mode="volumeEditMode"
                v-model:slice-edit-mode="sliceEditMode"
                v-model:view-expanded="viewExpanded"
                :edits-timeline-clip="editsTimelineClip"
                :edits-existing-clip="editsExistingClip"
                :can-apply-crop="canApplyCrop"
                :can-reset-volume="canResetVolumeShape"
                :can-gate-selection="canGateSelection"
                :reverse-available="reverseAvailable"
                :reverse-active="reverseActive"
                :dj-effect-available="djEffectAvailable"
                :brake-active="brakeActive"
                :backspin-active="backspinActive"
                @apply-crop="onApplyCrop"
                @reset-volume="onResetVolumeShape"
                @silence-selection="onSilenceSelection"
                @full-selection="onFullSelection"
                @toggle-reverse="onToggleReverse"
                @toggle-brake="onToggleBrake"
                @toggle-backspin="onToggleBackspin"
              />
            </div>
          </div>

          <div
            v-if="editsExistingClip"
            class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded border border-zinc-800 bg-zinc-950/40"
          >
            <!-- Effects rack: fixed-cell modular grid. -->
            <div
              class="clip-effects-rack silverdaw-scroll grid min-h-0 min-w-0 flex-1 gap-3 overflow-auto p-3"
              role="group"
              aria-label="Clip effects"
            >
              <ClipEffectModule
                title="Warp"
                :cols="1"
                :rows="2"
              >
                <ClipEditorWarpPanel
                  :draft="warpDraft"
                  :source-bpm="warpSourceBpm"
                  :project-bpm="transport.bpm"
                />
              </ClipEffectModule>
              <ClipEffectModule
                title="Beat grid"
                :cols="1"
                :rows="2"
              >
                <ClipEditorBeatGridPanel :grid="beatGrid" />
              </ClipEffectModule>
              <ClipEffectModule
                title="Pitch"
                :cols="1"
                :rows="2"
              >
                <ClipEditorPitchPanel
                  :draft="warpDraft"
                  :source-key="sourceKey"
                />
              </ClipEffectModule>
              <ClipEffectModule
                v-if="sliceEditActive"
                title="Slice"
                :cols="1"
                :rows="2"
              >
                <ClipEditorSlicePanel
                  v-model:subdivision="sliceSubdivision"
                  :slice-count="sliceCount"
                  :can-slice="sliceAvailable"
                  @generate="onGenerateSliceGrid"
                  @slice-to-timeline="onSliceToTimeline"
                  @slice-to-samples="onSliceToSamples"
                />
              </ClipEffectModule>
            </div>
          </div>
          <div
            v-else
            class="rounded border border-zinc-800 bg-zinc-950/40 px-4 py-3 text-xs leading-relaxed text-zinc-400"
          >
            <span class="font-medium text-zinc-200">Drag across the waveform to select a section</span>,
            then <span class="text-zinc-300">Save Selection to Library</span> to make a clip you can warp,
            pitch-shift, and add effects to. Warp, pitch, and effects are set per clip — not on this original file.
          </div>
        </div>

        <footer class="dialog-footer">
          <button
            type="button"
            class="dialog-btn-cancel"
            @click="emit('close')"
          >
            {{ editsExistingClip ? 'Cancel' : 'Close' }}
          </button>
          <button
            v-if="editsExistingClip"
            type="button"
            class="dialog-btn-primary"
            :disabled="!canSaveChanges"
            :title="editsLibraryClipLibrary
              ? 'Save changes to the library and every linked timeline clip'
              : 'Save changes to this timeline clip only'"
            @click="onSaveChanges"
          >
            Save
          </button>
          <button
            v-else
            type="button"
            class="dialog-btn-primary"
            :disabled="!canSaveAsNew"
            @click="onSaveAsNew"
          >
            Save Selection to Library
          </button>
        </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* Fixed-cell modular grid; column-dense packing back-fills gaps. */
.clip-effects-rack {
  --cell-w: 17rem; /* 272px */
  --cell-h: 11.5rem; /* 184px */
  grid-template-rows: repeat(2, var(--cell-h));
  grid-auto-columns: var(--cell-w);
  grid-auto-flow: column dense;
  justify-content: start;
  align-content: start;
}

.pitch-range-input::-webkit-slider-thumb {
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

.pitch-range-input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 9999px;
  background: #e4e4e7;
  border: 1px solid #71717a;
  cursor: pointer;
}

.pitch-range-input::-webkit-slider-runnable-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}

.pitch-range-input::-moz-range-track {
  height: 3px;
  border-radius: 9999px;
  background: #3f3f46;
}
</style>


