import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch, type Ref } from 'vue'
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
import { sourceMsToVolumeTime } from '@/lib/clipEditor/volumeOverlay'
import { ENVELOPE_MIN_GAIN } from '@/lib/envelope'

export type ClipEditorProps = {
  open: boolean
  item?: LibraryItem | null
  clipId?: string | null
}

export function useClipEditorController(
  props: Readonly<ClipEditorProps>,
  emit: (e: 'close') => void,
  dialogEl: Ref<HTMLDivElement | null>,
  waveformEl: Ref<HTMLCanvasElement | null>
) {
  const preview = usePreviewStore()
  const project = useProjectStore()
  const library = useLibraryStore()
  const notifications = useNotificationsStore()
  const ui = useUiStore()
  const transport = useTransportStore()


  // Target-mode resolution is exhaustive and single-sourced in the composable.
  const itemRef = toRef(props, 'item')
  const clipIdRef = toRef(props, 'clipId')
  const {
    timelineClip,
    editorItem,
    editsExistingClip,
    editsSavedClipLibrary,
    editsSingleTimelineClip,
    editsTimelineClip,
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
    () => editsTimelineClip.value && !viewExpanded.value && volumeShapeDurationMs.value > 0
  )
  const volumeEditActive = computed(() => volumeEditMode.value && volumeShapeAvailable.value)

  // Reset is offered only while actively shaping a clip that has a non-flat draft.
  const canResetVolumeShape = computed(
    () => volumeShapeAvailable.value && !volumeShapeDraft.isFlat.value
  )
  function onResetVolumeShape(): void {
    volumeShapeDraft.reset(volumeShapeDurationMs.value)
  }


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

  // Region gate: flatten the current selection to silence/full with hard edges.
  const canGateSelection = computed(
    () => volumeShapeAvailable.value && hasPlaybackSelection.value
  )
  function onGateSelection(gain: number): void {
    if (!canGateSelection.value) return
    const ratio = warpDraft.draftEffectiveRatio.value
    const base = viewInMs.value
    const durMs = volumeShapeDurationMs.value
    const clampLocal = (sourceMs: number): number =>
      Math.max(0, Math.min(durMs, sourceMsToVolumeTime(sourceMs, base, ratio)))
    volumeShapeDraft.gateRange(clampLocal(selectionInMs.value), clampLocal(selectionEndMs.value), gain)
    if (!volumeEditMode.value) volumeEditMode.value = true
  }
  function onSilenceSelection(): void {
    onGateSelection(ENVELOPE_MIN_GAIN)
  }
  function onFullSelection(): void {
    onGateSelection(1)
  }


  // Dirty-state + save/crop affordances live in `useClipEditorDirtyState`.
  const {
    hasWarpPitchChanged,
    canSaveChanges,
    canApplyCrop,
    canSaveAsNew
  } = useClipEditorDirtyState({
    editsExistingClip: () => editsExistingClip.value,
    editsTimelineClip: () => editsTimelineClip.value,
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
    editsTimelineClip: () => editsTimelineClip.value,
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

  return {
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
    canResetVolumeShape,
    onResetVolumeShape,
    canGateSelection,
    onSilenceSelection,
    onFullSelection,
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
  }
}
