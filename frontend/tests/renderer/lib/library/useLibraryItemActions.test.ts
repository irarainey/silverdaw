import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryItemActions } from '@/lib/library/useLibraryItemActions'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

const reanalyseLibraryItemMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/importAudio', () => ({
  reanalyseLibraryItem: reanalyseLibraryItemMock
}))
vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

let counter = 0
function seedAudioFile(): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    kind: 'source',
    filePath: `C:\\audio\\loop-${++counter}.wav`,
    fileName: `loop-${counter}.wav`,
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  return library.byId[id]!
}

function seedLibraryClip(): LibraryItem {
  const library = useLibraryStore()
  const sourceId = seedAudioFile().id
  const id = library.addItem({
    kind: 'clip',
    filePath: `C:\\audio\\clip-${++counter}.wav`,
    fileName: `clip-${counter}.wav`,
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1]),
    derivedFrom: { sourceItemId: sourceId, inMs: 0, durationMs: 1_000 }
  })
  return library.byId[id]!
}

function seedStem(): LibraryItem {
  const library = useLibraryStore()
  const sourceId = seedAudioFile().id
  const id = library.addItem({
    kind: 'stem',
    filePath: `C:\\proj\\stems\\song\\vocals-${++counter}.wav`,
    fileName: `vocals-${counter}.wav`,
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1]),
    derivedFrom: { sourceItemId: sourceId, inMs: 0, durationMs: 1_000 }
  })
  return library.byId[id]!
}

describe('useLibraryItemActions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    counter = 0
    reanalyseLibraryItemMock.mockReset()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++counter}`) })
  })

  it('openItemContextMenu records the target item and screen position', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 12, clientY: 34 } as MouseEvent, item)
    expect(actions.contextMenu.value).toEqual({ itemId: item.id, x: 12, y: 34 })
    expect(actions.contextMenuItem.value?.id).toBe(item.id)
  })

  it('builds a source menu with reanalyse + classification rows', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.reanalyse')
    expect(commands).toContain('library.separateStems')
    expect(commands).toContain('library.classifyAuto')
    expect(commands).toContain('library.classifyMusic')
    expect(commands).toContain('library.classifySimple')
    expect(commands).toContain('library.delete')
    expect(commands).not.toContain('library.saveSample')
  })

  it('gives a stem reanalyse + classification but hides Separate Stems and Save as Sample', () => {
    const item = seedStem()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.reanalyse')
    expect(commands).toContain('library.classifyAuto')
    expect(commands).toContain('library.classifyMusic')
    expect(commands).toContain('library.classifySimple')
    // A stem is already a separated part, so it cannot be separated further.
    expect(commands).not.toContain('library.separateStems')
    expect(commands).not.toContain('library.saveMusicSample')
    expect(commands).not.toContain('library.saveSimpleSample')
  })

  it('offers music + simple sample rows for a saved clip and dispatches the chosen mode', () => {
    const item = seedLibraryClip()
    const library = useLibraryStore()
    const saveSpy = vi.spyOn(library, 'saveLibraryItemAsSample').mockImplementation(() => {})
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.saveMusicSample')
    expect(commands).toContain('library.saveSimpleSample')

    actions.onContextMenuCommand('library.saveMusicSample')
    expect(saveSpy).toHaveBeenCalledWith(item.id, 'music')

    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.saveSimpleSample')
    expect(saveSpy).toHaveBeenCalledWith(item.id, 'simple')
  })

  it('offers Remove Image for an image-bearing tile and dispatches the hide', () => {
    const item = seedAudioFile()
    item.coverArtUrl = 'blob:cover'
    const library = useLibraryStore()
    const hideSpy = vi.spyOn(library, 'setItemCoverArtHidden')
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    let commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.removeImage')
    expect(commands).not.toContain('library.restoreImage')

    actions.onContextMenuCommand('library.removeImage')
    expect(hideSpy).toHaveBeenCalledWith(item.id, true)

    // Once hidden, the menu offers Restore instead.
    item.coverArtHidden = true
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.restoreImage')
    expect(commands).not.toContain('library.removeImage')

    actions.onContextMenuCommand('library.restoreImage')
    expect(hideSpy).toHaveBeenCalledWith(item.id, false)
  })

  it('offers Update Image for any file tile and dispatches the picker', () => {
    const item = seedAudioFile()
    const library = useLibraryStore()
    const updateSpy = vi.spyOn(library, 'updateItemCoverArt').mockResolvedValue()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    // Available even with no current cover (you can add one).
    expect(actions.contextMenuItems.value.map((row) => row.command)).toContain('library.updateImage')

    actions.onContextMenuCommand('library.updateImage')
    expect(updateSpy).toHaveBeenCalledWith(item.id)
  })

  it('hides Remove Image for a tile with no cover art', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).not.toContain('library.removeImage')
    expect(commands).not.toContain('library.restoreImage')
  })

  it('offers Remove Image on a saved clip? no — only image-bearing file tiles', () => {
    const item = seedLibraryClip()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    // Saved clips are child rows with no tile image.
    expect(commands).not.toContain('library.removeImage')
    expect(commands).not.toContain('library.restoreImage')
  })

  it('returns no rows when no item is targeted', () => {
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    expect(actions.contextMenuItems.value).toEqual([])
  })

  it('edit / info commands open the matching dialog and close the menu', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)

    actions.onContextMenuCommand('library.edit')
    expect(actions.editorItem.value?.id).toBe(item.id)
    expect(actions.contextMenu.value).toBeNull()

    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.info')
    expect(actions.infoItem.value?.id).toBe(item.id)
  })

  it('rename command delegates to the injected rename starter', () => {
    const item = seedAudioFile()
    const startRename = vi.fn()
    const actions = useLibraryItemActions({ startRename })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.rename')
    expect(startRename).toHaveBeenCalledWith(item)
    expect(actions.contextMenu.value).toBeNull()
  })

  it('reanalyse command forwards the item id to the analyser', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.reanalyse')
    expect(reanalyseLibraryItemMock).toHaveBeenCalledWith(item.id)
  })

  it('classification commands update the item audio type', () => {
    const item = seedAudioFile()
    const library = useLibraryStore()
    const setMode = vi.spyOn(library, 'setItemAudioType')
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.classifySimple')
    expect(setMode).toHaveBeenCalledWith(item.id, 'simple')
  })

  it('delete command removes the item and closes a matching info dialog', () => {
    const item = seedAudioFile()
    const library = useLibraryStore()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.info')
    expect(actions.infoItem.value?.id).toBe(item.id)

    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.delete')
    expect(library.byId[item.id]).toBeUndefined()
    expect(actions.infoItem.value).toBeNull()
  })
})
