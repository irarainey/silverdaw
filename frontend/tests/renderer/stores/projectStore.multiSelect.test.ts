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

/** Build `moveClipGroup` origins for the given clip ids from their current positions. */
function originsFor(project: Project, ids: string[]) {
  return ids.map((id) => {
    const c = project.clips[id]!
    return { clipId: id, startMs: c.startMs, trackIndex: project.tracks.findIndex((t) => t.id === c.trackId) }
  })
}

describe('projectStore — atomic group move (moveClipGroup)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
    uuidCounter = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++uuidCounter}`) })
    vi.stubGlobal('window', { silverdaw: { readAudioMetadata: vi.fn().mockResolvedValue(null) } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('applies a uniform delta to the whole group when it fits', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2) // at 0 and 2000
    const origins = originsFor(project, [a!, b!])

    expect(project.moveClipGroup(origins, 500, 0)).toBe(true)
    expect(project.clips[a!]!.startMs).toBe(500)
    expect(project.clips[b!]!.startMs).toBe(2500)
  })

  it('lets group members pass through each other (only non-group clips block)', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    // Two adjacent clips (0–1000, 1000–2000-ish); the default 2000 spacing keeps a gap.
    const [a, b] = addClips(project, track, 2)
    const origins = originsFor(project, [a!, b!])
    // Move the group so `a` lands where `b` was — allowed because `b` moves too.
    expect(project.moveClipGroup(origins, 2000, 0)).toBe(true)
    expect(project.clips[a!]!.startMs).toBe(2000)
    expect(project.clips[b!]!.startMs).toBe(4000)
  })

  it('rejects the whole move when a target overlaps a clip outside the group', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 3) // 0, 2000, 4000
    const origins = originsFor(project, [a!, b!]) // the 4000 clip stays put
    const beforeA = project.clips[a!]!.startMs
    const beforeB = project.clips[b!]!.startMs

    // +2000 would push b onto c (4000) — reject the whole group, no change.
    expect(project.moveClipGroup(origins, 2000, 0)).toBe(false)
    expect(project.clips[a!]!.startMs).toBe(beforeA)
    expect(project.clips[b!]!.startMs).toBe(beforeB)
  })

  it('moves the group across tracks, reparenting each clip', () => {
    const project = useProjectStore()
    const t1 = project.addTrack()
    const t2 = project.addTrack()
    const [a] = addClips(project, t1, 1)
    const origins = originsFor(project, [a!])

    expect(project.moveClipGroup(origins, 0, 1)).toBe(true)
    expect(project.clips[a!]!.trackId).toBe(t2)
    expect(project.tracks.find((t) => t.id === t2)!.clipIds).toContain(a)
    expect(project.tracks.find((t) => t.id === t1)!.clipIds).not.toContain(a)
  })

  it('rejects the move when any group clip is locked', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)
    project.setClipLocked(b!, true)
    const origins = originsFor(project, [a!, b!])

    expect(project.moveClipGroup(origins, 500, 0)).toBe(false)
    expect(project.clips[a!]!.startMs).toBe(0)
  })

  it('rejects out-of-bounds moves (negative start or track index)', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a] = addClips(project, track, 1)
    const origins = originsFor(project, [a!])

    expect(project.moveClipGroup(origins, -5000, 0)).toBe(false)
    expect(project.moveClipGroup(origins, 0, 5)).toBe(false)
    expect(project.moveClipGroup(origins, 0, -1)).toBe(false)
    expect(project.clips[a!]!.startMs).toBe(0)
  })

  it('clampGroupDeltaMs returns the requested delta unchanged when the whole group fits', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 3) // 0–1000, 2000–3000, 4000–5000 (c stays out)
    const origins = originsFor(project, [a!, b!])

    // +500 leaves b at 2500–3500, clear of c at 4000 — no clamp needed.
    expect(project.clampGroupDeltaMs(origins, 500, 0)).toBe(500)
  })

  it('clampGroupDeltaMs clamps a rightward drag so the group butts against the next clip', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 3) // c at 4000–5000 is outside the group
    const origins = originsFor(project, [a!, b!])

    // +2000 would push b (ends 3000) onto c (starts 4000); clamp to +1000 so b ends exactly at 4000.
    expect(project.clampGroupDeltaMs(origins, 2000, 0)).toBe(1000)
    expect(project.moveClipGroup(origins, project.clampGroupDeltaMs(origins, 2000, 0), 0)).toBe(true)
    expect(project.clips[a!]!.startMs).toBe(1000)
    expect(project.clips[b!]!.startMs).toBe(3000)
  })

  it('clampGroupDeltaMs clamps a leftward drag to the timeline start and left neighbours', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const ids = addClips(project, track, 3) // ids[0] at 0–1000 stays outside the group
    const origins = originsFor(project, [ids[1]!, ids[2]!]) // clips at 2000 and 4000

    // Left edge is bounded by the first clip's end (1000): the 2000 clip can reach 1000, so the
    // requested -5000 clamps to -1000.
    expect(project.clampGroupDeltaMs(origins, -5000, 0)).toBe(-1000)
  })
})

/** Select `ids` as a multi-selection with `ids[0]` as the anchor/primary. */
function selectAll(project: Project, ids: string[]): void {
  project.selectClip(ids[0]!)
  for (let i = 1; i < ids.length; i++) project.toggleClipSelection(ids[i]!)
}

/** Start times of a track's clips, ascending. */
function trackStarts(project: Project, trackId: string): number[] {
  return project.tracks
    .find((t) => t.id === trackId)!
    .clipIds.map((id) => project.clips[id]!.startMs)
    .sort((a, b) => a - b)
}

describe('projectStore — multi-clip clipboard (copy/cut/paste)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    sendMock.mockReturnValue(true)
    uuidCounter = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++uuidCounter}`) })
    vi.stubGlobal('window', { silverdaw: { readAudioMetadata: vi.fn().mockResolvedValue(null) } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copySelectedClips captures relative offsets and supersedes the single-clip buffer', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2) // 0 and 2000
    project.selectClip(a!)
    expect(project.copySelectedClip()).toBe(true)
    expect(project.clipboardClip).not.toBeNull()

    selectAll(project, [a!, b!])
    expect(project.copySelectedClips()).toBe(true)
    expect(project.clipboardClip).toBeNull() // multi copy clears the single buffer
    const items = project.clipboardClips!.items
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.relStartMs).sort((x, y) => x - y)).toEqual([0, 2000])
    expect(items.every((i) => i.relTrackIndex === 0)).toBe(true)
  })

  it('pastes the whole group at the playhead, preserving spacing', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2) // 0 and 2000
    selectAll(project, [a!, b!])
    project.copySelectedClips()

    project.selectTrack(track)
    const primary = project.pasteClipsAtPlayhead(5_000)
    expect(primary).toBeTruthy()
    // Originals at 0/2000 plus pasted at 5000/7000 (2000 spacing preserved).
    expect(trackStarts(project, track)).toEqual([0, 2_000, 5_000, 7_000])
    // Selection moves to the two pasted clips.
    expect(project.selectedClipIds.size).toBe(2)
    expect(project.isClipSelected(a!)).toBe(false)
  })

  it('preserves cross-track offsets, extending downward from the target track', () => {
    const project = useProjectStore()
    const t1 = project.addTrack()
    const t2 = project.addTrack()
    const t3 = project.addTrack()
    const [a] = addClips(project, t1, 1) // t1 @0
    const [b] = addClips(project, t2, 1) // t2 @0
    selectAll(project, [a!, b!]) // anchor track = t1 (index 0): rel tracks 0 and 1

    project.copySelectedClips()
    project.selectTrack(t2) // paste anchor on t2 → items land on t2 and t3
    const primary = project.pasteClipsAtPlayhead(3_000)

    expect(project.clips[primary!]!.trackId).toBe(t2)
    expect(trackStarts(project, t2)).toEqual([0, 3_000]) // original @0 + pasted @3000
    expect(trackStarts(project, t3)).toEqual([3_000]) // pasted one track down
  })

  it('rejects the whole paste atomically when any clip overlaps an existing clip', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 3) // 0, 2000, 4000 (the 4000 clip stays put)
    selectAll(project, [a!, b!])
    project.copySelectedClips()

    project.selectTrack(track)
    const before = project.tracks.find((t) => t.id === track)!.clipIds.length
    // Anchor at 4000 → a→4000 overlaps the clip already at 4000; reject everything.
    expect(project.pasteClipsAtPlayhead(4_000)).toBeNull()
    expect(project.tracks.find((t) => t.id === track)!.clipIds.length).toBe(before)
  })

  it('rejects when track clamping collapses clips onto the last track and they overlap', () => {
    const project = useProjectStore()
    const t1 = project.addTrack()
    const t2 = project.addTrack()
    const t3 = project.addTrack()
    const [a] = addClips(project, t1, 1) // t1 @0
    const [b] = addClips(project, t2, 1) // t2 @0 (same rel start as a)
    selectAll(project, [a!, b!]) // rel tracks 0 and 1, both rel start 0

    project.copySelectedClips()
    project.selectTrack(t3) // t3 is the last track: both clips clamp onto it at the same start
    expect(project.pasteClipsAtPlayhead(5_000)).toBeNull()
    expect(project.tracks.find((t) => t.id === t3)!.clipIds.length).toBe(0)
  })

  it('cutSelectedClips copies the group, removes the clips, and clears the selection', () => {
    const project = useProjectStore()
    const track = project.addTrack()
    const [a, b] = addClips(project, track, 2)
    selectAll(project, [a!, b!])

    expect(project.cutSelectedClips()).toBe(true)
    expect(project.clipboardClips!.items).toHaveLength(2)
    expect(project.clips[a!]).toBeUndefined()
    expect(project.clips[b!]).toBeUndefined()
    expect(project.selectedClipIds.size).toBe(0)
  })
})

