import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'
import { generateProject, projectDocument, verifyProject } from '../../performance/fixtures.ts'
import type { ProjectNode } from '../../e2e/helpers/projectDocument.ts'
import { selectScenarios } from '../../performance/scenarios.ts'
import { findNodes, readProjectDocument } from '../../e2e/helpers/projectDocument.ts'
import { assertProjectContent, expandedLaneHeight } from '../../performance/project-content.ts'
import {
  AutomationLaneViewSchema,
  AutomationParamIdSchema,
  TrackAutomationAppliedPayloadSchema
} from '../../src/shared/bridge-protocol'

const directories: string[] = []
const smoke = selectScenarios(['smoke'])[0]
async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'silverdaw-perf-unit-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true })
})

describe('performance project corpus', () => {
  it('reproduces identical portable project/audio bytes in different directories', async () => {
    const directory = await root()
    const first = await generateProject(join(directory, 'first'), smoke)
    const second = await generateProject(join(directory, 'second'), smoke)
    expect(first).toEqual(second)
    expect(await verifyProject(join(directory, 'first'))).toEqual(first)
    const document = readProjectDocument(join(directory, 'first', first.projectFile))!
    const tracks = findNodes(document, 'TRACK')
    const clips = findNodes(document, 'CLIP')
    const items = findNodes(document, 'ITEM')
    expect(tracks).toHaveLength(smoke.tracks)
    expect(clips).toHaveLength(smoke.clips)
    expect(items).toHaveLength(smoke.sources)
    expect(new Set([...tracks, ...clips, ...items].map((node) => node.id)).size).toBe(
      smoke.tracks + smoke.clips + smoke.sources
    )
    const sourceIds = new Set(items.map((item) => item.id))
    for (const clip of clips) expect(sourceIds.has(clip.libraryItemId)).toBe(true)
    for (const item of items) {
      expect(typeof item.filePath).toBe('string')
      expect(isAbsolute(String(item.filePath))).toBe(false)
      const audio = await readFile(resolve(directory, 'first', String(item.filePath)))
      expect(audio.subarray(0, 4).toString()).toBe('RIFF')
      expect(audio.readUInt32LE(24)).toBe(48000)
      expect(audio.subarray(44).some((byte) => byte !== 0)).toBe(true)
    }
    const starts = clips.map((clip) => Number(clip.offsetMs))
    for (const start of new Set(starts)) {
      expect(
        clips.filter(
          (clip) =>
            Number(clip.offsetMs) <= start &&
            Number(clip.offsetMs) + Number(clip.durationMs) > start
        ).length
      ).toBeLessThanOrEqual(smoke.voices)
    }
  })

  it('detects changed audio and refuses to overwrite an existing project directory', async () => {
    const directory = join(await root(), 'project')
    await generateProject(directory, smoke)
    await expect(generateProject(directory, smoke)).rejects.toThrow()
    await writeFile(join(directory, 'tone-1.wav'), 'changed')
    await expect(verifyProject(directory)).rejects.toThrow('Fixture changed: tone-1.wav')
  })

  it.each([
    { id: 'large', tracks: 16, clips: 128 },
    { id: 'stress', tracks: 32, clips: 512 },
    { id: 'extreme', tracks: 64, clips: 1024 }
  ])(
    'generates $id with $tracks populated tracks and $clips real clip references',
    async (expected) => {
      const scenario = selectScenarios(expected.id === 'large' ? [] : [expected.id])[0]
      const directory = join(await root(), expected.id)
      const manifest = await generateProject(directory, scenario)
      const document = readProjectDocument(join(directory, manifest.projectFile))!
      const tracks = findNodes(document, 'TRACK')
      expect(tracks).toHaveLength(expected.tracks)
      const sources = new Map(findNodes(document, 'ITEM').map((item) => [item.id, item]))
      for (const track of tracks) {
        const clips = findNodes(track, 'CLIP')
        expect(clips).toHaveLength(expected.clips / expected.tracks)
        expect(new Set(clips.map((clip) => clip.libraryItemId)).size).toBe(clips.length)
        expect(new Set(clips.map((clip) => clip.durationMs)).size).toBeGreaterThanOrEqual(4)
        for (const clip of clips) {
          expect(Number(clip.inMs)).toBeGreaterThanOrEqual(0)
          expect(Number(clip.inMs) + Number(clip.durationMs)).toBeLessThanOrEqual(
            Number(sources.get(clip.libraryItemId)!.durationMs)
          )
        }
      }
      const clips = findNodes(document, 'CLIP')
      expect(clips).toHaveLength(expected.clips)
      expect(new Set(clips.map((clip) => clip.id)).size).toBe(expected.clips)
      expect(Math.min(...clips.map((clip) => Number(clip.durationMs)))).toBeLessThan(500)
      expect(Math.max(...clips.map((clip) => Number(clip.durationMs)))).toBe(8000)
      expect(clips.some((clip) => Number(clip.inMs) > 0)).toBe(true)
      const events = clips.flatMap((clip) => [
        { time: Number(clip.offsetMs), delta: 1 },
        { time: Number(clip.offsetMs) + Number(clip.durationMs), delta: -1 }
      ])
      events.sort((a, b) => a.time - b.time || a.delta - b.delta)
      let voices = 0
      for (const event of events) {
        voices += event.delta
        expect(voices).toBeLessThanOrEqual(scenario.voices)
      }
      expect(voices).toBe(0)
      expect(await verifyProject(directory)).toEqual(manifest)
    }
  )

  it('reproduces varied audio, processing and real automation with visible lanes', async () => {
    const directory = await root()
    const scenario = selectScenarios(['large'])[0]
    const manifest = await generateProject(join(directory, 'first'), scenario)
    expect(await generateProject(join(directory, 'second'), scenario)).toEqual(manifest)
    const project = readProjectDocument(join(directory, 'first', manifest.projectFile))!
    const tracks = findNodes(project, 'TRACK')
    expect(tracks.some((track) => track.gain === 1 && track.pan === undefined)).toBe(true)
    for (const key of ['gain', 'pan', 'toneBassDb', 'toneTrebleDb']) {
      expect(new Set(tracks.map((track) => track[key])).size).toBeGreaterThan(2)
    }
    const automated = tracks.filter((track) => track.automation !== undefined)
    expect(automated.length).toBeGreaterThan(0)
    expect(automated.length).toBeLessThan(tracks.length)
    expect(expandedLaneHeight(project)).toBe(automated.length * 100)
    const frequencies: number[] = []
    for (const item of findNodes(project, 'ITEM')) {
      const wav = await readFile(join(directory, 'first', String(item.filePath)))
      const frames = wav.readUInt32LE(40) / 4
      expect(frames / 48).toBe(item.durationMs)
      let crossings = 0
      for (let frame = 1; frame < frames; frame++) {
        if (wav.readInt16LE(44 + (frame - 1) * 4) <= 0 && wav.readInt16LE(44 + frame * 4) > 0) {
          crossings++
        }
      }
      frequencies.push(crossings / (frames / 48000))
      expect(wav.readInt16LE(44)).toBe(0)
      expect(wav.readInt16LE(wav.length - 4)).toBe(0)
    }
    expect(new Set(frequencies).size).toBe(scenario.sources)
    expect(Math.max(...frequencies) / Math.min(...frequencies)).toBeGreaterThan(20)
    const curveSchema = TrackAutomationAppliedPayloadSchema.omit({ trackId: true, ok: true })
    for (const track of automated) {
      const lanes = curveSchema.array().min(1).parse(track.automation)
      const views = AutomationLaneViewSchema.array().min(1).parse(track.automationLaneView)
      expect(views.map((view) => view.paramId)).toEqual(lanes.map((lane) => lane.paramId))
      const clips = findNodes(track, 'CLIP')
      const start = Math.min(...clips.map((clip) => Number(clip.offsetMs)))
      const end = Math.max(...clips.map((clip) => Number(clip.offsetMs) + Number(clip.durationMs)))
      for (const lane of lanes) {
        AutomationParamIdSchema.parse(lane.paramId)
        expect(lane.points.length).toBeGreaterThanOrEqual(2)
        expect(new Set(lane.points.map((point) => point.value)).size).toBeGreaterThan(1)
        const times = lane.points.map((point) => point.timeMs)
        expect(times).toEqual([...new Set(times)].sort((a, b) => a - b))
        expect(times[0]).toBeGreaterThanOrEqual(start)
        expect(times[times.length - 1]).toBeLessThanOrEqual(end)
      }
    }
    const saved = structuredClone(project)
    const processed = findNodes(saved, 'TRACK').find((track) => track.pan !== undefined)!
    processed.gain = Math.fround(Number(processed.gain))
    expect(() => assertProjectContent(project, saved)).not.toThrow()
    processed.toneBassDb = 0
    expect(() => assertProjectContent(project, saved)).toThrow('changed toneBassDb')
    processed.toneBassDb = findNodes(project, 'TRACK').find(
      (track) => track.id === processed.id
    )!.toneBassDb
    delete processed.automation
    expect(() => assertProjectContent(project, saved)).toThrow('changed automation')
  })

  it('rejects unknown scenarios and invalid voice counts before writing', async () => {
    expect(() => selectScenarios(['typo'])).toThrow('Unknown scenario')
    await expect(
      generateProject(join(await root(), 'invalid'), {
        ...smoke,
        voices: smoke.tracks + 1
      })
    ).rejects.toThrow('Invalid benchmark scenario')
  })

  it.each(['chopped', 'longform'])(
    'generates ten-minute %s sessions with real overlapping layers and valid source windows',
    async (id) => {
      const scenario = selectScenarios([id])[0]
      const directory = join(await root(), id)
      const manifest = await generateProject(directory, scenario)
      const project = readProjectDocument(join(directory, manifest.projectFile))!
      expect(project.projectLengthMs).toBe(600000)
      const tracks = findNodes(project, 'TRACK')
      const clips = findNodes(project, 'CLIP')
      expect(tracks).toHaveLength(id === 'chopped' ? 24 : 8)
      expect(clips).toHaveLength(id === 'chopped' ? 2048 : 32)
      expect(new Set(clips.map((clip) => clip.id)).size).toBe(clips.length)
      const sources = new Map(findNodes(project, 'ITEM').map((item) => [item.id, item]))
      let contiguousSlices = 0
      for (const track of tracks) {
        const children = findNodes(track, 'CLIP')
        expect(children[0].offsetMs).toBe(0)
        const last = children[children.length - 1]
        expect(Number(last.offsetMs) + Number(last.durationMs)).toBe(600000)
        for (let i = 0; i < children.length; i++) {
          const clip = children[i]
          const source = sources.get(clip.libraryItemId)!
          expect(Number(clip.durationMs)).toBeGreaterThan(0)
          expect(Number(clip.inMs)).toBeGreaterThanOrEqual(0)
          expect(Number(clip.inMs) + Number(clip.durationMs)).toBeLessThanOrEqual(
            Number(source.durationMs)
          )
          if (i === 0) continue
          const previous = children[i - 1]
          expect(Number(previous.offsetMs) + Number(previous.durationMs)).toBe(clip.offsetMs)
          if (
            previous.libraryItemId === clip.libraryItemId &&
            Number(previous.inMs) + Number(previous.durationMs) === clip.inMs
          ) {
            contiguousSlices++
          }
        }
      }
      for (const time of [0, 60000, 300000, 599999]) {
        expect(
          clips.filter(
            (clip) =>
              Number(clip.offsetMs) <= time &&
              Number(clip.offsetMs) + Number(clip.durationMs) > time
          )
        ).toHaveLength(scenario.voices)
      }
      if (id === 'chopped') {
        expect(contiguousSlices).toBeGreaterThan(1000)
        expect(clips.filter((clip) => Number(clip.durationMs) <= 1000).length).toBeGreaterThan(1500)
        expect(clips.some((clip) => Number(clip.durationMs) === 125)).toBe(true)
      } else {
        expect(Math.min(...clips.map((clip) => Number(clip.durationMs)))).toBe(90000)
        expect(Math.max(...clips.map((clip) => Number(clip.durationMs)))).toBe(180000)
      }
      for (const item of sources.values()) {
        const audio = await readFile(join(directory, String(item.filePath)))
        expect(audio.readUInt16LE(22)).toBe(item.channelCount)
        expect(audio.readUInt32LE(40) / (Number(item.channelCount) * 2 * 48)).toBe(item.durationMs)
      }
      const repeated = projectDocument(scenario) as { project: ProjectNode }
      expect(repeated.project).toEqual(project)
      expect(await verifyProject(directory)).toEqual(manifest)
    }
  )
})
