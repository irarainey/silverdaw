<script setup lang="ts">
import { ref } from 'vue'
import ClipEditorWarpPanel from '@/components/ClipEditorWarpPanel.vue'
import ClipEditorPitchPanel from '@/components/ClipEditorPitchPanel.vue'
import ClipEditorPlaybackControls from '@/components/ClipEditorPlaybackControls.vue'
import ClipEditorSelectionInfo from '@/components/ClipEditorSelectionInfo.vue'
import ClipEditorViewControls from '@/components/ClipEditorViewControls.vue'
import ClipEffectModule from '@/components/ClipEffectModule.vue'
import { useClipEditorController, type ClipEditorProps } from '@/lib/clipEditor/useClipEditorController'

const props = defineProps<ClipEditorProps>()
const emit = defineEmits<{ (e: 'close'): void }>()

const dialogEl = ref<HTMLDivElement | null>(null)
const waveformEl = ref<HTMLCanvasElement | null>(null)

const {
  preview,
  transport,
  warpDraft,
  titleText,
  warpActive,
  loopEnabled,
  onSkipToStart,
  onTogglePlay,
  onSkipToEnd,
  onToggleLoop,
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
  viewExpanded,
  editsTimelineClip,
  editsExistingClip,
  canApplyCrop,
  canResetVolumeShape,
  onResetVolumeShape,
  zoom,
  onApplyCrop,
  zoomOut,
  resetZoom,
  zoomIn,
  sourceBpm,
  sourceKey,
  sourceItem,
  editorItem,
  canSaveChanges,
  editsSavedClipLibrary,
  onSaveChanges,
  canSaveAsNew,
  onSaveAsNew,
  onKeydown
} = useClipEditorController(props, emit, dialogEl, waveformEl)
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
        class="dialog-card h-[min(980px,96vh)] w-[min(1440px,98vw)]"
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
            </div>
            <p class="mt-0.5 truncate text-xs text-zinc-500">
              {{ sourceItem.fileName }}
            </p>
          </div>
          <ClipEditorPlaybackControls
            :is-playing="preview.isPlaying"
            :is-loaded="preview.isLoaded"
            :loop-enabled="loopEnabled"
            @skip-to-start="onSkipToStart"
            @toggle-play="onTogglePlay"
            @skip-to-end="onSkipToEnd"
            @toggle-loop="onToggleLoop"
          />
          <div class="justify-self-end" />
        </header>

        <div class="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
          <div class="flex min-w-0 flex-col gap-3">
            <canvas
              ref="waveformEl"
              class="h-[min(260px,26vh)] w-full rounded border border-zinc-800 bg-zinc-950"
              :class="volumeEditActive ? 'cursor-pointer' : 'cursor-crosshair'"
              @mousedown="onCanvasMouseDown"
              @contextmenu="onCanvasContextMenu"
              @wheel="onCanvasWheel"
            />
            <div
              class="relative h-2 w-full cursor-pointer rounded bg-zinc-900"
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
                v-model:view-expanded="viewExpanded"
                :edits-timeline-clip="editsTimelineClip"
                :edits-existing-clip="editsExistingClip"
                :can-apply-crop="canApplyCrop"
                :can-reset-volume="canResetVolumeShape"
                :zoom="zoom"
                :zoom-percent="zoomPercent"
                @apply-crop="onApplyCrop"
                @reset-volume="onResetVolumeShape"
                @zoom-out="zoomOut"
                @reset-zoom="resetZoom"
                @zoom-in="zoomIn"
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
                  :source-bpm="sourceBpm"
                  :project-bpm="transport.bpm"
                />
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
            </div>
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
            :title="editsSavedClipLibrary
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
            Save as New Clip
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


