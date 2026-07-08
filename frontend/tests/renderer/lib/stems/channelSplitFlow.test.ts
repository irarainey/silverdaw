import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  requestChannelSplitForClip,
  confirmChannelSplit,
  cancelChannelSplit,
  toggleChannelSelection,
  useChannelSplitSelection
} from '@/lib/stems/channelSplitFlow'

const send = vi.fn()
vi.mock('@/lib/bridgeService', () => ({ send: (...args: unknown[]) => send(...args) }))
vi.mock('@/lib/log', () => ({ log: { info: vi.fn(), error: vi.fn() } }))

const registerChannelSplitJob = vi.fn()
vi.mock('@/lib/stems/createChannelSplitTracks', () => ({
  registerChannelSplitJob: (...args: unknown[]) => registerChannelSplitJob(...args)
}))

const clips: Record<string, unknown> = {
  stereo: { libraryItemId: 'stereo-item', startMs: 4000, inMs: 200, fileName: 'Song.wav' },
  mono: { libraryItemId: 'mono-item', startMs: 0, inMs: 0, fileName: 'Voice.wav' }
}
vi.mock('@/stores/projectStore', () => ({
  useProjectStore: () => ({ clips })
}))

const byId: Record<string, unknown> = {
  'stereo-item': { id: 'stereo-item', channelCount: 2 },
  'mono-item': { id: 'mono-item', channelCount: 1 }
}
vi.mock('@/stores/libraryStore', () => ({
  useLibraryStore: () => ({ byId }),
  libraryItemDisplayName: (item: { id: string }) => (item.id === 'stereo-item' ? 'Song.wav' : 'Voice.wav')
}))

const pushInfo = vi.fn()
const pushError = vi.fn()
vi.mock('@/stores/notificationsStore', () => ({
  useNotificationsStore: () => ({ pushInfo, pushError })
}))

const selection = useChannelSplitSelection()

beforeEach(() => {
  vi.clearAllMocks()
  cancelChannelSplit()
  vi.stubGlobal('crypto', { randomUUID: () => 'job-xyz' })
})

describe('channelSplitFlow', () => {
  it('opens the picker for a stereo clip with both channels ticked by default', () => {
    requestChannelSplitForClip('stereo')

    expect(selection.value).not.toBeNull()
    expect(selection.value?.target).toMatchObject({
      sourceItemId: 'stereo-item',
      sourceName: 'Song',
      clipId: 'stereo',
      startMs: 4000,
      sourceInMs: 200
    })
    expect(selection.value?.selected).toEqual({ left: true, right: true })
  })

  it('refuses a non-stereo clip and does not open the picker', () => {
    requestChannelSplitForClip('mono')

    expect(selection.value).toBeNull()
    expect(pushInfo).toHaveBeenCalledTimes(1)
  })

  it('dispatches CLIP_SPLIT_CHANNELS for the ticked channels and registers the job', () => {
    requestChannelSplitForClip('stereo') // both ticked by default
    confirmChannelSplit()

    expect(registerChannelSplitJob).toHaveBeenCalledWith('job-xyz', expect.objectContaining({ clipId: 'stereo' }))
    expect(send).toHaveBeenCalledWith('CLIP_SPLIT_CHANNELS', {
      jobId: 'job-xyz',
      clipId: 'stereo',
      sourceName: 'Song',
      channels: ['left', 'right']
    })
    expect(selection.value).toBeNull() // dialog closes
  })

  it('does nothing on confirm when no channel is ticked', () => {
    requestChannelSplitForClip('stereo') // both ticked by default
    toggleChannelSelection('left') // untick both → none ticked
    toggleChannelSelection('right')
    confirmChannelSplit()

    expect(send).not.toHaveBeenCalled()
    expect(registerChannelSplitJob).not.toHaveBeenCalled()
  })
})
