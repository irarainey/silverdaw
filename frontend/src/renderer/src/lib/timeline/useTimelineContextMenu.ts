// Clip context menu for the timeline. Owns:
//
// - the menu's open/position/target-clip refs,
// - the dynamic `items` builder (depends on project + library + transport
//   state to compute disabled flags, swatch selection, conditional rows),
// - the right-click hit-test against the timeline's clip hit regions,
// - the command dispatcher that turns the menu's emitted command
//   strings into store mutations / dialog opens / IPC calls.
//
// Decoupled from the host component so the items builder is
// unit-testable and so other surfaces could in principle reuse the
// same dispatcher. The DOM rect lookup in `onContextMenu` is the
// only piece that needs a real `<div>` ref at runtime; tests can
// exercise the items builder + dispatcher directly.

import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  effectiveClipDurationMs,
  TRACK_PALETTE,
  useProjectStore
} from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { trackIndexAtWorldY } from '@/lib/timeline/trackLayout'
import { makeLaneHeightOf } from '@/lib/automation/laneLayout'
import type { ClipHitRegion } from '@/lib/timeline/useDragHandlers'
import type { ClipContextMenuItem } from '@/lib/timeline/clipContextMenuTypes'
import { generateGridSlices, type SliceSubdivision } from '@/lib/clipEditor/loopSlice'
import type { ClipDialogActions } from '@/lib/timeline/useClipDialogs'
import { TRANSITION_RECIPES } from '@/lib/transitions/transitionRecipes'
import { requestStemSeparationForClip } from '@/lib/stems/stemSeparationFlow'
import { log } from '@/lib/log'

export type ChooseAudioFile = (args: {
  title?: string
  defaultPath?: string
}) => Promise<string | null>

export interface UseTimelineContextMenuInputs {
  /** The timeline host element. The hit-test uses it to convert
   *  pointer coords from page space to world (scroll-adjusted) space. */
  host: Ref<HTMLDivElement | null>
  scrollX: Ref<number>
  scrollY: Ref<number>
  /** Returns the latest hit-region array. We use a getter (rather
   *  than an array reference) so the array is read fresh on each
   *  right-click and the composable never holds onto a stale slice. */
  getClipHitRegions: () => readonly ClipHitRegion[]
  /** Width of the pinned track-header column, used to tell a right-click on the
   *  clip lane apart from one on the header controls. */
  headerWidth: () => number
  /** Right-click delete of an automation breakpoint; returns true if one was
   *  removed (so the context menu suppresses itself). */
  removeAutomationPointAt?: (clientX: number, clientY: number) => boolean
  /** Dialog open actions; injected so the menu doesn't depend on the
   *  full `useClipDialogs` return type. */
  dialogs: ClipDialogActions
  /** Audio-file picker for the Relink command. Injected so tests can
   *  stub it out. Defaults to `window.silverdaw.chooseAudioFile`. */
  chooseAudioFile?: ChooseAudioFile
  /** Starts stem separation for a clip (model-gating + dispatch). Injected so
   *  tests can stub it; defaults to the separation flow orchestrator. */
  startStemSeparation?: (clipId: string) => void
  /** Logger for picker / IPC failures. Defaults to `console.warn`. */
  onError?: (message: string, err: unknown) => void
}

export interface TimelineContextMenu {
  contextMenuOpen: Ref<boolean>
  contextMenuX: Ref<number>
  contextMenuY: Ref<number>
  contextMenuClipId: Ref<string | null>
  /** Track targeted by an empty-lane right-click (Paste menu); null otherwise. */
  contextMenuTrackId: Ref<string | null>
  contextMenuItems: ComputedRef<ClipContextMenuItem[]>
  onContextMenu(e: MouseEvent): void
  onContextMenuCommand(command: string): void
  onContextMenuClose(): void
}

const DEFAULT_CHOOSE_AUDIO_FILE: ChooseAudioFile = (args) => {
  const api = (globalThis as { silverdaw?: { chooseAudioFile: ChooseAudioFile } }).silverdaw
  if (!api) return Promise.resolve(null)
  return api.chooseAudioFile(args)
}

export function useTimelineContextMenu(
  inputs: UseTimelineContextMenuInputs
): TimelineContextMenu {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()

  const chooseAudioFile = inputs.chooseAudioFile ?? DEFAULT_CHOOSE_AUDIO_FILE
  const startStemSeparation =
    inputs.startStemSeparation ?? ((clipId: string): void => requestStemSeparationForClip(clipId))
  const onError =
    inputs.onError ??
    ((message: string, err: unknown): void => {
      log.warn('timeline', `${message}: ${err instanceof Error ? err.message : String(err)}`)
    })

  const contextMenuOpen = ref(false)
  const contextMenuX = ref(0)
  const contextMenuY = ref(0)
  const contextMenuClipId = ref<string | null>(null)
  const contextMenuTrackId = ref<string | null>(null)

  const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
    // Empty track-lane right-click: a Paste-only menu that drops the clipboard
    // clip onto that track at the playhead.
    if (!contextMenuClipId.value && contextMenuTrackId.value) {
      return [
        {
          command: 'track.paste',
          label: 'Paste',
          disabled: !project.clipboardClip
        }
      ]
    }
    const clip = contextMenuClipId.value ? project.clips[contextMenuClipId.value] : null
    const items: ClipContextMenuItem[] = []
    const clipParent = clip ? library.byId[clip.libraryItemId] : null
    if (clip?.unresolved) {
      items.push({ command: 'clip.relink', label: 'Relink' })
    }
    const hasLibraryItem = !!clipParent
    items.push({
      command: 'clip.openEditor',
      label: 'Open in Editor',
      disabled: !clip || clip.unresolved || !hasLibraryItem
    })
    items.push({
      command: 'clip.info',
      label: 'Show Information',
      disabled: !clip || clip.unresolved || !hasLibraryItem
    })
    items.push({ command: 'clip.cut', label: 'Cut', separatorAbove: true })
    items.push({ command: 'clip.copy', label: 'Copy' })
    items.push({
      command: 'clip.paste',
      label: 'Paste',
      // Paste needs a clip on the clipboard; it lands on this clip's track at
      // the playhead, mirroring the Edit-menu / Ctrl+V behaviour.
      disabled: !project.clipboardClip
    })
    items.push({ command: 'clip.duplicate', label: 'Duplicate' })
    items.push({ command: 'clip.delete', label: 'Delete' })
    if (clip) {
      // Lock toggle: label flips based on the current flag so a single
      // command + a single menu row covers both directions. Placed in
      // its own separator group so it's visually distinct from the
      // destructive Delete/Duplicate row above.
      items.push({
        command: clip.locked ? 'clip.unlock' : 'clip.lock',
        label: clip.locked ? 'Unlock' : 'Lock',
        separatorAbove: true
      })
    }
    const isLinkedClip = clipParent?.kind === 'clip'
    const playheadOverClip =
      !!clip &&
      project.selectedTrackId === clip.trackId &&
      transport.positionMs > clip.startMs &&
      transport.positionMs < clip.startMs + effectiveClipDurationMs(clip)
    items.push({
      command: 'clip.split',
      label: clip?.locked ? 'Split at Playhead (clip is locked)' : 'Split at Playhead',
      disabled: isLinkedClip || !playheadOverClip
    })
    // Quick chop: slice the whole clip onto the beat grid without opening the
    // editor. Only offered for an unlocked, unlinked clip with a known tempo
    // (the editor's Slice mode adds manual markers and 1/32).
    const chopSrc = clip ? library.byId[clip.libraryItemId] : undefined
    if (clip && !clip.locked && !isLinkedClip && chopSrc?.bpm && chopSrc.bpm > 0) {
      const SUBS: { sub: SliceSubdivision; label: string }[] = [
        { sub: '1 bar', label: '1 bar' },
        { sub: '1/2 bar', label: '1/2 bar' },
        { sub: '1/4', label: '1/4' },
        { sub: '1/8', label: '1/8' },
        { sub: '1/16', label: '1/16' }
      ]
      items.push({
        command: 'clip.chopGrid',
        label: 'Chop to Grid',
        separatorAbove: true,
        title: 'Slice the clip into adjacent clips on the beat grid',
        submenu: SUBS.map(({ sub, label }) => ({
          command: `clip.chopGrid:${sub}`,
          label
        }))
      })
    }
    if (clip) {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      const selected =
        typeof clip.colorIndex === 'number'
          ? clip.colorIndex
          : track
            ? track.colorIndex
            : undefined
      items.push({
        command: 'clip.color',
        label: 'Colour',
        separatorAbove: true,
        swatches: TRACK_PALETTE.map((p) => ({ cssHex: p.cssHex, label: p.id })),
        selectedSwatch: selected
      })
    }
    items.push({ command: 'clip.warp', label: 'Warp', separatorAbove: true })
    items.push({ command: 'clip.pitch', label: 'Pitch' })
    items.push({
      command: 'clip.separateStems',
      label: 'Separate Stems',
      title:
        'Split the clip into vocals, drums, bass, and other stems, each on its own ' +
        'new track (non-destructive). A one-time model download is needed on first use.',
      disabled: !clip || clip.unresolved || !hasLibraryItem
    })
    if (clip) {
      // Single toggle row; a leading check marks the on-state since there is no
      // natural opposite verb. Reversing a linked clip reverses every sibling.
      items.push({
        command: 'clip.reverse',
        label: clip.reversed ? '\u2713 Reverse' : 'Reverse',
        title: isLinkedClip
          ? 'Play the clip backwards. Applies to every linked instance of this saved clip.'
          : 'Play the clip backwards (non-destructive).'
      })
    }
    // §12.1 — crossfade recipe + removal. A clip can fade out into its
    // following neighbour (it is the LEFT partner) and/or fade in from its
    // preceding neighbour (the RIGHT partner), so a sandwiched clip can show
    // both groups. Each group offers the selectable recipes (current marked
    // with a leading check) followed by its removal row. The transition id and
    // recipe kind are carried in the command token.
    if (clip) {
      const track = project.tracks.find((t) => t.id === clip.trackId)
      const clipTransitions = track?.transitions ?? []
      const asLeft = clipTransitions.find((tr) => tr.leftClipId === clip.id)
      const asRight = clipTransitions.find((tr) => tr.rightClipId === clip.id)
      const pushRecipeGroup = (
        tr: { id: string; recipe: { kind: string } },
        sideLabel: string,
        removeLabel: string,
        firstSeparator: boolean
      ): void => {
        TRANSITION_RECIPES.forEach((recipe, idx) => {
          const on = tr.recipe.kind === recipe.kind
          items.push({
            command: `clip.setTransitionRecipe:${tr.id}:${recipe.kind}`,
            label: `${on ? '\u2713 ' : ''}${sideLabel}: ${recipe.label}`,
            title: recipe.description,
            separatorAbove: firstSeparator && idx === 0
          })
        })
        items.push({ command: `clip.removeTransition:${tr.id}`, label: removeLabel })
      }
      if (asLeft) {
        pushRecipeGroup(asLeft, 'Crossfade to next', 'Remove Crossfade to Next Clip', true)
      }
      if (asRight) {
        pushRecipeGroup(
          asRight,
          'Crossfade from previous',
          'Remove Crossfade from Previous Clip',
          !asLeft
        )
      }
    }
    items.push({
      command: 'clip.saveToLibrary',
      label: 'Save Clip to Library',
      separatorAbove: true,
      disabled: isLinkedClip
    })
    if (clip && isLinkedClip) {
      items.push({ command: 'clip.unlink', label: 'Unlink from Library' })
    }
    items.push({
      command: 'clip.saveSample',
      label: 'Save as Sample\u2026',
      title:
        'Create a new independent WAV sample from the clip\u2019s current trim, under the ' +
        'project\u2019s Samples folder. You choose whether it is a music sample (keeps the ' +
        'source tempo, beats, and key so it warps on drop) or a simple one-shot (no musical ' +
        'metadata, never warps). Samples are not linked back to this clip.'
    })
    return items
  })

  function onContextMenu(e: MouseEvent): void {
    const host = inputs.host.value
    if (!host) return
    // Right-click on an automation breakpoint deletes it (no menu).
    if (inputs.removeAutomationPointAt?.(e.clientX, e.clientY)) {
      e.preventDefault()
      return
    }
    const rect = host.getBoundingClientRect()
    const worldX = e.clientX - rect.left + inputs.scrollX.value
    const worldY = e.clientY - rect.top + inputs.scrollY.value
    const regions = inputs.getClipHitRegions()
    // Reverse iterate so the visually top-most clip wins on overlap.
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]
      if (!r) continue
      if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) {
        e.preventDefault()
        contextMenuTrackId.value = null
        contextMenuClipId.value = r.clipId
        contextMenuX.value = e.clientX
        contextMenuY.value = e.clientY
        contextMenuOpen.value = true
        return
      }
    }
    // Not on a clip: offer a Paste menu when the right-click lands on an empty
    // track lane (past the pinned header column, on a real track row). The
    // header column hosts its own controls, so anything left of it is ignored.
    const localX = e.clientX - rect.left
    if (localX >= inputs.headerWidth()) {
      const hit = trackIndexAtWorldY(project.tracks, worldY, makeLaneHeightOf())
      const trackId = hit ? (project.tracks[hit.index]?.id ?? null) : null
      if (trackId) {
        e.preventDefault()
        contextMenuClipId.value = null
        contextMenuTrackId.value = trackId
        contextMenuX.value = e.clientX
        contextMenuY.value = e.clientY
        contextMenuOpen.value = true
        return
      }
    }
    // Otherwise let the browser default contextmenu happen (a no-op in Electron)
    // so we don't accidentally swallow the event for the rest of the layout.
  }

  function onContextMenuCommand(command: string): void {
    // Empty track-lane Paste: drop the clipboard clip onto the right-clicked
    // track at the playhead (mirrors the clip-menu / Ctrl+V behaviour).
    if (command === 'track.paste') {
      const trackId = contextMenuTrackId.value
      if (trackId) {
        project.selectTrack(trackId)
        project.pasteClipAtPlayhead(transport.positionMs)
      }
      contextMenuTrackId.value = null
      contextMenuClipId.value = null
      return
    }
    const clipId = contextMenuClipId.value
    if (!clipId) return
    const clip = project.clips[clipId]
    // Defensive: a clip might have been deleted between menu-open
    // and command-dispatch. Bail rather than crashing.
    if (!clip && !command.startsWith('clip.color:')) {
      contextMenuClipId.value = null
      return
    }
    if (command === 'clip.openEditor') {
      inputs.dialogs.openEditor(clipId)
    } else if (command === 'clip.info') {
      inputs.dialogs.openInfo(clipId)
    } else if (command === 'clip.delete') {
      project.removeClip(clipId)
    } else if (command === 'clip.copy') {
      if (clip) {
        // Select the clip + its track first (as a left-click would) so Copy
        // acts on what was right-clicked and a later Paste targets this track.
        project.selectClip(clipId)
        project.selectTrack(clip.trackId)
        project.copySelectedClip()
      }
    } else if (command === 'clip.cut') {
      if (clip) {
        project.selectClip(clipId)
        project.selectTrack(clip.trackId)
        project.cutSelectedClip()
      }
    } else if (command === 'clip.paste') {
      if (clip) {
        // Paste onto the right-clicked clip's track at the playhead, matching
        // the Edit-menu / Ctrl+V behaviour.
        project.selectTrack(clip.trackId)
        project.pasteClipAtPlayhead(transport.positionMs)
      }
    } else if (command === 'clip.duplicate') {
      project.duplicateClip(clipId)
    } else if (command === 'clip.lock') {
      project.setClipLocked(clipId, true)
    } else if (command === 'clip.unlock') {
      project.setClipLocked(clipId, false)
    } else if (command === 'clip.split') {
      project.splitClipAt(clipId, transport.positionMs)
    } else if (command.startsWith('clip.chopGrid:')) {
      const subdivision = command.slice('clip.chopGrid:'.length) as SliceSubdivision
      const src = clip ? library.byId[clip.libraryItemId] : undefined
      if (clip && src) {
        const markers = generateGridSlices({
          sourceBpm: src.bpm,
          anchorSec: src.beatAnchorSec ?? src.beats?.[0],
          subdivision,
          windowInMs: clip.inMs,
          windowDurationMs: clip.durationMs
        })
        project.sliceClipToTimeline(clipId, markers)
      }
    } else if (command === 'clip.saveToLibrary') {
      project.saveClipToLibrary(clipId)
    } else if (command === 'clip.saveSample') {
      inputs.dialogs.openSampleType(clipId)
    } else if (command === 'clip.unlink') {
      project.unlinkClipFromLibrary(clipId)
    } else if (command === 'clip.warp') {
      inputs.dialogs.openWarp(clipId, 'tempo')
    } else if (command === 'clip.pitch') {
      inputs.dialogs.openWarp(clipId, 'pitch')
    } else if (command === 'clip.separateStems') {
      startStemSeparation(clipId)
    } else if (command === 'clip.reverse') {
      if (clip) {
        const next = !clip.reversed
        const parent = library.byId[clip.libraryItemId]
        if (parent?.kind === 'clip') {
          library.updateLibraryClipReversed(clip.libraryItemId, next)
        } else {
          project.setClipReversed(clipId, next)
        }
      }
    } else if (command.startsWith('clip.color:')) {
      const idx = Number.parseInt(command.slice('clip.color:'.length), 10)
      if (Number.isFinite(idx)) project.setClipColor(clipId, idx)
    } else if (command.startsWith('clip.setTransitionRecipe:')) {
      const rest = command.slice('clip.setTransitionRecipe:'.length)
      const sep = rest.lastIndexOf(':')
      const transitionId = sep > 0 ? rest.slice(0, sep) : ''
      const kind = sep > 0 ? rest.slice(sep + 1) : ''
      const known = TRANSITION_RECIPES.find((r) => r.kind === kind)
      if (clip && transitionId && known) {
        project.setTransitionRecipe(clip.trackId, transitionId, { kind: known.kind })
      }
    } else if (command.startsWith('clip.removeTransition:')) {
      const transitionId = command.slice('clip.removeTransition:'.length)
      if (clip && transitionId) project.deleteTransition(clip.trackId, transitionId)
    } else if (command === 'clip.relink') {
      if (clip) {
        const slash = Math.max(clip.filePath.lastIndexOf('\\'), clip.filePath.lastIndexOf('/'))
        const defaultPath = slash > 0 ? clip.filePath.slice(0, slash) : undefined
        chooseAudioFile({ title: `Locate ${clip.fileName}`, defaultPath })
          .then((picked) => {
            if (picked) project.relinkLibraryItem(clip.libraryItemId, picked)
          })
          .catch((err) => onError('Failed to choose audio file for relink', err))
      }
    }
    contextMenuClipId.value = null
    contextMenuTrackId.value = null
  }

  function onContextMenuClose(): void {
    contextMenuOpen.value = false
    contextMenuClipId.value = null
    contextMenuTrackId.value = null
  }

  return {
    contextMenuOpen,
    contextMenuX,
    contextMenuY,
    contextMenuClipId,
    contextMenuTrackId,
    contextMenuItems,
    onContextMenu,
    onContextMenuCommand,
    onContextMenuClose
  }
}
