// Transport controls for the clip-editor preview voice: play/pause,
// skip-to-start / skip-to-end (bounded by the active selection or the
// saved clip window) and the loop toggle. Extracted from
// ClipEditorDialog.vue so the SFC keeps shrinking; the preview store and
// all viewport-derived bounds are passed in.

import type { Ref } from 'vue'
import type { usePreviewStore } from '@/stores/previewStore'

type PreviewStore = ReturnType<typeof usePreviewStore>

export interface ClipEditorTransportDeps {
  preview: PreviewStore
  loopEnabled: Ref<boolean>
  scrollMs: Ref<number>
  hasPlaybackSelection: () => boolean
  editsExistingClip: () => boolean
  playbackStartMs: () => number
  playbackEndMs: () => number
  viewInMs: () => number
  visibleDurationMs: () => number
  maxScrollMs: () => number
}

export interface ClipEditorTransport {
  onTogglePlay: () => void
  onSkipToStart: () => void
  onSkipToEnd: () => void
  onToggleLoop: () => void
}

export function useClipEditorTransport(deps: ClipEditorTransportDeps): ClipEditorTransport {
  const { preview, loopEnabled, scrollMs } = deps

  function onTogglePlay(): void {
    if (!preview.isLoaded) return
    if (preview.isPlaying) {
      preview.pause()
      return
    }
    const hasSel = deps.hasPlaybackSelection()
    // Bound playback by the selection if narrowed, or by the full clip
    // when looping a saved clip with no selection.
    const bounded = hasSel || (deps.editsExistingClip() && loopEnabled.value)
    if (bounded) {
      const startRel = deps.playbackStartMs() - deps.viewInMs()
      const endRel = deps.playbackEndMs() - deps.viewInMs()
      const pos = preview.positionMs
      if (pos < startRel - 0.5 || pos >= endRel - 0.5) {
        preview.seek(Math.max(0, startRel))
      }
    }
    preview.play()
  }

  function onSkipToStart(): void {
    const rel = Math.max(0, deps.playbackStartMs() - deps.viewInMs())
    preview.seek(rel)
    // Scroll the canvas so the playhead's new position is visible.
    // Auto-follow only ever scrolls forward, so without this the
    // playhead would land off-screen to the left when scrolled in.
    if (rel < scrollMs.value) {
      scrollMs.value = rel
    }
  }

  function onSkipToEnd(): void {
    const end = Math.max(0, deps.playbackEndMs() - deps.viewInMs() - 1)
    preview.seek(end)
    // Ensure the end position is on-screen.
    const visDur = deps.visibleDurationMs()
    if (end > scrollMs.value + visDur) {
      scrollMs.value = Math.max(0, Math.min(deps.maxScrollMs(), end - visDur / 2))
    }
  }

  function onToggleLoop(): void {
    loopEnabled.value = !loopEnabled.value
  }

  return { onTogglePlay, onSkipToStart, onSkipToEnd, onToggleLoop }
}
