// Inline clip-name rename, extracted from TimelineView.vue. Double-clicking a
// clip's title strip floats an HTML <input> over the drawn header pixels;
// Enter / click-outside commits via `project.renameClip`, Escape cancels. The
// overlay position is computed reactively from the clip geometry + current
// scroll/zoom so it tracks the clip while the user scrolls during the edit.
//
// The SFC keeps ownership of the `renamingClipId` watch that adds/removes the
// capture-phase document listeners (preserving listener identity); this module
// supplies the handlers and the rename state.
import { computed, nextTick, ref, type ComputedRef, type Ref } from 'vue'
import {
  effectiveClipDurationMs,
  isClipTempoWarpActive,
  useProjectStore
} from '@/stores/projectStore'
import {
  libraryItemDisplayName,
  libraryItemSourceBpm,
  useLibraryStore
} from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { isWarpPending } from '@/lib/warp'
import { trackTopWorldYAt } from '@/lib/timeline/trackLayout'

/** Must mirror the HEADER_H used inside `useTimelineDrawing.drawClipHeader`. */
export const CLIP_HEADER_H = 18
const CLIP_HEADER_PAD_X = 4
const CLIP_HEADER_APPROX_CHAR_W = 6
const CLIP_HEADER_LINK_BADGE_W = 18
const CLIP_HEADER_WARP_PENDING_BADGE_W = 18
const CLIP_HEADER_WARP_ACTIVE_BADGE_W = 42

export interface ClipRenameDeps {
  // World-space header column width (viewport-relative origin for clips).
  headerWidth: () => number
  // Current zoom in pixels-per-second.
  pxPerSecond: () => number
  // Current horizontal / vertical scroll offsets, in viewport pixels.
  scrollX: () => number
  scrollY: () => number
}

export interface ClipRename {
  renamingClipId: Ref<string | null>
  renameValue: Ref<string>
  renameInputRef: Ref<HTMLInputElement | null>
  renameOverlayStyle: ComputedRef<Record<string, string> | null>
  startClipRename: (clipId: string) => void
  commitClipRename: () => void
  cancelClipRename: () => void
  onRenameDocumentKeyDown: (e: KeyboardEvent) => void
  onRenameDocumentPointerDown: (e: PointerEvent) => void
}

export function useClipRename(deps: ClipRenameDeps): ClipRename {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()

  const renamingClipId = ref<string | null>(null)
  const renameValue = ref('')
  const renameInputRef = ref<HTMLInputElement | null>(null)

  const renameOverlayStyle = computed<Record<string, string> | null>(() => {
    const id = renamingClipId.value
    if (!id) return null
    const clip = project.clips[id]
    if (!clip) return null
    const trackIndex = project.tracks.findIndex((t) => t.id === clip.trackId)
    if (trackIndex < 0) return null

    // World coords mirror `useTimelineDrawing` so the input lands exactly
    // on top of the drawn header strip.
    const absX = deps.headerWidth() + (clip.startMs / 1000) * deps.pxPerSecond()
    const rowWorldY = trackTopWorldYAt(project.tracks, trackIndex)
    const padding = 4
    const innerY = rowWorldY + padding
    const libItem = library.byId[clip.libraryItemId]
    const effectiveDurMs = effectiveClipDurationMs(clip)
    const clipWidthPx = (effectiveDurMs / 1000) * deps.pxPerSecond()
    const displayName = clip.name?.trim()
      ? clip.name
      : libItem ? libraryItemDisplayName(libItem) : clip.fileName
    const isLinked = libItem?.kind === 'saved-clip'
    const sourceBpm = libItem ? libraryItemSourceBpm(libItem, library.byId) : undefined
    const warpPending = isWarpPending({
      warpEnabled: clip.warpEnabled,
      tempoRatio: clip.tempoRatio,
      pendingAutoWarp: clip.pendingAutoWarp,
      sourceBpm,
      projectBpm: transport.bpm
    })
    const warpActive = !warpPending && isClipTempoWarpActive(clip)
    const badgeWidth =
      (isLinked ? CLIP_HEADER_LINK_BADGE_W : 0) +
      (warpPending ? CLIP_HEADER_WARP_PENDING_BADGE_W : warpActive ? CLIP_HEADER_WARP_ACTIVE_BADGE_W : 0)
    const naturalHeaderWidth =
      displayName.length * CLIP_HEADER_APPROX_CHAR_W + CLIP_HEADER_PAD_X * 2 + badgeWidth
    const widthPx = Math.max(120, Math.min(clipWidthPx, naturalHeaderWidth))

    // Convert to viewport pixels (relative to host).
    const left = absX - deps.scrollX()
    const top = innerY - deps.scrollY()

    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${widthPx}px`,
      height: `${CLIP_HEADER_H}px`
    }
  })

  function startClipRename(clipId: string): void {
    const clip = project.clips[clipId]
    if (!clip) return
    const libItem = library.items.find((i) => i.filePath === clip.filePath)
    const initial = clip.name?.trim()
      ? clip.name
      : libItem
        ? libraryItemDisplayName(libItem)
        : clip.fileName
    renamingClipId.value = clipId
    renameValue.value = initial
    void nextTick(() => {
      renameInputRef.value?.focus()
      renameInputRef.value?.select()
    })
  }

  function commitClipRename(): void {
    const id = renamingClipId.value
    if (!id) return
    project.renameClip(id, renameValue.value)
    renamingClipId.value = null
  }

  function cancelClipRename(): void {
    renamingClipId.value = null
  }

  function onRenameDocumentKeyDown(e: KeyboardEvent): void {
    if (!renamingClipId.value) return
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      commitClipRename()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelClipRename()
    }
  }

  function onRenameDocumentPointerDown(e: PointerEvent): void {
    if (!renamingClipId.value) return
    const inputEl = renameInputRef.value
    if (!inputEl) return
    if (e.target instanceof Node && inputEl.contains(e.target)) return
    commitClipRename()
  }

  return {
    renamingClipId,
    renameValue,
    renameInputRef,
    renameOverlayStyle,
    startClipRename,
    commitClipRename,
    cancelClipRename,
    onRenameDocumentKeyDown,
    onRenameDocumentPointerDown
  }
}
