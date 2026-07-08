import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

let uuidCounter = 0

type Project = ReturnType<typeof useProjectStore>

/** Add `count` source clips to `trackId`, spaced so they never overlap. Returns their ids. */
function addClips(project: Project, trackId: string, count: number, startMs = 0): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const id = project.addClipFromLibrary(
      trackId,
      {
        id: `lib-${trackId}-${i}`,
        kind: 'source',
        name: `clip ${i}`,
        filePath: `C:\\audio\\${trackId}-${i}.wav`,
        fileName: `${trackId}-${i}.wav`,
        durationMs: 1_000,
        sampleRate: 48_000,
        channelCount: 2,
        peaks: new Float32Array([0, 1]),
        playbackFilePath: `C:\\audio\\${trackId}-${i}.wav`
      },
      startMs + i * 2_000
    )
    if (id) ids.push(id)
  }
  return ids
}

describe('projectStore — multi-clip selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
    uuidCounter = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++uuidCounter}`) })
    vi.stubGlobal('window', {
      silverdaw: { readAudioMetadata: vi.fn().mockResolvedValue(null) }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('selectClip keeps the multi-selection set in sync and clears it', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)

    project.selectClip(a!)
    expect(project.selectedClipId).toBe(a)
    expect([...project.selectedClipIds]).toEqual([a])
    expect(project.isClipSelected(a!)).toBe(true)
    expect(project.isClipSelected(b!)).toBe(false)

    project.selectClip(null)
    expect(project.selectedClipId).toBeNull()
    expect(project.selectedClipIds.size).toBe(0)
  })

  it('toggleClipSelection adds and removes clips, keeping a sensible anchor', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b, c] = addClips(project, track, 3)

    project.selectClip(a!)
    project.toggleClipSelection(b!)
    expect(project.selectedClipIds.has(a!)).toBe(true)
    expect(project.selectedClipIds.has(b!)).toBe(true)
    expect(project.selectedClipId).toBe(b) // last-added becomes anchor

    project.toggleClipSelection(c!)
    expect(project.selectedClipCount).toBe(3)

    // Removing the anchor picks a remaining member as the new anchor.
    project.toggleClipSelection(c!)
    expect(project.selectedClipIds.has(c!)).toBe(false)
    expect(project.selectedClipId).not.toBe(c)
    expect(project.selectedClipIds.has(project.selectedClipId!)).toBe(true)
  })

  it('selectClipRange selects a same-track range ordered by start time', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b, c, d] = addClips(project, track, 4)

    project.selectClip(a!)
    project.selectClipRange(c!)
    expect([...project.selectedClipIds].sort()).toEqual([a, b, c].sort())
    // The anchor is preserved so a second range pivots on it.
    expect(project.selectedClipId).toBe(a)

    project.selectClipRange(d!)
    expect(project.selectedClipCount).toBe(4)
  })

  it('selectClipRange falls back to a singleton across tracks', () => {
    const project = useProjectStore()
    const t1 = project.addTrack()
    const t2 = project.addTrack()
    const [a] = addClips(project, t1, 1)
    const [x] = addClips(project, t2, 1)

    project.selectClip(a!)
    project.selectClipRange(x!)
    expect([...project.selectedClipIds]).toEqual([x])
    expect(project.selectedClipId).toBe(x)
  })

  it('reconcileClipSelection drops ids that no longer exist', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)
    project.selectClip(a!)
    project.toggleClipSelection(b!)

    // Simulate an undo that removed a clip without going through removeClip.
    delete project.clips[a!]
    project.reconcileClipSelection()
    expect(project.selectedClipIds.has(a!)).toBe(false)
    expect(project.selectedClipIds.has(b!)).toBe(true)
    expect(project.selectedClipId).toBe(b)
  })

  it('deleteSelectedClips removes every selected clip as one undo step and clears selection', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b, c] = addClips(project, track, 3)
    project.selectClip(a!)
    project.toggleClipSelection(b!)
    project.toggleClipSelection(c!)
    sendMock.mockClear()

    project.deleteSelectedClips()
    expect(project.clips[a!]).toBeUndefined()
    expect(project.clips[b!]).toBeUndefined()
    expect(project.clips[c!]).toBeUndefined()
    expect(project.selectedClipIds.size).toBe(0)
    // Wrapped in a single undo group.
    expect(sendMock).toHaveBeenCalledWith('EDIT_GROUP_BEGIN', expect.anything())
    expect(sendMock).toHaveBeenCalledWith('EDIT_GROUP_END')
  })

  it('setSelectedClipsLocked and setSelectedClipsColor apply to all selected', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)
    project.selectClip(a!)
    project.toggleClipSelection(b!)

    project.setSelectedClipsLocked(true)
    expect(project.clips[a!]!.locked).toBe(true)
    expect(project.clips[b!]!.locked).toBe(true)

    project.setSelectedClipsColor(3)
    expect(project.clips[a!]!.colorIndex).toBe(3)
    expect(project.clips[b!]!.colorIndex).toBe(3)
  })

  it('duplicateSelectedClips duplicates all and selects the copies', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)
    project.selectClip(a!)
    project.toggleClipSelection(b!)
    const before = Object.keys(project.clips).length

    project.duplicateSelectedClips()
    expect(Object.keys(project.clips).length).toBe(before + 2)
    // The new copies become the selection.
    expect(project.selectedClipCount).toBe(2)
    expect(project.selectedClipIds.has(a!)).toBe(false)
  })
})
