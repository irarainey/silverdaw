import { computed, nextTick, onBeforeUnmount, onMounted, ref, toRef, watch, type Ref } from 'vue'
import { usePreviewStore } from '@/stores/previewStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import { useUiStore } from '@/stores/uiStore'
import { useTransportStore } from '@/stores/transportStore'
import { useBrakeSettingsStore } from '@/stores/brakeSettingsStore'
import { useBackspinSettingsStore } from '@/stores/backspinSettingsStore'
import { effectiveClipDurationMs, useProjectStore } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { isWarpActive } from '@/lib/warp'
import { useClipEditorTarget } from '@/lib/clipEditor/useClipEditorTarget'
import { useClipEditorViewport } from '@/lib/clipEditor/useClipEditorViewport'
import { useClipEditorWarpDraft } from '@/lib/clipEditor/useClipEditorWarpDraft'
import { useClipEditorDirtyState } from '@/lib/clipEditor/useClipEditorDirtyState'
import { useClipEditorVolumeShapeDraft } from '@/lib/clipEditor/useClipEditorVolumeShapeDraft'
import { useClipEditorSliceDraft } from '@/lib/clipEditor/useClipEditorSliceDraft'
import { useClipEditorReverseDraft } from '@/lib/clipEditor/useClipEditorReverseDraft'
import { useClipEditorDjEffectDraft } from '@/lib/clipEditor/useClipEditorDjEffectDraft'
import { useClipEditorWaveform } from '@/lib/clipEditor/useClipEditorWaveform'
import { useClipEditorPreview } from '@/lib/clipEditor/useClipEditorPreview'
import { useClipEditorCropHistory } from '@/lib/clipEditor/useClipEditorCropHistory'
import { useClipEditorSave } from '@/lib/clipEditor/useClipEditorSave'
import { useClipEditorCanvasInteraction } from '@/lib/clipEditor/useClipEditorCanvasInteraction'
import { useClipEditorBeatGrid } from '@/lib/clipEditor/useClipEditorBeatGrid'
import { useClipEditorKeyboard } from '@/lib/clipEditor/useClipEditorKeyboard'
import { useClipEditorTransport } from '@/lib/clipEditor/useClipEditorTransport'
import { useClipEditorVolumeRegion } from '@/lib/clipEditor/useClipEditorVolumeRegion'

export type ClipEditorProps = {
  open: boolean
  item?: LibraryItem | null
  clipId?: string | null
}

export function useClipEditorController(
  props: Readonly<ClipEditorProps>,
  emit: (e: 'close') => void,
  dialogEl: Ref<HTMLDivElement | null>,
  waveformHost: Ref<HTMLDivElement | null>
) {
  const preview = usePreviewStore()
  const project = useProjectStore()
  const library = useLibraryStore()
  const notifications = useNotificationsStore()
  const ui = useUiStore()
  const transport = useTransportStore()
  const brakeSettings = useBrakeSettingsStore()
  const backspinSettings = useBackspinSettingsStore()


  // Target-mode resolution is exhaustive and single-sourced in the composable.
  const itemRef = toRef(props, 'item')
  const clipIdRef = toRef(props, 'clipId')
  const {
    timelineClip,
    editorItem,
    editsExistingClip,
    editsLibraryClipLibrary,
    editsSingleTimelineClip,
    editsTimelineClip,
    titleText,
    sourceItem,
    sourceDurationMs,
    sourceBpm,
    sourceKey
  } = useClipEditorTarget(itemRef, clipIdRef)

  // Source BPM as seen by the WARP/tempo controls only. Samples are committed,
  // free-form audio: they expose no source tempo to warp, so the tempo control
  // offers only free Stretch % (Follow/Pin need a source BPM). The beat grid still
  // uses the item's real BPM (via `sourceItem`), so beat markers are unaffected.
  const warpSourceBpm = computed(() =>
    editorItem.value?.kind === 'sample' ? undefined : sourceBpm.value
  )

  // Draft warp + pitch state reseeded on each target switch.
  const warpDraft = useClipEditorWarpDraft(warpSourceBpm)
  // Manual-tempo fallback: pin a BPM + slide the grid to align it.
  const beatGrid = useClipEditorBeatGrid({ sourceItem: () => sourceItem.value })
  const {
    draftTempoEnabled,
    draftMode,
    draftTempoMode,
    draftPinnedBpm,
    draftStretchPercent,
    draftSemitones,
    draftCents,
    draftTempoWarpActive,
    draftProcessorEnabled,
    resolveManualRatio,
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

  // Draft reverse-playback flag; Save commits, Cancel discards.
  const reverseDraft = useClipEditorReverseDraft()
  const { hasChanged: hasReverseChanged, initialise: initialiseReverseDraft } = reverseDraft

  // Draft turntable-effect flags (brake / backspin); Save commits, Cancel discards.
  // Both are tail effects available on any placed timeline clip (and, like reverse,
  // propagate across linked saved-clip siblings on commit). Reverse
  // and the two tail effects are mutually exclusive as a group (the engine can't
  // compose a pitch-changing record-stop with backwards playback), so each toolbar
  // toggle stays visible but is disabled while any other is set — turn that one off
  // first. Brake and backspin are likewise mutually exclusive with each other.
  const djEffectDraft = useClipEditorDjEffectDraft()
  const { hasChanged: hasDjEffectChanged, initialise: initialiseDjEffectDraft } = djEffectDraft

  // Reverse is a per-clip flag available for any placed timeline clip (linked or
  // not); linked edits propagate to the shared saved clip and all its instances.
  const reverseAvailable = computed(() => editsTimelineClip.value)
  const reverseActive = computed(() => reverseDraft.reversed.value)
  function onToggleReverse(): void {
    if (!reverseAvailable.value) return
    // Reverse is mutually exclusive with the turntable tail effects; turn the
    // active one off first (the button is disabled while one is set).
    if (djEffectDraft.brake.value || djEffectDraft.backspin.value) return
    reverseDraft.toggle()
  }

  const djEffectAvailable = computed(() => editsTimelineClip.value)
  const brakeActive = computed(() => djEffectDraft.brake.value)
  const backspinActive = computed(() => djEffectDraft.backspin.value)
  function onToggleBrake(): void {
    if (!djEffectAvailable.value || reverseDraft.reversed.value) return
    djEffectDraft.toggleBrake()
  }
  function onToggleBackspin(): void {
    if (!djEffectAvailable.value || reverseDraft.reversed.value) return
    djEffectDraft.toggleBackspin()
  }

  // Last rendered lane layout; pointer hit-testing must match drawn geometry.
  const waveformStereoLanes = ref(false)

  // Volume-shape span uses the same post-warp ms basis persisted by the backend.
  const volumeShapeDurationMs = computed(() => {
    const clip = timelineClip.value
    if (!clip) return 0
    return effectiveClipDurationMs(clip)
  })


  const warpActive = computed(() => {
    const entry = editorItem.value
    if (!entry) return false
    if (editsExistingClip.value) return draftTempoWarpActive.value
    return isWarpActive({
      warpEnabled: entry.warpEnabled,
      tempoRatio: entry.tempoRatio,
      sourceBpm: warpSourceBpm.value,
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

  // Volume-region edit mode + selection gate/reset actions live in a focused unit.
  const {
    volumeEditMode,
    volumeShapeAvailable,
    volumeEditActive,
    canResetVolumeShape,
    onResetVolumeShape,
    canGateSelection,
    onSilenceSelection,
    onFullSelection
  } = useClipEditorVolumeRegion({
    editsTimelineClip: () => editsTimelineClip.value,
    viewExpanded,
    volumeShapeDurationMs: () => volumeShapeDurationMs.value,
    volumeShapeDraft,
    hasPlaybackSelection: () => hasPlaybackSelection.value,
    draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
    viewInMs: () => viewInMs.value,
    selectionInMs: () => selectionInMs.value,
    selectionEndMs: () => selectionEndMs.value
  })

  // Loop-slice draft (markers in source-absolute ms). Slice and Volume are
  // mutually exclusive canvas modes; slicing acts on a placed timeline clip's
  // source window in the cropped Clip view.
  const sliceDraft = useClipEditorSliceDraft()
  const sliceEditMode = ref(false)
  const sliceAvailable = computed(() => editsTimelineClip.value)
  const sliceEditActive = computed(
    () => sliceEditMode.value && sliceAvailable.value && !viewExpanded.value
  )
  const sliceCount = computed(() => sliceDraft.markers.value.length)

  function reseedSliceWindow(): void {
    const clip = timelineClip.value
    if (clip) sliceDraft.initialise(clip.inMs, clip.durationMs)
    else sliceDraft.initialise(0, 0)
  }

  function onGenerateSliceGrid(): void {
    reseedSliceWindow()
    const src = sourceItem.value
    sliceDraft.generateToGrid(src?.bpm, src?.beatAnchorSec ?? src?.beats?.[0])
    if (sliceDraft.markers.value.length === 0) {
      notifications.pushInfo('No beat grid available to slice on — drag markers by hand.')
    }
  }

  function onSliceToTimeline(): void {
    const clip = timelineClip.value
    if (!clip) return
    const markers = sliceDraft.committedMarkers()
    if (markers.length === 0) {
      notifications.pushError('Add slice markers first — drag on the waveform or generate a grid.')
      return
    }
    const made = project.sliceClipToTimeline(clip.id, markers)
    if (made > 0) {
      notifications.pushInfo(`Sliced into ${made + 1} clips.`)
      emit('close')
    }
  }

  function onSliceToSamples(): void {
    const clip = timelineClip.value
    if (!clip) return
    const markers = sliceDraft.committedMarkers()
    if (markers.length === 0) {
      notifications.pushError('Add slice markers first — drag on the waveform or generate a grid.')
      return
    }
    const n = project.sliceClipToSamples(clip.id, markers)
    if (n > 0) notifications.pushInfo(`Saving ${n} samples…`)
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
    draftTempoMode: () => draftTempoMode.value,
    draftPinnedBpm: () => draftPinnedBpm.value,
    draftStretchPercent: () => draftStretchPercent.value,
    draftSemitones: () => draftSemitones.value,
    draftCents: () => draftCents.value,
    hasVolumeShapeChanged: () => hasVolumeShapeChanged.value,
    hasReverseChanged: () => hasReverseChanged.value,
    hasDjEffectChanged: () => hasDjEffectChanged.value,
    hasGridChanged: () => beatGrid.hasGridChanged(),
    sourceBpm: () => warpSourceBpm.value,
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
    pushDraftPreviewReversed,
    pushDraftPreviewBrake,
    pushDraftPreviewBackspin,
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
    draftReversed: () => reverseDraft.reversed.value,
    draftBrake: () => djEffectDraft.brake.value,
    draftBackspin: () => djEffectDraft.backspin.value,
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
        initialiseReverseDraft(timelineClip.value)
        initialiseDjEffectDraft(timelineClip.value)
        volumeEditMode.value = false
        sliceEditMode.value = false
        reseedSliceWindow()
        loopEnabled.value = false
        resetHiResRequestKey()
        resetCropHistory()
        library.setEditorHiResPeaks(null)
        await nextTick()
        const host = waveformHost.value
        if (host) {
          await mountScene(host)
          canvasCssWidth.value = host.getBoundingClientRect().width
        }
        drawWaveform()
        startPlayheadRaf()
        dialogEl.value?.focus()
        loadPreviewForView()
      } else {
        stopPlayheadRaf()
        clearPreviewWarpUpdateTimer()
        clearPreviewEnvelopeUpdateTimer()
        preview.unload()
        resetPreviewLoadKey()
        library.setEditorHiResPeaks(null)
        resetHiResRequestKey()
        resetCropHistory()
        unmountScene()
      }
    }
  )

  watch(
    [() => props.item?.id, () => props.clipId],
    () => {
      if (!props.open) return
      viewExpanded.value = false
      volumeEditMode.value = false
      sliceEditMode.value = false
      reseedSliceWindow()
      resetZoom()
      resetPreviewLoadKey()
      initSelectionForItem()
      initialiseWarpDraft(timelineClip.value ?? editorItem.value, editsExistingClip.value)
      initialiseVolumeShapeDraft(timelineClip.value, volumeShapeDurationMs.value)
      initialiseReverseDraft(timelineClip.value)
      initialiseDjEffectDraft(timelineClip.value)
      resetHiResRequestKey()
      resetCropHistory()
      library.setEditorHiResPeaks(null)
      drawWaveform()
      loadPreviewForView()
    }
  )

  watch(
    [draftTempoEnabled, draftMode, draftTempoMode, draftPinnedBpm, draftStretchPercent, draftSemitones, draftCents],
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

  // Slice mode and Volume mode are mutually exclusive; turning one on clears the
  // other. Reseed the slice window when entering, and clear stale markers on exit.
  watch(volumeEditMode, (on) => {
    if (on) sliceEditMode.value = false
  })
  watch(sliceEditMode, (on) => {
    if (on) {
      volumeEditMode.value = false
      reseedSliceWindow()
    } else {
      sliceDraft.clear()
    }
    drawWaveform()
  })
  // Marker ref is reassigned per edit, so a shallow watch is enough.
  watch(() => sliceDraft.markers.value, () => drawWaveform())

  // Sliding the beat grid (or applying a manual BPM) mutates the source item's
  // anchor/tempo locally; redraw so the grid markers track the pointer live
  // instead of only snapping into place on pointer release.
  watch(
    [() => sourceItem.value?.beatAnchorSec, () => sourceItem.value?.bpm],
    () => {
      drawWaveform()
    }
  )

  // Reverse toggle → preview voice. Push immediately so the audition flips,
  // and redraw so the waveform mirrors to match the new state.
  watch(
    () => reverseDraft.reversed.value,
    (reversed) => {
      pushDraftPreviewReversed()
      // Reversed clips can't carry a brake/backspin tail (the toggles hide), so
      // clear the drafts to avoid persisting a hidden, ignored effect on Save.
      if (reversed) djEffectDraft.clear()
      drawWaveform()
    }
  )

  // Brake / backspin toggles → preview voice + waveform tail overlay. Single
  // toggles, pushed immediately; redraw so the overlay appears / clears.
  watch(
    () => djEffectDraft.brake.value,
    () => {
      pushDraftPreviewBrake()
      drawWaveform()
    }
  )
  watch(
    () => djEffectDraft.backspin.value,
    () => {
      pushDraftPreviewBackspin()
      drawWaveform()
    }
  )

  // Effect duration / curve come from a global preference; repaint the tail
  // overlay live if the user changes it while the editor is open.
  watch(
    [
      () => brakeSettings.seconds,
      () => brakeSettings.curvePower,
      () => backspinSettings.seconds,
      () => backspinSettings.curvePower
    ],
    () => {
      if (djEffectDraft.brake.value || djEffectDraft.backspin.value) drawWaveform()
    }
  )

  // Re-push envelope after async PREVIEW_LOAD so preview matches latest draft.
  watch(
    () => preview.isLoaded,
    (loaded, prev) => {
      if (!loaded || loaded === prev) return
      if (!props.open || !editsExistingClip.value) return
      preview.setEnvelope(volumeShapeCommittedPoints())
      preview.setReversed(reverseDraft.reversed.value)
      preview.setBrake(djEffectDraft.brake.value)
      preview.setBackspin(djEffectDraft.backspin.value)
    }
  )

  // Switching Source/Clip view resets bounds, zoom, preview, and keeps selection visible.
  watch(viewExpanded, async (expanded) => {
    if (expanded) {
      // Source view has no envelope-edit or slice overlay.
      volumeEditMode.value = false
      sliceEditMode.value = false
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

  // Playhead/scroll are painted on a per-frame rAF loop (vsync-aligned), mirroring
  // the timeline. Driving them off the discrete positionMs watcher instead repainted
  // at the backend tick cadence — off-vsync and irregular — which read as periodic
  // freeze/jitter. The helpers below early-return when paused, so the loop is cheap
  // while idle and Pixi already renders every frame regardless.
  let playheadRafId: number | null = null
  function startPlayheadRaf(): void {
    if (playheadRafId !== null) return
    const tick = (): void => {
      playheadRafId = requestAnimationFrame(tick)
      enforceSelectionPlaybackBounds()
      autoFollowPlayhead()
      applyScroll()
    }
    playheadRafId = requestAnimationFrame(tick)
  }
  function stopPlayheadRaf(): void {
    if (playheadRafId !== null) cancelAnimationFrame(playheadRafId)
    playheadRafId = null
  }

  watch(
    [
      selectionInMs,
      selectionDurationMs,
      cropViewInMs,
      cropViewDurationMs,
      zoom,
      canvasCssWidth,
      () => ui.zoomPxPerSecond,
      () => ui.waveformDisplayMode,
      () => library.editorHiResPeaks
    ],
    () => {
      drawWaveform()
    }
  )

  // Scroll (manual or auto-follow) is repainted by the per-frame rAF loop while the
  // editor is open, so no separate scrollMs watcher is needed.

  // endedCount is the reliable loop restart signal after natural preview end.
  watch(
    () => preview.endedCount,
    (n, prev) => {
      if (n === prev) return
      if (!editorItem.value) return
      // Loop the active window (selection or whole preview) for any editor item
      // when loop is enabled, so standalone library samples loop like clips.
      const looping = loopEnabled.value
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
    () => waveformHost.value,
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
    stopPlayheadRaf()
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
  const {
    drawWaveform,
    applyScroll,
    mountScene,
    unmountScene,
    getCanvas,
    ensureEditorHiResPeaks,
    resetHiResRequestKey
  } = useClipEditorWaveform({
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
    draftReversed: () => reverseDraft.reversed.value,
    draftBrake: () => djEffectDraft.brake.value,
    draftBackspin: () => djEffectDraft.backspin.value,
    brakeSeconds: () => brakeSettings.seconds,
    brakeCurvePower: () => brakeSettings.curvePower,
    backspinSeconds: () => backspinSettings.seconds,
    backspinCurvePower: () => backspinSettings.curvePower,
    sliceEditActive: () => sliceEditActive.value,
    sliceMarkers: () => sliceDraft.markers.value,
    editorHiResPeaks: () => library.editorHiResPeaks,
    channelPeaksByItemId: () => library.channelPeaksByItemId,
    waveformDisplayMode: () => ui.waveformDisplayMode,
    waveformStereoLanes,
    canvasCssWidth
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
    getCanvas: () => getCanvas(),
    preview,
    volumeShapeDraft,
    sliceDraft,
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
    sliceEditActive: () => sliceEditActive.value,
    volumeShapeDurationMs: () => volumeShapeDurationMs.value,
    draftEffectiveRatio: () => warpDraft.draftEffectiveRatio.value,
    sourceItem: () => sourceItem.value,
    zoom: () => zoom.value,
    gridAlignActive: () => beatGrid.alignActive.value,
    previewGridAnchorSec: (anchorSec: number) => beatGrid.previewAnchorSec(anchorSec),
    commitGridAnchorSec: (anchorSec: number) => beatGrid.commitAnchorSec(anchorSec),
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
  // ─── Clip Editor metronome ────────────────────────────────────────────────
  // Clicks on the clip's own beat grid (source BPM + phase anchor) during preview playback,
  // independent of the main-timeline metronome. Its enabled flag persists silently with the
  // project; the grid values are re-sent whenever the clip's tempo/anchor changes or the preview
  // (re)loads so the backend always clicks on the visible beats.
  const clipMetronomeEnabled = computed(() => project.clipEditorMetronomeEnabled)
  const currentGridBpm = (): number => sourceItem.value?.bpm ?? 0
  const currentGridAnchorSec = (): number =>
    sourceItem.value?.beatAnchorSec ?? sourceItem.value?.beats?.[0] ?? 0

  function onToggleClipMetronome(): void {
    project.setClipEditorMetronomeEnabled(
      !project.clipEditorMetronomeEnabled,
      currentGridBpm(),
      currentGridAnchorSec()
    )
  }

  // Keep the backend's click grid in sync with the clip's live tempo/anchor (and push once on
  // open so the backend has the grid + persisted enabled state before the first preview play).
  watch(
    [() => sourceItem.value?.bpm, () => sourceItem.value?.beatAnchorSec, () => sourceItem.value?.beats?.[0]],
    () => project.pushClipEditorMetronomeGrid(currentGridBpm(), currentGridAnchorSec()),
    { immediate: true }
  )

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
    editsLibraryClipLibrary: () => editsLibraryClipLibrary.value,
    editsTimelineClip: () => editsTimelineClip.value,
    hasWarpPitchChanged: () => hasWarpPitchChanged.value,
    sourceBpm: () => warpSourceBpm.value,
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
    draftTempoMode: () => draftTempoMode.value,
    resolveManualRatio: () => resolveManualRatio(),
    volumeShapeCommittedPoints: () => volumeShapeCommittedPoints(),
    reverseCommitted: () => reverseDraft.committed(),
    brakeCommitted: () => djEffectDraft.committedBrake(),
    backspinCommitted: () => djEffectDraft.committedBackspin()
  })

  const { onKeydown, onWindowKeydownCapture } = useClipEditorKeyboard({
    isOpen: () => props.open,
    hasPlaybackSelection: () => hasPlaybackSelection.value,
    canGateSelection: () => canGateSelection.value,
    silenceSelection: onSilenceSelection,
    fullSelection: onFullSelection,
    close: () => emit('close'),
    clearSelection,
    extendSelection,
    nudgePlayhead,
    togglePlay: onTogglePlay,
    toggleLoop: onToggleLoop,
    canToggleMetronome: () => editsExistingClip.value,
    toggleMetronome: onToggleClipMetronome,
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
    sliceSubdivision: sliceDraft.subdivision,
    sliceCount,
    onGenerateSliceGrid,
    onSliceToTimeline,
    onSliceToSamples,
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
  }
}
