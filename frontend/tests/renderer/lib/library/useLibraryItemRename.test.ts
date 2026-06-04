import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useLibraryItemRename } from '@/lib/library/useLibraryItemRename'
import { useLibraryStore, type LibraryItem } from '@/stores/libraryStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audio', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

function seedItem(): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    filePath: 'C:\\audio\\loop.wav',
    fileName: 'loop.wav',
    durationMs: 1_000,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  return library.byId[id]!
}

describe('useLibraryItemRename', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${Math.random()}`) })
  })

  it('startRename seeds the editing state with the display name', async () => {
    const item = seedItem()
    const rename = useLibraryItemRename()
    const input = { focus: vi.fn(), select: vi.fn() }
    rename.setNameInputEl(input as unknown as HTMLInputElement)
    await rename.startRename(item)
    expect(rename.editingItemId.value).toBe(item.id)
    expect(rename.editingValue.value.length).toBeGreaterThan(0)
    expect(input.focus).toHaveBeenCalledTimes(1)
    expect(input.select).toHaveBeenCalledTimes(1)
  })

  it('commitRename persists the new name and ends the edit', async () => {
    const item = seedItem()
    const library = useLibraryStore()
    const renameItem = vi.spyOn(library, 'renameItem')
    const rename = useLibraryItemRename()
    await rename.startRename(item)
    rename.editingValue.value = 'My New Name'
    rename.commitRename()
    expect(renameItem).toHaveBeenCalledWith(item.id, 'My New Name')
    expect(rename.editingItemId.value).toBeNull()
  })

  it('cancelRename ends the edit without persisting', async () => {
    const item = seedItem()
    const library = useLibraryStore()
    const renameItem = vi.spyOn(library, 'renameItem')
    const rename = useLibraryItemRename()
    await rename.startRename(item)
    rename.cancelRename()
    expect(renameItem).not.toHaveBeenCalled()
    expect(rename.editingItemId.value).toBeNull()
  })

  it('commitRename is a no-op when nothing is being edited', () => {
    const library = useLibraryStore()
    const renameItem = vi.spyOn(library, 'renameItem')
    const rename = useLibraryItemRename()
    rename.commitRename()
    expect(renameItem).not.toHaveBeenCalled()
  })

  it('Enter commits and Escape cancels via the document key handler', async () => {
    const item = seedItem()
    const rename = useLibraryItemRename()

    await rename.startRename(item)
    rename.onDocumentKeyDown({
      key: 'Enter',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as KeyboardEvent)
    expect(rename.editingItemId.value).toBeNull()

    await rename.startRename(item)
    rename.onDocumentKeyDown({
      key: 'Escape',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn()
    } as unknown as KeyboardEvent)
    expect(rename.editingItemId.value).toBeNull()
  })

  it('a pointer outside the input commits; inside is ignored', async () => {
    const item = seedItem()
    const library = useLibraryStore()
    const renameItem = vi.spyOn(library, 'renameItem')
    class FakeNode {}
    vi.stubGlobal('Node', FakeNode)
    const inside = new FakeNode()
    const outside = new FakeNode()
    const rename = useLibraryItemRename()
    const inputNode = { focus: vi.fn(), select: vi.fn(), contains: (n: unknown) => n === inside }
    rename.setNameInputEl(inputNode as unknown as HTMLInputElement)

    await rename.startRename(item)
    rename.onDocumentPointerDown({ target: inside } as unknown as PointerEvent)
    expect(rename.editingItemId.value).toBe(item.id)
    expect(renameItem).not.toHaveBeenCalled()

    rename.onDocumentPointerDown({ target: outside } as unknown as PointerEvent)
    expect(rename.editingItemId.value).toBeNull()
    expect(renameItem).toHaveBeenCalledTimes(1)
  })
})
