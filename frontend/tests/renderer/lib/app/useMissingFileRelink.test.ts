import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useMissingFileRelink } from '@/lib/app/useMissingFileRelink'
import { useLibraryStore } from '@/stores/libraryStore'
import { useNotificationsStore } from '@/stores/notificationsStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

type LibraryItem = ReturnType<typeof useLibraryStore>['items'][number]

function item(id: string, unresolved: boolean, filePath: string): LibraryItem {
  return { id, unresolved, filePath } as unknown as LibraryItem
}

describe('useMissingFileRelink', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('opens the relink dialog and toasts when a fresh missing set appears', async () => {
    const library = useLibraryStore()
    const notifications = useNotificationsStore()
    const push = vi.spyOn(notifications, 'push').mockImplementation(() => 0)

    const { relinkDialogOpen } = useMissingFileRelink()
    expect(relinkDialogOpen.value).toBe(false)

    library.items = [item('a', true, '/songs/a.wav'), item('b', true, '/songs/b.wav')]
    await nextTick()

    expect(relinkDialogOpen.value).toBe(true)
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith('error', expect.stringContaining('2 audio files are missing'))
  })

  it('uses singular wording for a single missing file', async () => {
    const library = useLibraryStore()
    const notifications = useNotificationsStore()
    const push = vi.spyOn(notifications, 'push').mockImplementation(() => 0)

    useMissingFileRelink()
    library.items = [item('a', true, '/songs/a.wav')]
    await nextTick()

    expect(push).toHaveBeenCalledWith('error', expect.stringContaining('1 audio file is missing'))
  })

  it('does not re-announce when the missing set has not grown', async () => {
    const library = useLibraryStore()
    const notifications = useNotificationsStore()
    const push = vi.spyOn(notifications, 'push').mockImplementation(() => 0)

    const { relinkDialogOpen } = useMissingFileRelink()
    library.items = [item('a', true, '/songs/a.wav')]
    await nextTick()
    relinkDialogOpen.value = false

    // Same unresolved set, plus an unrelated resolved item.
    library.items = [item('a', true, '/songs/a.wav'), item('c', false, '/songs/c.wav')]
    await nextTick()

    expect(relinkDialogOpen.value).toBe(false)
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('ignores transitions to an empty missing set', async () => {
    const library = useLibraryStore()
    const notifications = useNotificationsStore()
    const push = vi.spyOn(notifications, 'push').mockImplementation(() => 0)

    useMissingFileRelink()
    library.items = [item('a', true, '/songs/a.wav')]
    await nextTick()
    push.mockClear()

    library.items = [item('a', false, '/songs/a.wav')]
    await nextTick()
    expect(push).not.toHaveBeenCalled()
  })
})
