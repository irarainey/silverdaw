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
    kind: 'audio-file',
    filePath: `C:\\audio\\loop-${++counter}.wav`,
    fileName: `loop-${counter}.wav`,
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  return library.byId[id]!
}

function seedSavedClip(): LibraryItem {
  const library = useLibraryStore()
  const sourceId = seedAudioFile().id
  const id = library.addItem({
    kind: 'saved-clip',
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

  it('builds an audio-file menu with reanalyse + classification rows', () => {
    const item = seedAudioFile()
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    const commands = actions.contextMenuItems.value.map((row) => row.command)
    expect(commands).toContain('library.reanalyse')
    expect(commands).toContain('library.classifyAuto')
    expect(commands).toContain('library.classifyMusic')
    expect(commands).toContain('library.classifySample')
    expect(commands).toContain('library.delete')
    expect(commands).not.toContain('library.saveSample')
  })

  it('offers music + simple sample rows for a saved clip and dispatches the chosen mode', () => {
    const item = seedSavedClip()
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
    expect(saveSpy).toHaveBeenCalledWith(item.id, 'sample')
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

  it('classification commands update the item sample mode', () => {
    const item = seedAudioFile()
    const library = useLibraryStore()
    const setMode = vi.spyOn(library, 'setItemSampleMode')
    const actions = useLibraryItemActions({ startRename: vi.fn() })
    actions.openItemContextMenu({ clientX: 0, clientY: 0 } as MouseEvent, item)
    actions.onContextMenuCommand('library.classifySample')
    expect(setMode).toHaveBeenCalledWith(item.id, 'sample')
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
