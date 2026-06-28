import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/lib/bridgeService'
import { runInUndoGroup } from '@/lib/undo/undoGroup'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { useLibraryStore } from '@/stores/libraryStore'

vi.mock('@/lib/bridgeService', () => ({ send: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({ PEAKS_PER_SECOND: 200, decodeAudioToPeaks: vi.fn() }))

const sendMock = vi.mocked(send)

/** The ordered list of bridge message types sent during the test. */
function sentTypes(): string[] {
  return sendMock.mock.calls.map((c) => c[0] as string)
}

function makeClip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    trackId: 't1',
    libraryItemId: 'lib1',
    filePath: 'C:\\x.wav',
    fileName: 'x.wav',
    startMs: 0,
    inMs: 0,
    durationMs: 1000,
    sampleRate: 48_000,
    channelCount: 2,
    peaks: new Float32Array(),
    unresolved: false,
    ...overrides
  } as Clip
}

describe('runInUndoGroup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-1') })
  })

  it('brackets the body sends with EDIT_GROUP_BEGIN / EDIT_GROUP_END and returns the body result', () => {
    const result = runInUndoGroup('Test', () => {
      send('CLIP_TRIM', { clipId: 'c1', startMs: 0, inMs: 0, durationMs: 1 })
      return 42
    })
    expect(result).toBe(42)
    expect(sentTypes()).toEqual(['EDIT_GROUP_BEGIN', 'CLIP_TRIM', 'EDIT_GROUP_END'])
    expect(sendMock.mock.calls[0]).toEqual(['EDIT_GROUP_BEGIN', { label: 'Test' }])
  })

  it('always closes the group even if the body throws', () => {
    expect(() =>
      runInUndoGroup('Boom', () => {
        send('CLIP_REMOVE', { clipId: 'c1' })
        throw new Error('boom')
      })
    ).toThrow('boom')
    expect(sentTypes()).toEqual(['EDIT_GROUP_BEGIN', 'CLIP_REMOVE', 'EDIT_GROUP_END'])
  })
})

describe('compound clip actions are one undo group', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'new-clip-id') })
  })

  it('splitClipAt brackets the trim + add (+ replay) in a single group', () => {
    const project = useProjectStore()
    project.tracks = [
      {
        id: 't1',
        name: 'Track 1',
        clipIds: ['c1'],
        volume: 1,
        lengthMs: 1000
      } as never
    ]
    project.clips = { c1: makeClip({ name: 'My Clip' }) }

    const newId = project.splitClipAt('c1', 500)
    expect(newId).toBe('new-clip-id')

    const types = sentTypes()
    // Exactly one group wraps every undoable send.
    expect(types.filter((t) => t === 'EDIT_GROUP_BEGIN')).toHaveLength(1)
    expect(types.filter((t) => t === 'EDIT_GROUP_END')).toHaveLength(1)
    expect(types[0]).toBe('EDIT_GROUP_BEGIN')
    expect(types[types.length - 1]).toBe('EDIT_GROUP_END')
    // The trim and the new-clip add both fall inside the group.
    const begin = types.indexOf('EDIT_GROUP_BEGIN')
    const end = types.indexOf('EDIT_GROUP_END')
    expect(types.indexOf('CLIP_TRIM')).toBeGreaterThan(begin)
    expect(types.indexOf('CLIP_TRIM')).toBeLessThan(end)
    expect(types.indexOf('CLIP_ADD')).toBeGreaterThan(begin)
    expect(types.indexOf('CLIP_ADD')).toBeLessThan(end)
  })
})

describe('library-clip edits propagate inside one undo group', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'x') })
  })

  it('updateLibraryClipEnvelope wraps the per-clip CLIP_SET_ENVELOPE sends in one group', () => {
    const project = useProjectStore()
    project.clips = {
      a: makeClip({ id: 'a', libraryItemId: 'libC' }),
      b: makeClip({ id: 'b', libraryItemId: 'libC' })
    }
    const library = useLibraryStore()
    library.items = [
      {
        id: 'libC',
        kind: 'clip',
        fileName: 'c.wav',
        filePath: 'C:\\c.wav',
        durationMs: 1000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array(),
        derivedFrom: { sourceItemId: 'src', sourceClipId: '', inMs: 0, durationMs: 1000 }
      } as never
    ]
    sendMock.mockClear()

    const res = library.updateLibraryClipEnvelope('libC', [
      { t: 0, v: 1 },
      { t: 1, v: 0 }
    ] as never)
    expect(res.ok).toBe(true)

    const types = sentTypes()
    expect(types[0]).toBe('EDIT_GROUP_BEGIN')
    expect(types[types.length - 1]).toBe('EDIT_GROUP_END')
    // Both linked instances' envelope pushes are inside the one group.
    expect(types.filter((t) => t === 'EDIT_GROUP_BEGIN')).toHaveLength(1)
    expect(types.filter((t) => t === 'CLIP_SET_ENVELOPE')).toHaveLength(2)
  })
})
