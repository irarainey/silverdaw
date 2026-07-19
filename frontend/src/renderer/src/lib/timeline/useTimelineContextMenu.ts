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
  useProjectStore,
  type Clip
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
import { requestChannelSplitForClip } from '@/lib/stems/channelSplitFlow'
import { log } from '@/lib/log'
import { DEFAULT_BEATS_PER_BAR, DEFAULT_SUBS_PER_BEAT } from '@/lib/musicTime'
import type { BeatRepeatDivision } from '@shared/bridge-protocol'

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
  /** Opens the stereo-channel-split picker for a clip. Injected so tests can stub
   *  it; defaults to the channel-split flow. */
  startChannelSplit?: (clipId: string) => void
  /** Logger for picker / IPC failures. Defaults to `console.warn`. */
  onError?: (message: string, err: unknown) => void
}

export interface TimelineContextMenu {
  contextMenuOpen: Ref<boolean>
  contextMenuX: Ref<number>
  contextMenuY: Ref<number>
  /** Beat snapped from the playhead when the menu opened. */
  contextMenuStartBeat: Ref<number>
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

const BEAT_REPEAT_DIVISIONS: readonly BeatRepeatDivision[] = ['1/4', '1/8', '1/16']
const BEAT_REPEAT_LENGTHS = [
  { beats: 0.5, label: '1/2 Beat' },
  { beats: 1, label: '1 Beat' },
  { beats: 2, label: '2 Beats' },
  { beats: DEFAULT_BEATS_PER_BAR, label: '1 Bar' }
] as const

export function useTimelineContextMenu(
  inputs: UseTimelineContextMenuInputs
): TimelineContextMenu {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()

  const chooseAudioFile = inputs.chooseAudioFile ?? DEFAULT_CHOOSE_AUDIO_FILE
  const startStemSeparation =
    inputs.startStemSeparation ??
    ((clipId: string): void => {
      void requestStemSeparationForClip(clipId)
    })
  const startChannelSplit =
    inputs.startChannelSplit ??
    ((clipId: string): void => {
      requestChannelSplitForClip(clipId)
    })
  const onError =
    inputs.onError ??
    ((message: string, err: unknown): void => {
      log.warn('timeline', `${message}: ${err instanceof Error ? err.message : String(err)}`)
    })

  const contextMenuOpen = ref(false)
  const contextMenuX = ref(0)
  const contextMenuY = ref(0)
  const contextMenuStartBeat = ref(0)
  const contextMenuClipId = ref<string | null>(null)
  const contextMenuTrackId = ref<string | null>(null)

  function beatRepeatItem(trackId: string, clip?: Clip): ClipContextMenuItem {
    const track = project.tracks.find((candidate) => candidate.id === trackId)
    const startBeat = contextMenuStartBeat.value
    const regions = track?.beatRepeats ?? []
    const activeRegion = regions.find(
      (region) => startBeat >= region.startBeat && startBeat < region.startBeat + region.lengthBeats
    )
    const clipStartBeat = clip ? (clip.startMs / 60000) * transport.bpm : Number.NaN
    const clipEndBeat = clip
      ? ((clip.startMs + effectiveClipDurationMs(clip)) / 60000) * transport.bpm
      : Number.NaN
    const affectingClip = Number.isFinite(clipStartBeat) && Number.isFinite(clipEndBeat)
      ? regions.filter(
          (region) =>
            region.startBeat < clipEndBeat && region.startBeat + region.lengthBeats > clipStartBeat
        )
      : activeRegion
        ? [activeRegion]
        : []
    const additions = BEAT_REPEAT_LENGTHS.map(({ beats, label }) => {
      const endBeat = startBeat + beats
      const overlaps = regions.some(
        (region) => startBeat < region.startBeat + region.lengthBeats && endBeat > region.startBeat
      )
      return {
        command: `track.beatRepeatLength:${beats}`,
        label,
        disabled: overlaps,
        title: overlaps ? 'A Beat Repeat region already overlaps this duration' : undefined,
        submenu: BEAT_REPEAT_DIVISIONS.map((division) => ({
          command: `track.beatRepeatAdd:${beats}:${division}`,
          label: division
        }))
      }
    })
    const removals = affectingClip.map((region, index) => ({
      command: `track.beatRepeatDelete:${region.id}`,
      label: `✓ Beat ${region.startBeat + 1} · ${region.division}`,
      title: 'Remove this Beat Repeat region',
      separatorAbove: index === 0
    }))
    return {
      command: 'track.beatRepeat',
      label: affectingClip.length > 0 ? '✓ Beat Repeat' : 'Beat Repeat',
      title: affectingClip.length > 0
        ? 'This clip intersects one or more Beat Repeat regions'
        : 'Repeat the first division of one bar from the playhead',
      submenu: [...additions, ...removals]
    }
  }

  function effectsItem(
    trackId: string,
    playbackItems: ReadonlyArray<ClipContextMenuItem> = [],
    clip?: Clip
  ): ClipContextMenuItem {
    return {
      command: 'track.effects',
      label: 'Effects',
      submenu: [beatRepeatItem(trackId, clip), ...playbackItems]
    }
  }

  function snapContextMenuBeatToPlayhead(): void {
    const timelineMs = transport.positionMs
    const bpm = transport.bpm
    contextMenuStartBeat.value =
      Number.isFinite(timelineMs) && Number.isFinite(bpm) && bpm > 0
        ? Math.max(
            0,
            Math.round((timelineMs / 60000) * bpm * DEFAULT_SUBS_PER_BEAT) /
              DEFAULT_SUBS_PER_BEAT
          )
        : 0
  }

  const contextMenuItems = computed<ClipContextMenuItem[]>(() => {
    // Empty track-lane right-click: a Paste-only menu that drops the clipboard
    // clip onto that track at the playhead.
    if (!contextMenuClipId.value && contextMenuTrackId.value) {
      return [
        {
          command: 'track.paste',
          label: 'Paste',
          disabled: !project.clipboardClip && !project.clipboardClips
        },
        { ...effectsItem(contextMenuTrackId.value), separatorAbove: true }
      ]
    }
    // Multi-selection: a short, dedicated menu of operations that apply to the whole group,
    // rather than greying out the many single-clip-only items on the normal menu.
    if (
      contextMenuClipId.value !== null &&
      project.selectedClipIds.size > 1 &&
      project.isClipSelected(contextMenuClipId.value)
    ) {
      const ids = Array.from(project.selectedClipIds)
      const count = ids.length
      const allLocked = ids.every((id) => project.clips[id]?.locked === true)
      return [
        {
          command: allLocked ? 'clips.unlock' : 'clips.lock',
          label: allLocked ? `Unlock ${count} Clips` : `Lock ${count} Clips`
        },
        {
          command: 'clips.color',
          label: 'Colour',
          separatorAbove: true,
          swatches: TRACK_PALETTE.map((p) => ({ cssHex: p.cssHex, label: p.id }))
        },
        { command: 'clips.copy', label: `Copy ${count} Clips`, separatorAbove: true },
        { command: 'clips.cut', label: `Cut ${count} Clips` },
        { command: 'clips.duplicate', label: `Duplicate ${count} Clips`, separatorAbove: true },
        { command: 'clips.delete', label: `Delete ${count} Clips` },
        { command: 'clips.deselect', label: 'Deselect', separatorAbove: true }
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
      command: 'clip.open',
      label: 'Open',
      submenu: [
        {
          command: 'clip.openEditor',
          label: 'Clip Editor',
          disabled: !clip || clip.unresolved || !hasLibraryItem
        },
        {
          command: 'clip.openScratchEditor',
          label: 'Scratch Editor',
          disabled: !clip || clip.unresolved || !hasLibraryItem,
          title: 'Open this clip in the Scratch Editor'
        },
        {
          command: 'clip.info',
          label: 'Show Information',
          disabled: !clip || clip.unresolved || !hasLibraryItem
        }
      ]
    })
    const isLinkedClip = clipParent?.kind === 'clip'
    const playheadOverClip =
      !!clip &&
      project.selectedTrackId === clip.trackId &&
      transport.positionMs > clip.startMs &&
      transport.positionMs < clip.startMs + effectiveClipDurationMs(clip)
    items.push({
      command: 'clip.edit',
      label: 'Edit',
      separatorAbove: true,
      submenu: [
        { command: 'clip.cut', label: 'Cut' },
        { command: 'clip.copy', label: 'Copy' },
        {
          command: 'clip.paste',
          label: 'Paste',
          disabled: !project.clipboardClip && !project.clipboardClips
        },
        { command: 'clip.duplicate', label: 'Duplicate' },
        {
          command: clip?.locked ? 'clip.unlock' : 'clip.lock',
          label: clip?.locked ? 'Unlock' : 'Lock'
        },
        {
          command: 'clip.split',
          label: clip?.locked ? 'Split at Playhead (clip is locked)' : 'Split at Playhead',
          disabled: isLinkedClip || !playheadOverClip
        }
      ]
    })
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
    const transformItems: ClipContextMenuItem[] = [
      { command: 'clip.warp', label: 'Warp' },
      { command: 'clip.pitch', label: 'Pitch' },
      {
        command: 'clip.separateStems',
        label: 'Separate Stems',
        title:
          'Split the clip into vocals, drums, bass, and other stems, each on its own ' +
          'new track (non-destructive). A one-time model download is needed on first use.',
        disabled: !clip || clip.unresolved || !hasLibraryItem
      }
    ]
    // Quick chop: slice the whole clip onto the beat grid without opening the
    // editor. Only offered for an unlocked, unlinked clip with a known tempo
    // (the editor's Slice mode adds manual markers and 1/32).
    const chopSrc = clip ? library.byId[clip.libraryItemId] : undefined
    if (clip && !clip.locked && !isLinkedClip && chopSrc?.bpm && chopSrc.bpm > 0) {
      const subdivisions: { sub: SliceSubdivision; label: string }[] = [
        { sub: '1 bar', label: '1 bar' },
        { sub: '1/2 bar', label: '1/2 bar' },
        { sub: '1/4', label: '1/4' },
        { sub: '1/8', label: '1/8' },
        { sub: '1/16', label: '1/16' }
      ]
      transformItems.unshift({
        command: 'clip.chopGrid',
        label: 'Chop to Grid',
        title: 'Slice the clip into adjacent clips on the beat grid',
        submenu: subdivisions.map(({ sub, label }) => ({
          command: `clip.chopGrid:${sub}`,
          label
        }))
      })
    }
    // Stereo-only: split a channel out to its own track (that channel copied to both
    // sides). Hidden entirely when the source isn't a stereo file.
    if (clip && hasLibraryItem && clipParent?.channelCount === 2) {
      transformItems.push({
        command: 'clip.splitChannels',
        label: 'Split Stereo Channels…',
        title:
          'Copy the left and/or right channel to its own new track as a stereo clip ' +
          '(non-destructive).',
        disabled: clip.unresolved
      })
    }
    items.push({
      command: 'clip.transform',
      label: 'Transform',
      separatorAbove: true,
      submenu: transformItems
    })
    if (clip) {
      // Reverse and the two turntable tail effects (brake / backspin) form a
      // mutually-exclusive group: each row stays visible but is disabled while
      // another in the group is set — matching the Clip Editor toolbar. A leading
      // check marks the on-state. Reverse plays the whole clip backwards; brake is
      // a record-stop and backspin a reverse-rewind at the clip's end. Brake and
      // backspin compose with warp (the part before the tail is warped, the tail is
      // a direct varispeed read). Toggling a linked clip applies to every sibling.
      const reversed = clip.reversed === true
      const brakeOn = clip.brake === true
      const backspinOn = clip.backspin === true
      const groupHint =
        'a clip can be reversed or have a turntable effect, not both'

      const playbackItems: ClipContextMenuItem[] = []
      playbackItems.push({
        command: 'clip.reverse',
        label: reversed ? '\u2713 Reverse' : 'Reverse',
        disabled: !reversed && (brakeOn || backspinOn),
        title: !reversed && brakeOn
          ? `Turn off Brake first — ${groupHint}`
          : !reversed && backspinOn
            ? `Turn off Backspin first — ${groupHint}`
            : isLinkedClip
              ? 'Play the clip backwards. Applies to every linked instance of this saved clip.'
              : 'Play the clip backwards (non-destructive).'
      })
      playbackItems.push({
        command: 'clip.brake',
        label: brakeOn ? '\u2713 Brake' : 'Brake',
        disabled: !brakeOn && (reversed || backspinOn),
        title: !brakeOn && reversed
          ? `Turn off Reverse first — ${groupHint}`
          : !brakeOn && backspinOn
            ? 'Turn off Backspin first — a clip can have a brake or a backspin, not both'
            : 'Decelerate the clip to a stop at its end, like a turntable record-stop'
      })
      playbackItems.push({
        command: 'clip.backspin',
        label: backspinOn ? '\u2713 Backspin' : 'Backspin',
        disabled: !backspinOn && (reversed || brakeOn),
        title: !backspinOn && reversed
          ? `Turn off Reverse first — ${groupHint}`
          : !backspinOn && brakeOn
            ? 'Turn off Brake first — a clip can have a brake or a backspin, not both'
            : 'Rewind the clip backwards at its end, like a DJ pulling the vinyl back'
      })
      items.push({
        ...effectsItem(clip.trackId, playbackItems, clip),
        separatorAbove: true
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
      const crossfadeItems: ClipContextMenuItem[] = []
      const pushRecipeGroup = (
        tr: { id: string; recipe: { kind: string } },
        sideLabel: string,
        removeLabel: string,
        firstSeparator: boolean
      ): void => {
        TRANSITION_RECIPES.forEach((recipe, idx) => {
          const on = tr.recipe.kind === recipe.kind
          crossfadeItems.push({
            command: `clip.setTransitionRecipe:${tr.id}:${recipe.kind}`,
            label: `${on ? '\u2713 ' : ''}${sideLabel}: ${recipe.label}`,
            title: recipe.description,
            separatorAbove: firstSeparator && idx === 0
          })
        })
        crossfadeItems.push({ command: `clip.removeTransition:${tr.id}`, label: removeLabel })
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
      if (crossfadeItems.length > 0) {
        items.push({
          command: 'clip.crossfade',
          label: 'Crossfade',
          separatorAbove: true,
          submenu: crossfadeItems
        })
      }
    }
    const libraryItems: ClipContextMenuItem[] = [{
      command: 'clip.saveToLibrary',
      label: 'Save Clip to Library',
      disabled: isLinkedClip
    }]
    if (clip && isLinkedClip) {
      libraryItems.push({ command: 'clip.unlink', label: 'Unlink from Library' })
    }
    libraryItems.push({
      command: 'clip.saveSample',
      label: 'Save as Sample\u2026',
      title:
        'Create a new independent WAV sample from the clip\u2019s current trim, under the ' +
        'project\u2019s Samples folder. You choose whether it is a music sample (keeps the ' +
        'source tempo, beats, and key so it warps on drop) or a simple one-shot (no musical ' +
        'metadata, never warps). Samples are not linked back to this clip.'
    })
    items.push({
      command: 'clip.library',
      label: 'Library',
      separatorAbove: true,
      submenu: libraryItems
    })
    items.push({ command: 'clip.delete', label: 'Delete', separatorAbove: true })
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
    snapContextMenuBeatToPlayhead()
    const regions = inputs.getClipHitRegions()
    // Reverse iterate so the visually top-most clip wins on overlap.
    for (let i = regions.length - 1; i >= 0; i--) {
      const r = regions[i]
      if (!r) continue
      if (worldX >= r.x && worldX <= r.x + r.w && worldY >= r.y && worldY <= r.y + r.h) {
        e.preventDefault()
        contextMenuTrackId.value = null
        contextMenuClipId.value = r.clipId
        // Right-clicking a clip outside the current multi-selection collapses to just that clip;
        // right-clicking one inside it keeps the whole group so the multi-menu targets it.
        if (!(project.selectedClipIds.size > 1 && project.isClipSelected(r.clipId))) {
          project.selectClip(r.clipId)
        }
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
        if (project.clipboardClips) project.pasteClipsAtPlayhead(transport.positionMs)
        else project.pasteClipAtPlayhead(transport.positionMs)
      }
      contextMenuTrackId.value = null
      contextMenuClipId.value = null
      return
    }
    const beatRepeatTrackId =
      contextMenuTrackId.value ??
      (contextMenuClipId.value ? project.clips[contextMenuClipId.value]?.trackId : undefined)
    if (command.startsWith('track.beatRepeatAdd:')) {
      const [lengthText, divisionText] = command.slice('track.beatRepeatAdd:'.length).split(':')
      const lengthBeats = Number(lengthText)
      const division = divisionText as BeatRepeatDivision
      if (
        beatRepeatTrackId &&
        BEAT_REPEAT_LENGTHS.some((option) => option.beats === lengthBeats) &&
        BEAT_REPEAT_DIVISIONS.includes(division)
      ) {
        project.addTrackBeatRepeat(
          beatRepeatTrackId,
          contextMenuStartBeat.value,
          lengthBeats,
          division
        )
      }
      contextMenuClipId.value = null
      contextMenuTrackId.value = null
      return
    }
    if (command.startsWith('track.beatRepeatDelete:')) {
      const regionId = command.slice('track.beatRepeatDelete:'.length)
      if (beatRepeatTrackId && regionId.length > 0) {
        project.deleteTrackBeatRepeat(beatRepeatTrackId, regionId)
      }
      contextMenuClipId.value = null
      contextMenuTrackId.value = null
      return
    }
    // Multi-selection batch operations (each is one undo step; see the store actions).
    if (command === 'clips.copy') {
      project.copySelectedClips()
      contextMenuClipId.value = null
      return
    }
    if (command === 'clips.cut') {
      project.cutSelectedClips()
      contextMenuClipId.value = null
      return
    }
    if (command === 'clips.delete') {
      project.deleteSelectedClips()
      contextMenuClipId.value = null
      return
    }
    if (command === 'clips.lock' || command === 'clips.unlock') {
      project.setSelectedClipsLocked(command === 'clips.lock')
      contextMenuClipId.value = null
      return
    }
    if (command === 'clips.duplicate') {
      project.duplicateSelectedClips()
      contextMenuClipId.value = null
      return
    }
    if (command === 'clips.deselect') {
      project.clearClipSelection()
      contextMenuClipId.value = null
      return
    }
    if (command.startsWith('clips.color:')) {
      const idx = Number.parseInt(command.slice('clips.color:'.length), 10)
      if (Number.isFinite(idx)) project.setSelectedClipsColor(idx)
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
    } else if (command === 'clip.openScratchEditor') {
      inputs.dialogs.openScratchEditor(clipId)
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
        if (project.clipboardClips) project.pasteClipsAtPlayhead(transport.positionMs)
        else project.pasteClipAtPlayhead(transport.positionMs)
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
    } else if (command === 'clip.splitChannels') {
      startChannelSplit(clipId)
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
    } else if (command === 'clip.brake') {
      if (clip) {
        const next = !clip.brake
        const parent = library.byId[clip.libraryItemId]
        if (parent?.kind === 'clip') {
          library.updateLibraryClipBrake(clip.libraryItemId, next)
        } else {
          project.setClipBrake(clipId, next)
        }
      }
    } else if (command === 'clip.backspin') {
      if (clip) {
        const next = !clip.backspin
        const parent = library.byId[clip.libraryItemId]
        if (parent?.kind === 'clip') {
          library.updateLibraryClipBackspin(clip.libraryItemId, next)
        } else {
          project.setClipBackspin(clipId, next)
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
    contextMenuStartBeat,
    contextMenuClipId,
    contextMenuTrackId,
    contextMenuItems,
    onContextMenu,
    onContextMenuCommand,
    onContextMenuClose
  }
}
