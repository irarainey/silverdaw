import { expect, it } from 'vitest'
import { buildSampleReport } from '@/lib/project/sampleReport'
import { projectRootFromPath, reportFilePath } from '@/lib/project/projectPath'
import type { LibraryItem } from '@/stores/libraryTypes'
import type { Clip, Track } from '@/stores/projectTypes'

it('attributes repeated stem placements to their original and separates file trim from warped play time', () => {
  const audio = { durationMs: 4000, sampleRate: 44100, channelCount: 1, peaks: new Float32Array() }
  const original: LibraryItem = {
    ...audio, id: 'o', kind: 'source', fileName: 'song.wav', filePath: 'C:\\song.wav',
    playbackFilePath: 'C:\\cache.wav', metadata: { title: 'Song', artist: 'A', album: 'LP' }
  }
  const stem: LibraryItem = {
    ...original, id: 's', kind: 'stem', fileName: 'drums.wav', filePath: 'C:\\drums.wav',
    metadata: undefined, derivedFrom: { sourceItemId: 'o', inMs: 1000, durationMs: 3000 }
  }
  const first: Clip = {
    ...audio, id: 'a', trackId: 't', libraryItemId: 's', filePath: stem.filePath,
    fileName: stem.fileName, inMs: 250, startMs: 100, durationMs: 500,
    effectiveDurationMs: 1000, unresolved: false
  }
  const track: Track = {
    id: 't', name: 'Drums', clipIds: ['a'], muted: true, soloed: false,
    volume: 1, colorIndex: 0, lengthMs: 5000
  }
  const result = buildSampleReport([track, { ...track, muted: false, soloed: true, id: 'u', clipIds: ['b', 'c', 'd'] }], {
    a: first, b: { ...first, id: 'b', trackId: 'u', startMs: 2000 },
    c: { ...first, id: 'c', trackId: 'u', libraryItemId: 'o' },
    d: { ...first, id: 'd', trackId: 'u', libraryItemId: 'other' }
  }, {
    o: original, s: stem, other: { ...original, id: 'other', filePath: 'C:\\another.wav', metadata: { title: 'Another' } }
  })
  expect(result.map(source => source.title)).toEqual(['Another', 'Song'])
  expect(result[1]).toMatchObject({
    path: original.filePath, artist: 'A', album: 'LP', hasSeparatedStems: true,
    usage: { placements: 3, stems: 1, passages: 2, unmapped: 0, excluded: 1, arrangedMs: 2000, includedMs: 2000 },
    files: [
      { path: stem.filePath, placements: [
        { fileType: 'Stem', track: '1. Drums', excluded: 'Muted', startMs: 100, endMs: 1100, durationMs: 1000, sourceStartMs: 250, sourceEndMs: 750, originalRange: { startMs: 1250, endMs: 1750 } },
        { track: '2. Drums', startMs: 2000, endMs: 3000 }
      ] },
      { path: original.filePath, placements: [{ id: 'c', fileType: 'Source' }] }
    ]
  })
  const vocals = { ...stem, id: 'v', filePath: 'C:\\vocals.wav' }
  const sample: LibraryItem = { ...vocals, kind: 'sample', derivedFrom: { sourceItemId: 's', inMs: 200, durationMs: 2000 } }
  const nestedReport = (item: LibraryItem) => buildSampleReport(
    [{ ...track, clipIds: ['a', 'b'] }],
    { a: first, b: { ...first, id: 'b', libraryItemId: 'v', startMs: 600 } },
    { o: original, s: stem, v: item }
  )[0]
  expect(nestedReport(sample)?.usage).toMatchObject({ passages: 1, knownOriginalMs: 700, arrangedMs: 1500 })
  expect(nestedReport({ ...sample, derivedFrom: { ...sample.derivedFrom!, unmapped: true } })?.usage)
    .toMatchObject({ passages: 1, knownOriginalMs: 500, unmapped: 1 })
  const separated = { a: first, b: { ...first, id: 'b', libraryItemId: 'v' } }
  const both = [{ ...track, clipIds: ['a', 'b'] }]
  const root = 'C:\\Mix'
  const artifacts = {
    s: { ...stem, derivedFrom: undefined, filePath: `${root}\\stems\\Song-stems-2\\drums.wav` },
    v: { ...vocals, kind: 'sample' as const, derivedFrom: undefined, filePath: `${root}\\samples\\Song\\cut.wav` }
  }
  const matched = buildSampleReport(both, separated, { ...artifacts, o: original }, root)
  expect(matched).toHaveLength(1)
  expect(matched[0]).toMatchObject({ path: original.filePath, pathMatch: 'project folder', title: 'Song' })
  const ambiguous = buildSampleReport(both, separated, {
    ...artifacts, o: original, other: { ...original, id: 'other', filePath: 'D:\\Song.mp3' }
  }, root)
  expect(ambiguous.some(source => source.pathMatch)).toBe(false)
  const metadata = { title: 'Song', artist: 'A', album: 'LP', recordingDurationMs: 82432.25 }
  const imported = {
    ...stem, filePath: `${root}\\stems\\import-s\\drums.wav`, mediaId: 'foreign',
    derivedFrom: { ...stem.derivedFrom!, sourceItemId: stem.id }, metadata
  }
  const independentlyImported = { ...original, mediaId: 'local', metadata }
  const importedReport = (other?: LibraryItem) => buildSampleReport([track], { a: first }, {
    o: independentlyImported, s: imported, ...(other && { other })
  }, root)
  expect(importedReport()[0]).toMatchObject({ path: original.filePath, pathMatch: 'recording metadata' })
  expect(importedReport()[0]?.usage).toMatchObject({ unmapped: 1, passages: 0, arrangedMs: 1000, includedMs: 0 })
  expect(importedReport({ ...independentlyImported, id: 'other', filePath: 'D:\\copy.mp3' })[0]?.path).toBe('')
  for (const library of [
    { s: stem, v: vocals },
    { s: { ...stem, mediaId: 'song', derivedFrom: undefined }, v: { ...vocals, mediaId: 'song', derivedFrom: undefined } }
  ]) {
    const groups = buildSampleReport(both, separated, library)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ path: '', title: 'Unidentified recording', files: [
      { path: stem.filePath, placements: [{ id: 'a' }] }, { path: vocals.filePath, placements: [{ id: 'b' }] }
    ] })
  }
})

it('counts a live scratch trim as a source window, not exact recording coverage', () => {
  const item: LibraryItem = {
    id: 'cut', kind: 'sample', fileName: 'cut.wav', filePath: 'C:\\cut.wav', playbackFilePath: '',
    durationMs: 2000, sampleRate: 48000, channelCount: 2, peaks: new Float32Array(),
    attribution: { recordingId: 'song', fileName: 'song.wav', startMs: 30000, endMs: 34000, ratio: 2 }
  }
  const clip: Clip = {
    id: 'live', libraryItemId: item.id, trackId: 't', filePath: item.filePath, fileName: item.fileName,
    sampleRate: item.sampleRate, channelCount: item.channelCount, peaks: item.peaks,
    inMs: 500, durationMs: 1000, startMs: 0, unresolved: false, scratchPatternId: 'repeat'
  }
  const track: Track = {
    id: 't', name: 'Scratch', clipIds: [clip.id], muted: false, soloed: false,
    volume: 1, colorIndex: 0, lengthMs: 1000
  }
  const [source] = buildSampleReport([track], { live: clip }, { cut: item })
  expect(source?.files[0]?.placements[0]?.originalWindow).toEqual({ startMs: 31000, endMs: 33000 })
  expect(source?.usage).toMatchObject({ arrangedMs: 1000, windowOnly: 1, passages: 0, knownOriginalMs: undefined })
})

it('shortens only files inside the displayed project root', () => {
  const root = projectRootFromPath('C:\\Projects\\Mix\\Mix.silverdaw')
  expect(root).toBe('C:\\Projects\\Mix')
  expect(reportFilePath('c:/projects/mix/stems/Drums.wav', root)).toBe('\\stems\\Drums.wav')
  const external = 'C:\\Projects\\Mixes\\song.mp3'
  expect(reportFilePath(external, root)).toBe(external)
  expect(reportFilePath(external, projectRootFromPath(null))).toBe(external)
})

it.each(['root', 'media'])('uses a unique current source for recording ID %s without double counting', recordingId => {
  const audio = { durationMs: 2000, sampleRate: 48000, channelCount: 2, peaks: new Float32Array() }
  const root: LibraryItem = {
    ...audio, id: 'root', mediaId: 'media', kind: 'source', fileName: 'relinked.wav',
    filePath: 'C:\\current\\relinked.wav', playbackFilePath: ''
  }
  const attribution = {
    recordingId, fileName: 'original.wav', title: 'Original recording', artist: 'Artist',
    startMs: 400, endMs: 2000, ratio: 2, parentId: 'foreign-parent', stemRole: 'vocals'
  }
  const stem: LibraryItem = {
    ...root, id: 's', kind: 'stem', mediaId: 'import-media', attribution, filePath: 'C:\\vocals.wav'
  }
  const saved: LibraryItem = {
    ...stem, id: 'saved', kind: 'clip', derivedFrom: { sourceItemId: 's', inMs: 100, durationMs: 500 }
  }
  const scratch: LibraryItem = {
    ...stem, id: 'scratch', kind: 'sample', filePath: 'C:\\scratch.wav', attribution: { ...attribution, ratio: undefined }
  }
  const clip: Clip = {
    ...audio, id: 's', trackId: 't', libraryItemId: 's', filePath: stem.filePath, fileName: 'vocals.wav',
    startMs: 0, inMs: 100, durationMs: 500, unresolved: false
  }
  const track: Track = {
    id: 't', name: 'Mix', clipIds: ['s', 'saved', 'scratch', 'root'], muted: false, soloed: false,
    volume: 1, colorIndex: 0, lengthMs: 5000
  }
  const clips = {
    s: clip, saved: { ...clip, id: 'saved', libraryItemId: 'saved' },
    scratch: { ...clip, id: 'scratch', libraryItemId: 'scratch' },
    root: { ...clip, id: 'root', libraryItemId: 'root', inMs: 600, durationMs: 1000 }
  }
  const report = buildSampleReport([track], clips, { root, s: stem, saved, scratch })
  expect(report).toHaveLength(1)
  expect(report[0]).toMatchObject({
    path: root.filePath, title: 'Original recording', artist: 'Artist',
    usage: { stems: 1, placements: 4, passages: 1, knownOriginalMs: 1000, arrangedMs: 1000, windowOnly: 1, unmapped: 0 }
  })
  const placements = report[0]!.files.flatMap(file => file.placements)
  for (const id of ['s', 'saved']) {
    expect(placements.find(use => use.id === id)).toMatchObject({
      originalRange: { startMs: 600, endMs: 1600 }, stemRole: 'vocals'
    })
  }
  const unknown = placements.find(use => use.id === 'scratch')
  expect(unknown?.originalRange).toBeUndefined()
  expect(unknown?.originalWindow).toEqual({ startMs: 400, endMs: 2000 })
  const ambiguous = { ...root, id: 'duplicate', attribution, filePath: 'D:\\other.wav' }
  const candidates: Record<string, LibraryItem>[] = [{}, { root, duplicate: ambiguous }]
  for (const library of candidates) {
    const [source] = buildSampleReport([{ ...track, clipIds: ['s', 'scratch'] }], clips, {
      ...library, s: stem, scratch
    })
    expect(source).toMatchObject({ path: 'original.wav', usage: { placements: 2 } })
  }
})

it('matches foreign stems to an independent import only by corroborated recording metadata', () => {
  const audio = { durationMs: 500, sampleRate: 48000, channelCount: 2, peaks: new Float32Array() }
  const root: LibraryItem = {
    ...audio, id: 'l1', kind: 'source', mediaId: 'independent-media', fileName: 'Song.mp3',
    filePath: 'E:\\Music\\Song.mp3', playbackFilePath: '', durationMs: 90000,
    metadata: { artist: 'Artist', title: 'Song', album: 'Album' }
  }
  const stem: LibraryItem = {
    ...audio, kind: 'stem', id: 'l2', fileName: 'drums.wav', filePath: 'C:\\import\\drums.wav', playbackFilePath: '',
    attribution: { recordingId: 'foreign-guid', fileName: 'song.MP3', title: 'Song', album: 'Album' },
    metadata: { artist: 'Artist', recordingDurationMs: 90000 }, derivedFrom: { sourceItemId: 'l2', inMs: 0, durationMs: 500 }
  }
  const clip: Clip = {
    ...audio, id: 'c', trackId: 't', libraryItemId: 'l2', fileName: 'drums.wav', filePath: stem.filePath,
    inMs: 0, startMs: 0, unresolved: false
  }
  const track: Track = {
    id: 't', name: 'Drums', clipIds: ['c'], muted: false, soloed: false, volume: 1, colorIndex: 0, lengthMs: 1000
  }
  const report = (item: LibraryItem, other?: LibraryItem) => buildSampleReport([track], { c: clip }, {
    l1: root, l2: item, ...(other && { other })
  })[0]
  expect(report(stem)).toMatchObject({ path: root.filePath, pathMatch: 'recording metadata' })
  const managedOutput = { ...root, metadata: { ...root.metadata, geometryOrigin: 'output' as const } }
  expect(buildSampleReport([track], { c: clip }, { l1: managedOutput, l2: stem })[0]?.path).toBe('song.MP3')
  expect(report({ ...stem, attribution: undefined, metadata: { ...root.metadata, durationMs: 90000 } })?.path)
    .toBe('')
  expect(report(stem, { ...root, id: 'other', filePath: 'D:\\Song.mp3' })?.path).toBe('song.MP3')
  expect(report(stem, { ...root, id: 'other', filePath: 'D:\\Copy.mp3' })?.path).toBe('song.MP3')
  expect(report({ ...stem, attribution: { ...stem.attribution!, fileName: 'other.mp3' } })?.path).toBe('other.mp3')
  expect(report({ ...stem, metadata: { artist: 'Artist', recordingDurationMs: 90050 } })?.path).toBe('song.MP3')
  // The original project also had an "l1". Even the same filename does not
  // corroborate that ID if the destination has no local parent relationship.
  expect(report({ ...stem, attribution: { ...stem.attribution!, recordingId: 'l1' }, metadata: undefined })?.path)
    .toBe('song.MP3')
})
