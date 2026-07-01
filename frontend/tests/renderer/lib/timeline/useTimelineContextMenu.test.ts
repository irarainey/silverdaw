import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useTimelineContextMenu } from '@/lib/timeline/useTimelineContextMenu'
import type { ClipContextMenuItem } from '@/lib/timeline/clipContextMenuTypes'
import { useClipDialogs } from '@/lib/timeline/useClipDialogs'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function makeAudioFileItem(id = 'src'): LibraryItem {
  return {
    id,
    kind: 'source',
    fileName: `${id}.wav`,
    filePath: `C:\\${id}.wav`,
    playbackFilePath: `C:\\${id}.wav`,
    durationMs: 5_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array()
  } as LibraryItem
}

function makeLibraryClipItem(id = 'saved'): LibraryItem {
  return {
    id,
    kind: 'clip',
    fileName: 'src.wav',
    filePath: 'C:\\src.wav',
    playbackFilePath: 'C:\\src.wav',
    durationMs: 2_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    derivedFrom: { sourceItemId: 'src', sourceClipId: '', inMs: 0, durationMs: 2_000 }
  } as LibraryItem
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'clip-1',
    trackId: 'track-1',
    libraryItemId: 'src',
    filePath: 'C:\\src.wav',
    fileName: 'src.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 1_000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

function setupMenu(opts: {
  clip: Clip
  item?: LibraryItem
  selectedTrackId?: string | null
  positionMs?: number
  chooseAudioFile?: ReturnType<typeof vi.fn>
  startStemSeparation?: ReturnType<typeof vi.fn>
}): ReturnType<typeof useTimelineContextMenu> {
  const project = useProjectStore()
  const library = useLibraryStore()
  const transport = useTransportStore()
  project.clips = { [opts.clip.id]: opts.clip }
  project.tracks = [
    {
      id: opts.clip.trackId,
      name: 'T1',
      colorIndex: 5,
      muted: false,
      solo: false,
      volume: 1,
      pan: 0,
      armed: false
    } as never
  ]
  project.selectedTrackId = opts.selectedTrackId ?? null
  library.items = opts.item ? [opts.item] : []
  transport.positionMs = opts.positionMs ?? 0

  const dialogs = useClipDialogs()
  const menu = useTimelineContextMenu({
    host: ref(null),
    scrollX: ref(0),
    scrollY: ref(0),
    getClipHitRegions: () => [],
    headerWidth: () => 200,
    dialogs,
    chooseAudioFile: opts.chooseAudioFile,
    startStemSeparation: opts.startStemSeparation
  })
  menu.contextMenuClipId.value = opts.clip.id
  return menu
}

function commandsOf(menu: ReturnType<typeof useTimelineContextMenu>): string[] {
  return menu.contextMenuItems.value.map((i) => i.command)
}

function findItem(
  menu: ReturnType<typeof useTimelineContextMenu>,
  command: string
): ClipContextMenuItem | undefined {
  return menu.contextMenuItems.value.find((i) => i.command === command)
}

describe('useTimelineContextMenu — items builder', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('unresolved clip shows Relink and disables Open in editor / Show information', () => {
    const menu = setupMenu({
      clip: makeClip({ unresolved: true }),
      item: makeAudioFileItem()
    })
    const cmds = commandsOf(menu)
    expect(cmds[0]).toBe('clip.relink')
    expect(findItem(menu, 'clip.openEditor')?.disabled).toBe(true)
    expect(findItem(menu, 'clip.info')?.disabled).toBe(true)
  })

  it('clip with missing library item disables Open in editor / Show information', () => {
    const menu = setupMenu({ clip: makeClip({ libraryItemId: 'gone' }) })
    expect(findItem(menu, 'clip.openEditor')?.disabled).toBe(true)
    expect(findItem(menu, 'clip.info')?.disabled).toBe(true)
  })

  it('linked library-clip allows warp / pitch (propagates to library), disables split / save-to-library, and shows Unlink', () => {
    const menu = setupMenu({
      clip: makeClip({ libraryItemId: 'saved' }),
      item: makeLibraryClipItem('saved')
    })
    expect(findItem(menu, 'clip.split')?.disabled).toBe(true)
    // Warp and Pitch are enabled on linked clips: the dialog routes the
    // save through `library.updateLibraryClipWarp(libItem.id, patch)`,
    // which updates the library-clip library entry and propagates to
    // every linked timeline instance.
    expect(findItem(menu, 'clip.warp')?.disabled).toBeFalsy()
    expect(findItem(menu, 'clip.pitch')?.disabled).toBeFalsy()
    expect(findItem(menu, 'clip.saveToLibrary')?.disabled).toBe(true)
    expect(commandsOf(menu)).toContain('clip.unlink')
  })

  it('source clip omits Unlink', () => {
    const menu = setupMenu({
      clip: makeClip(),
      item: makeAudioFileItem()
    })
    expect(commandsOf(menu)).not.toContain('clip.unlink')
  })

  it('offers Cut / Copy / Paste; Paste is gated on a non-empty clipboard', () => {
    const menu = setupMenu({ clip: makeClip(), item: makeAudioFileItem() })
    const cmds = commandsOf(menu)
    expect(cmds).toContain('clip.cut')
    expect(cmds).toContain('clip.copy')
    expect(cmds).toContain('clip.paste')
    // Empty clipboard -> Paste disabled.
    expect(findItem(menu, 'clip.paste')?.disabled).toBe(true)

    useProjectStore().clipboardClip = { libraryItemId: 'src' } as never
    expect(findItem(menu, 'clip.paste')?.disabled).toBeFalsy()
  })

  it('Split is enabled only when the playhead sits strictly inside the clip on the selected track', () => {
    const clip = makeClip({ startMs: 100, durationMs: 200 })

    const noTrack = setupMenu({ clip, item: makeAudioFileItem(), selectedTrackId: null, positionMs: 200 })
    expect(findItem(noTrack, 'clip.split')?.disabled).toBe(true)

    setActivePinia(createPinia())
    const wrongTrack = setupMenu({ clip, item: makeAudioFileItem(), selectedTrackId: 'other', positionMs: 200 })
    expect(findItem(wrongTrack, 'clip.split')?.disabled).toBe(true)

    setActivePinia(createPinia())
    const outside = setupMenu({ clip, item: makeAudioFileItem(), selectedTrackId: clip.trackId, positionMs: 50 })
    expect(findItem(outside, 'clip.split')?.disabled).toBe(true)

    setActivePinia(createPinia())
    const inside = setupMenu({ clip, item: makeAudioFileItem(), selectedTrackId: clip.trackId, positionMs: 200 })
    expect(findItem(inside, 'clip.split')?.disabled).toBe(false)
  })

  it('Lock toggle: unlocked clip shows Lock → dispatches setClipLocked(true); locked clip shows Unlock → dispatches setClipLocked(false)', () => {
    const unlocked = setupMenu({ clip: makeClip(), item: makeAudioFileItem() })
    const unlockedItem = findItem(unlocked, 'clip.lock')
    expect(unlockedItem).toBeDefined()
    expect(commandsOf(unlocked)).not.toContain('clip.unlock')

    setActivePinia(createPinia())
    const lockedMenu = setupMenu({
      clip: makeClip({ locked: true }),
      item: makeAudioFileItem()
    })
    expect(findItem(lockedMenu, 'clip.unlock')).toBeDefined()
    expect(commandsOf(lockedMenu)).not.toContain('clip.lock')
    // Split stays enabled for locked clips so clicking it dispatches the
    // command and surfaces the "Locked clips cannot be split" notification
    // from the store guard. The label includes a hint so the user knows why.
    setActivePinia(createPinia())
    const lockedInside = setupMenu({
      clip: makeClip({ locked: true, startMs: 100, durationMs: 200 }),
      item: makeAudioFileItem(),
      selectedTrackId: 'track-1',
      positionMs: 200
    })
    const splitItem = findItem(lockedInside, 'clip.split')
    expect(splitItem?.disabled).toBe(false)
    expect(splitItem?.label).toContain('locked')
  })

  it('Reverse row check-state reflects clip.reversed', () => {
    const forward = setupMenu({ clip: makeClip(), item: makeAudioFileItem() })
    expect(findItem(forward, 'clip.reverse')?.label).toBe('Reverse')

    setActivePinia(createPinia())
    const reversed = setupMenu({
      clip: makeClip({ reversed: true }),
      item: makeAudioFileItem()
    })
    expect(findItem(reversed, 'clip.reverse')?.label).toBe('\u2713 Reverse')
  })

  it('Colour selected swatch prefers the clip override, falls back to the track default', () => {
    const trackDefault = setupMenu({
      clip: makeClip(),
      item: makeAudioFileItem()
    })
    expect(findItem(trackDefault, 'clip.color')?.selectedSwatch).toBe(5)

    setActivePinia(createPinia())
    const overridden = setupMenu({
      clip: makeClip({ colorIndex: 9 }),
      item: makeAudioFileItem()
    })
    expect(findItem(overridden, 'clip.color')?.selectedSwatch).toBe(9)
  })

  it('shows remove-crossfade rows for a clip participating in transitions', () => {
    const menu = setupMenu({ clip: makeClip({ id: 'c1' }), item: makeAudioFileItem() })
    const project = useProjectStore()
    project.tracks[0]!.transitions = [
      { id: 'tr-next', leftClipId: 'c1', rightClipId: 'c2', recipe: { kind: 'smooth' } },
      { id: 'tr-prev', leftClipId: 'c0', rightClipId: 'c1', recipe: { kind: 'smooth' } }
    ] as never
    const cmds = commandsOf(menu)
    expect(cmds).toContain('clip.removeTransition:tr-next')
    expect(cmds).toContain('clip.removeTransition:tr-prev')

    const del = vi.spyOn(project, 'deleteTransition')
    menu.onContextMenuCommand('clip.removeTransition:tr-next')
    expect(del).toHaveBeenCalledWith('track-1', 'tr-next')
  })

  it('offers a recipe row per kind with a check on the current recipe', () => {
    const menu = setupMenu({ clip: makeClip({ id: 'c1' }), item: makeAudioFileItem() })
    const project = useProjectStore()
    project.tracks[0]!.transitions = [
      { id: 'tr-next', leftClipId: 'c1', rightClipId: 'c2', recipe: { kind: 'linear' } }
    ] as never
    const cmds = commandsOf(menu)
    expect(cmds).toContain('clip.setTransitionRecipe:tr-next:smooth')
    expect(cmds).toContain('clip.setTransitionRecipe:tr-next:linear')

    const smooth = findItem(menu, 'clip.setTransitionRecipe:tr-next:smooth')
    const linear = findItem(menu, 'clip.setTransitionRecipe:tr-next:linear')
    expect(smooth?.label).not.toContain('\u2713')
    expect(linear?.label).toContain('\u2713')
  })

  it('dispatches a recipe selection to setTransitionRecipe', () => {
    const menu = setupMenu({ clip: makeClip({ id: 'c1' }), item: makeAudioFileItem() })
    const project = useProjectStore()
    project.tracks[0]!.transitions = [
      { id: 'tr-next', leftClipId: 'c1', rightClipId: 'c2', recipe: { kind: 'smooth' } }
    ] as never
    const set = vi.spyOn(project, 'setTransitionRecipe')
    menu.onContextMenuCommand('clip.setTransitionRecipe:tr-next:linear')
    expect(set).toHaveBeenCalledWith('track-1', 'tr-next', { kind: 'linear' })
  })

  it('omits remove-crossfade rows when the clip has no transitions', () => {
    const menu = setupMenu({ clip: makeClip({ id: 'c1' }), item: makeAudioFileItem() })
    expect(commandsOf(menu).some((c) => c.startsWith('clip.removeTransition:'))).toBe(false)
    expect(commandsOf(menu).some((c) => c.startsWith('clip.setTransitionRecipe:'))).toBe(false)
  })
})

describe('useTimelineContextMenu — command dispatch', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('openEditor / openInfo route to the dialog actions', () => {
    const clip = makeClip()
    const project = useProjectStore()
    const library = useLibraryStore()
    project.clips = { [clip.id]: clip }
    library.items = [makeAudioFileItem()]

    const dialogs = useClipDialogs()
    const openEditor = vi.spyOn(dialogs, 'openEditor')
    const openInfo = vi.spyOn(dialogs, 'openInfo')
    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs
    })
    menu.contextMenuClipId.value = clip.id

    menu.onContextMenuCommand('clip.openEditor')
    expect(openEditor).toHaveBeenCalledWith(clip.id)

    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.info')
    expect(openInfo).toHaveBeenCalledWith(clip.id)
  })

  it('warp / pitch route to openWarp with the correct panel', () => {
    const clip = makeClip()
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }

    const dialogs = useClipDialogs()
    const openWarp = vi.spyOn(dialogs, 'openWarp')
    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.warp')
    expect(openWarp).toHaveBeenLastCalledWith(clip.id, 'tempo')

    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.pitch')
    expect(openWarp).toHaveBeenLastCalledWith(clip.id, 'pitch')
  })

  it('separate stems item is present and routes to the injected starter', () => {
    const startStemSeparation = vi.fn()
    const clip = makeClip()
    const menu = setupMenu({ clip, item: makeAudioFileItem(), startStemSeparation })
    expect(findItem(menu, 'clip.separateStems')?.disabled).toBeFalsy()

    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.separateStems')
    expect(startStemSeparation).toHaveBeenCalledWith(clip.id)
  })

  it('separate stems is disabled for unresolved clips', () => {
    const menu = setupMenu({ clip: makeClip({ unresolved: true }), item: makeAudioFileItem() })
    expect(findItem(menu, 'clip.separateStems')?.disabled).toBe(true)
  })

  it('relink invokes the injected chooseAudioFile picker', async () => {
    const clip = makeClip({ filePath: 'C:\\folder\\src.wav', fileName: 'src.wav' })
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }
    const relinkSpy = vi.spyOn(project, 'relinkLibraryItem').mockImplementation(() => {})
    const chooseAudioFile = vi.fn().mockResolvedValue('C:\\new\\src.wav')

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs(),
      chooseAudioFile
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.relink')
    await Promise.resolve()
    await Promise.resolve()

    expect(chooseAudioFile).toHaveBeenCalledWith({
      title: 'Locate src.wav',
      defaultPath: 'C:\\folder'
    })
    expect(relinkSpy).toHaveBeenCalledWith(clip.libraryItemId, 'C:\\new\\src.wav')
  })

  it('command dispatch on a missing clip is a no-op', () => {
    const project = useProjectStore()
    project.clips = {}
    const removeSpy = vi.spyOn(project, 'removeClip').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = 'ghost'
    menu.onContextMenuCommand('clip.delete')
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('clip.color:<idx> sets the clip colour', () => {
    const clip = makeClip()
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }
    const colorSpy = vi.spyOn(project, 'setClipColor').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.color:7')
    expect(colorSpy).toHaveBeenCalledWith(clip.id, 7)
  })

  it('clip.lock / clip.unlock dispatch routes to project.setClipLocked', () => {
    const clip = makeClip()
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }
    const lockSpy = vi.spyOn(project, 'setClipLocked').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })

    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.lock')
    expect(lockSpy).toHaveBeenLastCalledWith(clip.id, true)

    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.unlock')
    expect(lockSpy).toHaveBeenLastCalledWith(clip.id, false)
  })

  it('clip.copy selects the clip + its track and copies it', () => {
    const clip = makeClip()
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }
    const selectClip = vi.spyOn(project, 'selectClip').mockImplementation(() => {})
    const selectTrack = vi.spyOn(project, 'selectTrack').mockImplementation(() => {})
    const copy = vi.spyOn(project, 'copySelectedClip').mockReturnValue(true)

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.copy')

    expect(selectClip).toHaveBeenCalledWith(clip.id)
    expect(selectTrack).toHaveBeenCalledWith(clip.trackId)
    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('clip.cut selects the clip + its track and cuts it', () => {
    const clip = makeClip()
    const project = useProjectStore()
    project.clips = { [clip.id]: clip }
    const selectClip = vi.spyOn(project, 'selectClip').mockImplementation(() => {})
    const selectTrack = vi.spyOn(project, 'selectTrack').mockImplementation(() => {})
    const cut = vi.spyOn(project, 'cutSelectedClip').mockReturnValue(true)

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.cut')

    expect(selectClip).toHaveBeenCalledWith(clip.id)
    expect(selectTrack).toHaveBeenCalledWith(clip.trackId)
    expect(cut).toHaveBeenCalledTimes(1)
  })

  it('clip.paste targets the clip\'s track and pastes at the playhead', () => {
    const clip = makeClip()
    const project = useProjectStore()
    const transport = useTransportStore()
    project.clips = { [clip.id]: clip }
    transport.positionMs = 1_234
    const selectTrack = vi.spyOn(project, 'selectTrack').mockImplementation(() => {})
    const paste = vi.spyOn(project, 'pasteClipAtPlayhead').mockReturnValue(null)

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.paste')

    expect(selectTrack).toHaveBeenCalledWith(clip.trackId)
    expect(paste).toHaveBeenCalledWith(1_234)
  })

  it('empty track-lane menu offers a single Paste, gated on the clipboard', () => {
    const project = useProjectStore()
    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = null
    menu.contextMenuTrackId.value = 'track-1'

    expect(menu.contextMenuItems.value.map((i) => i.command)).toEqual(['track.paste'])
    expect(menu.contextMenuItems.value[0]?.disabled).toBe(true)

    project.clipboardClip = { libraryItemId: 'src' } as never
    expect(menu.contextMenuItems.value[0]?.disabled).toBeFalsy()
  })

  it('track.paste targets the right-clicked track and pastes at the playhead', () => {
    const project = useProjectStore()
    const transport = useTransportStore()
    transport.positionMs = 2_500
    const selectTrack = vi.spyOn(project, 'selectTrack').mockImplementation(() => {})
    const paste = vi.spyOn(project, 'pasteClipAtPlayhead').mockReturnValue(null)

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = null
    menu.contextMenuTrackId.value = 'track-9'
    menu.onContextMenuCommand('track.paste')

    expect(selectTrack).toHaveBeenCalledWith('track-9')
    expect(paste).toHaveBeenCalledWith(2_500)
    // Target is cleared after dispatch.
    expect(menu.contextMenuTrackId.value).toBeNull()
  })

  it('clip.reverse toggles project.setClipReversed for a source clip', () => {
    const clip = makeClip()
    const project = useProjectStore()
    const library = useLibraryStore()
    project.clips = { [clip.id]: clip }
    library.items = [makeAudioFileItem('src')]
    const reverseSpy = vi.spyOn(project, 'setClipReversed').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.reverse')
    expect(reverseSpy).toHaveBeenCalledWith(clip.id, true)
  })

  it('clip.reverse on a linked saved clip routes to library.updateLibraryClipReversed', () => {
    const clip = makeClip({ libraryItemId: 'saved', reversed: true })
    const project = useProjectStore()
    const library = useLibraryStore()
    project.clips = { [clip.id]: clip }
    library.items = [makeLibraryClipItem('saved')]
    const propagateSpy = vi
      .spyOn(library, 'updateLibraryClipReversed')
      .mockImplementation(() => ({ ok: true }))
    const directSpy = vi.spyOn(project, 'setClipReversed').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.reverse')
    expect(propagateSpy).toHaveBeenCalledWith('saved', false)
    expect(directSpy).not.toHaveBeenCalled()
  })

  it('clip.brake on a linked saved clip routes to library.updateLibraryClipBrake', () => {
    const clip = makeClip({ libraryItemId: 'saved' })
    const project = useProjectStore()
    const library = useLibraryStore()
    project.clips = { [clip.id]: clip }
    library.items = [makeLibraryClipItem('saved')]
    const propagateSpy = vi
      .spyOn(library, 'updateLibraryClipBrake')
      .mockImplementation(() => ({ ok: true }))
    const directSpy = vi.spyOn(project, 'setClipBrake').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.brake')
    expect(propagateSpy).toHaveBeenCalledWith('saved', true)
    expect(directSpy).not.toHaveBeenCalled()
  })

  it('clip.backspin on an unlinked clip sets it directly on the instance', () => {
    const clip = makeClip({ libraryItemId: 'src' })
    const project = useProjectStore()
    const library = useLibraryStore()
    project.clips = { [clip.id]: clip }
    library.items = [makeAudioFileItem('src')]
    const propagateSpy = vi
      .spyOn(library, 'updateLibraryClipBackspin')
      .mockImplementation(() => ({ ok: true }))
    const directSpy = vi.spyOn(project, 'setClipBackspin').mockImplementation(() => {})

    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuClipId.value = clip.id
    menu.onContextMenuCommand('clip.backspin')
    expect(directSpy).toHaveBeenCalledWith(clip.id, true)
    expect(propagateSpy).not.toHaveBeenCalled()
  })

  it('reverse / brake / backspin are a mutually-exclusive group (all visible, others disabled)', () => {
    // Brake on: brake enabled, reverse + backspin disabled but still present.
    const brakeMenu = setupMenu({ clip: makeClip({ brake: true }) })
    expect(commandsOf(brakeMenu)).toEqual(
      expect.arrayContaining(['clip.reverse', 'clip.brake', 'clip.backspin'])
    )
    expect(findItem(brakeMenu, 'clip.brake')?.disabled).toBeFalsy()
    expect(findItem(brakeMenu, 'clip.reverse')?.disabled).toBe(true)
    expect(findItem(brakeMenu, 'clip.backspin')?.disabled).toBe(true)

    // Reversed: reverse enabled, brake + backspin disabled but still present.
    const revMenu = setupMenu({ clip: makeClip({ reversed: true }) })
    expect(commandsOf(revMenu)).toEqual(
      expect.arrayContaining(['clip.reverse', 'clip.brake', 'clip.backspin'])
    )
    expect(findItem(revMenu, 'clip.reverse')?.disabled).toBeFalsy()
    expect(findItem(revMenu, 'clip.brake')?.disabled).toBe(true)
    expect(findItem(revMenu, 'clip.backspin')?.disabled).toBe(true)

    // No effect: all three enabled.
    const plainMenu = setupMenu({ clip: makeClip() })
    expect(findItem(plainMenu, 'clip.reverse')?.disabled).toBeFalsy()
    expect(findItem(plainMenu, 'clip.brake')?.disabled).toBeFalsy()
    expect(findItem(plainMenu, 'clip.backspin')?.disabled).toBeFalsy()
  })

  it('onContextMenuClose clears state', () => {
    const menu = useTimelineContextMenu({
      host: ref(null),
      scrollX: ref(0),
      scrollY: ref(0),
      getClipHitRegions: () => [],
      headerWidth: () => 200,
      dialogs: useClipDialogs()
    })
    menu.contextMenuOpen.value = true
    menu.contextMenuClipId.value = 'x'
    menu.onContextMenuClose()
    expect(menu.contextMenuOpen.value).toBe(false)
    expect(menu.contextMenuClipId.value).toBe(null)
  })
})
