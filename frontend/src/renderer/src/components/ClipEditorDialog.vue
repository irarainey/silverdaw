<script setup lang="ts">
// Non-destructive clip editor shell. File-size exception: remaining code is composable orchestration.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch } from 'vue'
import { usePreviewStore } from '@/stores/previewStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'
import { effectiveClipDurationMs, useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { isWarpActive } from '@/lib/warp'
import { useClipEditorTarget } from '@/lib/clipEditor/useClipEditorTarget'
import { useClipEditorViewport } from '@/lib/clipEditor/useClipEditorViewport'
import { useClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'
import { useClipEditorDirtyState } from '@/lib/clipEditor/useClipEditorDirtyState'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'
import { useClipEditorWaveform } from '@/lib/clipEditor/useClipEditorWaveform'
import { useClipEditorPreview } from '@/lib/clipEditor/useClipEditorPreview'
import { useClipEditorCropHistory } from '@/lib/clipEditor/useClipEditorCropHistory'
import { useClipEditorSave } from '@/lib/clipEditor/useClipEditorSave'
import { useClipEditorCanvasInteraction } from '@/lib/clipEditor/useClipEditorCanvasInteraction'
import { useClipEditorKeyboard } from '@/lib/clipEditor/useClipEditorKeyboard'
import { useClipEditorTransport } from '@/lib/clipEditor/useClipEditorTransport'
import ClipEditorWarpPanel from '@/components/ClipEditorWarpPanel.vue'
import ClipEditorPitchPanel from '@/components/ClipEditorPitchPanel.vue'
import ClipEditorPlaybackControls from '@/components/ClipEditorPlaybackControls.vue'
import ClipEditorSelectionInfo from '@/components/ClipEditorSelectionInfo.vue'
import ClipEditorViewControls from '@/components/ClipEditorViewControls.vue'
import ClipEffectModule from '@/components/ClipEffectModule.vue'

const props = defineProps<{
  open: boolean
  item?: LibraryItem | null
  clipId?: string | null
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const preview = usePreviewStore()
const project = useProjectStore()
const library = useLibraryStore()
const notifications = useNotificationsStore()
const ui = useUiStore()
const transport = useTransportStore()

const dialogEl = ref<HTMLDivElement | null>(null)
const waveformEl = ref<HTMLCanvasElement | null>(null)

// Target-mode resolution is exhaustive and single-sourced in the composable.
const itemRef = toRef(props, 'item')
const clipIdRef = toRef(props, 'clipId')
const {
  timelineClip,
  editorItem,
  editsExistingClip,
  editsSavedClipLibrary,
  editsSingleTimelineClip,
  titleText,
  sourceItem,
  sourceDurationMs,
  sourceBpm,
  sourceKey
} = useClipEditorTarget(itemRef, clipIdRef)

// Draft warp + pitch state reseeded on each target switch.
const warpDraft = useClipEditorWarpDraft(sourceBpm)
const {
  draftTempoEnabled,
  draftMode,
  draftTempoPinned,
  draftPinnedBpm,
  draftSemitones,
  draftCents,
  draftTempoWarpActive,
  draftProcessorEnabled,
  tempoRatioFromPinnedBpm,
  previewTempoRatio,
  initialise: initialiseWarpDraft
} = warpDraft

// Draft gain-envelope state; Save commits, Cancel discards.
const volumeShapeDraft = useClipEditorVolumeShapeDraft()
const {
  hasChanged: hasVolumeShapeChanged,
  initialise: initialiseVolumeShapeDraft,
  committedPoints: volumeShapeCommittedPoints
} = volumeShapeDraft

// Volume mode edits the gain envelope instead of the selection in Clip view.
const volumeEditMode = ref(false)

// Last rendered lane layout; pointer hit-testing must match drawn geometry.
const waveformStereoLanes = ref(false)

// Volume-shape span uses the same post-warp ms basis persisted by the backend.
const volumeShapeDurationMs = computed(() => {
  const clip = timelineClip.value
  if (!clip) return 0
  return effectiveClipDurationMs(clip)
})

const volumeShapeAvailable = computed(
  () => editsSingleTimelineClip.value && !viewExpanded.value && volumeShapeDurationMs.value > 0
)
const volumeEditActive = computed(() => volumeEditMode.value && volumeShapeAvailable.value)


const warpActive = computed(() => {
  const entry = editorItem.value
  if (!entry) return false
  if (editsExistingClip.value) return draftTempoWarpActive.value
  return isWarpActive({
    warpEnabled: entry.warpEnabled,
    tempoRatio: entry.tempoRatio,
    sourceBpm: sourceBpm.value,
    projectBpm: transport.bpm
  })
})

// Viewport math and bounds live in `useClipEditorViewport`.
const viewport = useClipEditorViewport({
  editorItem,
  editsExistingClip,
  timelineClip,
  sourceDurationMs,
  uiZoomPxPerSecond: toRef(ui, 'zoomPxPerSecond')
})
const {
  viewExpanded,
  cropViewInMs,
  cropViewDurationMs,
  selectionInMs,
  selectionDurationMs,
  zoom,
  scrollMs,
  canvasCssWidth,
  viewInMs,
  viewDurationMs,
  viewEndMs,
  basePxPerMs: _basePxPerMs,
  visibleDurationMs,
  maxScrollMs,
  visibleInMs,
  visibleEndMs,
  zoomPercent,
  selectionEndMs,
  hasPlaybackSelection,
  playbackStartMs,
  playbackEndMs,
  resetZoom,
  setZoomAnchored,
  zoomIn,
  zoomOut
} = viewport
void _basePxPerMs


// Dirty-state + save/crop affordances live in `useClipEditorDirtyState`.
const {
  hasWarpPitchChanged,
  canSaveChanges,
  canApplyCrop,
  canSaveAsNew
} = useClipEditorDirtyState({
  editsExistingClip: () => editsExistingClip.value,
  editsSingleTimelineClip: () => editsSingleTimelineClip.value,
  timelineClip: () => timelineClip.value,
  editorItem: () => editorItem.value,
  sourceItem: () => sourceItem.value,
  selectionInMs: () => selectionInMs.value,
  selectionDurationMs: () => selectionDurationMs.value,
  selectionEndMs: () => selectionEndMs.value,
  cropViewInMs: () => cropViewInMs.value,
  cropViewDurationMs: () => cropViewDurationMs.value,
  draftTempoEnabled: () => draftTempoEnabled.value,
  draftMode: () => draftMode.value,
  draftTempoPinned: () => draftTempoPinned.value,
  draftPinnedBpm: () => draftPinnedBpm.value,
  draftSemitones: () => draftSemitones.value,
  draftCents: () => draftCents.value,
  hasVolumeShapeChanged: () => hasVolumeShapeChanged.value,
  sourceBpm: () => sourceBpm.value,
  projectBpm: () => transport.bpm
})

const playheadAbsMs = computed(() => viewInMs.value + preview.positionMs)

const loopEnabled = ref(false)

// Preview scheduling lives in a composable; the SFC keeps watcher timing.
const {
  clearPreviewWarpUpdateTimer,
  scheduleDraftPreviewWarp,
  clearPreviewEnvelopeUpdateTimer,
  scheduleDraftPreviewEnvelope,
  autoFollowPlayhead,
  enforceSelectionPlaybackBounds,
  loadPreviewForView,
  resetPreviewLoadKey
} = useClipEditorPreview({
  preview,
  isOpen: () => props.open,
  editorItem: () => editorItem.value,
  timelineClip: () => timelineClip.value,
  sourceItem: () => sourceItem.value,
  editsExistingClip: () => editsExistingClip.value,
  libraryById: () => library.byId,
  projectBpm: () => transport.bpm,
  draftProcessorEnabled: () => draftProcessorEnabled.value,
  draftMode: () => draftMode.value,
  draftSemitones: () => draftSemitones.value,
  draftCents: () => draftCents.value,
  previewTempoRatio,
  committedEnvelopePoints: volumeShapeCommittedPoints,
  viewInMs: () => viewInMs.value,
  viewDurationMs: () => viewDurationMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  playheadAbsMs: () => playheadAbsMs.value,
  scrollMs,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  playbackStartMs: () => playbackStartMs.value,
  playbackEndMs: () => playbackEndMs.value,
  loopEnabled: () => loopEnabled.value
})

watch(
  () => props.open,
  async (open) => {
    ui.clipEditorOpen = open
    if (open) {
      viewExpanded.value = false
      resetZoom()
      initSelectionForItem()
      initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
      initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
      volumeEditMode.value = false
      loopEnabled.value = false
      resetHiResRequestKey()
      resetCropHistory()
      library.setEditorHiResPeaks(null)
      await nextTick()
      if (waveformEl.value) {
        canvasCssWidth.value = waveformEl.value.getBoundingClientRect().width
      }
      drawWaveform()
      dialogEl.value?.focus()
      loadPreviewForView()
    } else {
      clearPreviewWarpUpdateTimer()
      clearPreviewEnvelopeUpdateTimer()
      preview.unload()
      resetPreviewLoadKey()
      library.setEditorHiResPeaks(null)
      resetHiResRequestKey()
      resetCropHistory()
    }
  }
)

watch(
  [() => props.item?.id, () => props.clipId],
  () => {
    if (!props.open) return
    viewExpanded.value = false
    volumeEditMode.value = false
    resetZoom()
    resetPreviewLoadKey()
    initSelectionForItem()
    initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
    initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
    resetHiResRequestKey()
    resetCropHistory()
    library.setEditorHiResPeaks(null)
    drawWaveform()
    loadPreviewForView()
  }
)

watch(
  [draftTempoEnabled, draftMode, draftTempoPinned, draftPinnedBpm, draftSemitones, draftCents],
  () => {
    scheduleDraftPreviewWarp()
  }
)

// Draft point ref is reassigned per edit, so a shallow watch is enough.
watch(
  () => volumeShapeDraft.draftPoints.value,
  () => {
    scheduleDraftPreviewEnvelope()
    drawWaveform()
  }
)

watch(volumeEditActive, () => {
  drawWaveform()
})

// Re-push envelope after async PREVIEW_LOAD so preview matches latest draft.
watch(
  () => preview.isLoaded,
  (loaded, prev) => {
    if (!loaded || loaded === prev) return
    if (!props.open || !editsExistingClip.value) return
    preview.setEnvelope(volumeShapeCommittedPoints())
  }
)

// Switching Source/Clip view resets bounds, zoom, preview, and keeps selection visible.
watch(viewExpanded, async (expanded) => {
  if (expanded) {
    // Source view has no envelope-edit overlay.
    volumeEditMode.value = false
  }
  if (!expanded) {
    // Snap cropped view to selection when one exists.
    viewport.snapCropViewToSelection()
  }
  resetZoom()
  scrollMs.value = 0
  await nextTick()
  if (expanded) {
    // Centre long sources on the selection when reset zoom starts elsewhere.
    const selMid = (selectionInMs.value + selectionEndMs.value) / 2 - viewInMs.value
    const visLeft = scrollMs.value
    const visRight = visLeft + visibleDurationMs.value
    if (selMid < visLeft || selMid > visRight) {
      const target = selMid - visibleDurationMs.value / 2
      scrollMs.value = Math.max(0, Math.min(maxScrollMs.value, target))
    }
  }
  drawWaveform()
  loadPreviewForView()
})

watch(
  [() => preview.positionMs, () => preview.isPlaying],
  () => {
    enforceSelectionPlaybackBounds()
    autoFollowPlayhead()
    drawWaveform()
  }
)

watch(
  [
    selectionInMs,
    selectionDurationMs,
    cropViewInMs,
    cropViewDurationMs,
    zoom,
    scrollMs,
    canvasCssWidth,
    () => ui.zoomPxPerSecond,
    () => ui.waveformDisplayMode,
    () => library.editorHiResPeaks
  ],
  () => {
    drawWaveform()
  }
)

// endedCount is the reliable loop restart signal after natural preview end.
watch(
  () => preview.endedCount,
  (n, prev) => {
    if (n === prev) return
    if (!editorItem.value) return
    const looping = loopEnabled.value && (hasPlaybackSelection.value || editsExistingClip.value)
    if (!looping) return
    const startRel = Math.max(0, playbackStartMs.value - viewInMs.value)
    preview.seek(startRel)
    preview.play()
  }
)

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  // Track canvas CSS width across dialog resizes.
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const w = entry.contentRect.width
      if (w > 0 && Math.abs(w - canvasCssWidth.value) > 0.5) {
        canvasCssWidth.value = w
      }
    })
  }
  // Capture local undo/redo before menu accelerators, regardless of focus.
  window.addEventListener('keydown', onWindowKeydownCapture, { capture: true })
})

watch(
  () => waveformEl.value,
  (el) => {
    if (!resizeObserver) return
    resizeObserver.disconnect()
    if (el) {
      resizeObserver.observe(el)
      canvasCssWidth.value = el.getBoundingClientRect().width
    }
  }
)

onBeforeUnmount(() => {
  ui.clipEditorOpen = false
  clearPreviewWarpUpdateTimer()
  clearPreviewEnvelopeUpdateTimer()
  preview.unload()
  window.removeEventListener('keydown', onWindowKeydownCapture, { capture: true })
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})

function initSelectionForItem(): void {
  viewport.initialiseForItem()
}


// Waveform renderer writes lane layout back for pointer hit-testing.
const { drawWaveform, ensureEditorHiResPeaks, resetHiResRequestKey } = useClipEditorWaveform({
  getCanvas: () => waveformEl.value,
  sourceItem: () => sourceItem.value,
  sourceDurationMs: () => sourceDurationMs.value,
  zoom: () => zoom.value,
  visibleInMs: () => visibleInMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  visibleEndMs: () => visibleEndMs.value,
  viewInMs: () => viewInMs.value,
  viewEndMs: () => viewEndMs.value,
  selectionInMs: () => selectionInMs.value,
  selectionEndMs: () => selectionEndMs.value,
  selectionDurationMs: () => selectionDurationMs.value,
  editsExistingClip: () => editsExistingClip.value,
  playheadAbsMs: () => playheadAbsMs.value,
  volumeShapeAvailable: () => volumeShapeAvailable.value,
  volumeEditActive: () => volumeEditActive.value,
  volumeShapeDurationMs: () => volumeShapeDurationMs.value,
  draftPoints: () => volumeShapeDraft.draftPoints.value,
  draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
  editorHiResPeaks: () => library.editorHiResPeaks,
  channelPeaksByItemId: () => library.channelPeaksByItemId,
  waveformDisplayMode: () => ui.waveformDisplayMode,
  waveformStereoLanes
})

watch(zoom, () => ensureEditorHiResPeaks())

const {
  onCanvasMouseDown,
  onCanvasContextMenu,
  onCanvasWheel,
  onScrollbarMouseDown,
  nudgePlayhead,
  extendSelection,
  clearSelection
} = useClipEditorCanvasInteraction({
  getCanvas: () => waveformEl.value,
  preview,
  volumeShapeDraft,
  selectionInMs,
  selectionDurationMs,
  scrollMs,
  waveformStereoLanes,
  viewInMs: () => viewInMs.value,
  viewEndMs: () => viewEndMs.value,
  viewDurationMs: () => viewDurationMs.value,
  visibleInMs: () => visibleInMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  selectionEndMs: () => selectionEndMs.value,
  maxScrollMs: () => maxScrollMs.value,
  playheadAbsMs: () => playheadAbsMs.value,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  volumeEditActive: () => volumeEditActive.value,
  volumeShapeDurationMs: () => volumeShapeDurationMs.value,
  draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
  sourceItem: () => sourceItem.value,
  zoom: () => zoom.value,
  setZoomAnchored
})

const { onTogglePlay, onSkipToStart, onSkipToEnd, onToggleLoop } = useClipEditorTransport({
  preview,
  loopEnabled,
  scrollMs,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  editsExistingClip: () => editsExistingClip.value,
  playbackStartMs: () => playbackStartMs.value,
  playbackEndMs: () => playbackEndMs.value,
  viewInMs: () => viewInMs.value,
  visibleDurationMs: () => visibleDurationMs.value,
  maxScrollMs: () => maxScrollMs.value
})


// Dialog-local crop history is non-destructive and discarded on close.
const { onApplyCrop, undoCropLocal, redoCropLocal, resetCropHistory } =
  useClipEditorCropHistory({
    canApplyCrop: () => canApplyCrop.value,
    captureCropSnapshot: () => viewport.captureCropSnapshot(),
    restoreCropSnapshot: (snap) => viewport.restoreCropSnapshot(snap),
    cropViewInMs,
    cropViewDurationMs,
    selectionInMs: () => selectionInMs.value,
    selectionDurationMs: () => selectionDurationMs.value,
    resetZoom,
    redraw: () => drawWaveform(),
    reloadPreview: () => loadPreviewForView()
  })
const { onSaveChanges, onSaveAsNew } = useClipEditorSave({
  project,
  library,
  notifications,
  close: () => emit('close'),
  editorItem: () => editorItem.value,
  timelineClip: () => timelineClip.value,
  sourceItem: () => sourceItem.value,
  titleText: () => titleText.value,
  editsSingleTimelineClip: () => editsSingleTimelineClip.value,
  editsSavedClipLibrary: () => editsSavedClipLibrary.value,
  hasWarpPitchChanged: () => hasWarpPitchChanged.value,
  sourceBpm: () => sourceBpm.value,
  projectBpm: () => transport.bpm,
  canApplyCrop: () => canApplyCrop.value,
  selectionInMs: () => selectionInMs.value,
  selectionDurationMs: () => selectionDurationMs.value,
  cropViewInMs: () => cropViewInMs.value,
  cropViewDurationMs: () => cropViewDurationMs.value,
  draftSemitones: () => draftSemitones.value,
  draftCents: () => draftCents.value,
  draftTempoEnabled: () => draftTempoEnabled.value,
  draftMode: () => draftMode.value,
  draftTempoPinned: () => draftTempoPinned.value,
  tempoRatioFromPinnedBpm: () => tempoRatioFromPinnedBpm(),
  volumeShapeCommittedPoints: () => volumeShapeCommittedPoints()
})

const { onKeydown, onWindowKeydownCapture } = useClipEditorKeyboard({
  isOpen: () => props.open,
  hasPlaybackSelection: () => hasPlaybackSelection.value,
  close: () => emit('close'),
  clearSelection,
  extendSelection,
  nudgePlayhead,
  togglePlay: onTogglePlay,
  toggleLoop: onToggleLoop,
  zoomIn,
  zoomOut,
  resetZoom,
  undoCropLocal,
  redoCropLocal
})

window.addEventListener('resize', drawWaveform)
onBeforeUnmount(() => window.removeEventListener('resize', drawWaveform))
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
                :edits-single-timeline-clip="editsSingleTimelineClip"
                :edits-existing-clip="editsExistingClip"
                :can-apply-crop="canApplyCrop"
                :zoom="zoom"
                :zoom-percent="zoomPercent"
                @apply-crop="onApplyCrop"
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


