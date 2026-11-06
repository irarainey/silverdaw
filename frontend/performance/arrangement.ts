import type { ToneOptions } from '../e2e/helpers/audioFixtures.ts'
import type { ProjectNode } from '../e2e/helpers/projectDocument.ts'
import type { AutomationParamId } from '../src/shared/bridge-protocol.ts'
import type { Scenario } from './scenarios.ts'

interface Source {
  fileName: string
  durationMs: number
  tone: ToneOptions
}

function sourceDuration(scenario: Scenario, index: number): number {
  switch (scenario.profile) {
    case 'longform-v1':
      return 180000
    case 'chopped-v1':
      return index % 4 === 3 ? 64000 : 8000
    case 'varied-v1':
      return [250, 500, 1000, 2000, 4000, 8000][index % 6]
    default:
      return 2000
  }
}

/** Audio and library metadata share the same deterministic source palette. */
export function sourcePalette(scenario: Scenario): Source[] {
  return Array.from({ length: scenario.sources }, (_, i) => {
    const varied = scenario.profile !== undefined
    const durationMs = sourceDuration(scenario, i)
    return {
      fileName: `tone-${i + 1}.wav`,
      durationMs,
      tone: {
        seconds: durationMs / 1000,
        sampleRate: 48000,
        channels: scenario.profile === 'longform-v1' ? 1 : 2,
        frequencyHz: varied ? 55 * 2 ** (i / 3) : 220 + i * 11,
        amplitude: varied ? 0.25 : 0.1 / scenario.voices,
        ...(varied
          ? {
              harmonicGain: [0, 0.15, 0.3, 0.4][i % 4],
              modulationHz: [0, 2, 4, 8][i % 4],
              fadeMs: 10
            }
          : {})
      }
    }
  })
}

/** Interleave tracks without exceeding the declared simultaneous-clip limit. */
export function populateArrangement(
  tracks: ProjectNode[],
  sources: readonly Source[],
  scenario: Scenario
): void {
  if (scenario.profile === 'chopped-v1') {
    populateChopped(tracks, sources, scenario.clips)
    tracks.forEach(applyProcessing)
    return
  }
  if (scenario.profile === 'longform-v1') {
    populateLongform(tracks, sources, scenario.clips)
    tracks.forEach(applyProcessing)
    return
  }
  const voiceEnds = Array<number>(scenario.voices).fill(0)
  for (let i = 0; i < scenario.clips; i++) {
    const trackIndex = i % scenario.tracks
    const ordinal = Math.floor(i / scenario.tracks)
    const varied = scenario.profile === 'varied-v1'
    // Coprime strides visit all 16 sources instead of repeating one per track.
    const sourceIndex = varied
      ? (ordinal * 5 + trackIndex * 3) % sources.length
      : i % sources.length
    const source = sources[sourceIndex]
    const voice = trackIndex % scenario.voices
    const durationMs = varied ? source.durationMs * [1, 0.75, 0.5, 1][ordinal % 4] : scenario.clipMs
    const offsetMs = varied ? voiceEnds[voice] : Math.floor(i / scenario.voices) * durationMs
    tracks[trackIndex].$children!.push(
      createClip(
        i + 1,
        sourceIndex,
        offsetMs,
        varied && ordinal % 3 === 1 ? source.durationMs - durationMs : 0,
        durationMs
      )
    )
    voiceEnds[voice] = offsetMs + durationMs + (ordinal % 3 === 0 ? 250 : 0)
  }
  if (scenario.profile === 'varied-v1') tracks.forEach(applyProcessing)
}

function createClip(
  id: number,
  sourceIndex: number,
  offsetMs: number,
  inMs: number,
  durationMs: number
): ProjectNode {
  return {
    $type: 'CLIP',
    id: `c${id}`,
    libraryItemId: `l${sourceIndex + 1}`,
    offsetMs,
    inMs,
    durationMs
  }
}

function clipsOnTrack(total: number, tracks: number, index: number): number {
  return Math.floor(total / tracks) + (index < total % tracks ? 1 : 0)
}

function populateChopped(tracks: ProjectNode[], sources: readonly Source[], total: number): void {
  const sectionMs = 60000
  const sections = 10
  const shortSources = sources.flatMap((source, i) => (source.durationMs === 8000 ? [i] : []))
  const beds = sources.flatMap((source, i) => (source.durationMs === 64000 ? [i] : []))
  const subdivisions = [125, 250, 500, 1000, 250, 500, 125]
  let id = 1
  tracks.forEach((track, trackIndex) => {
    const count = clipsOnTrack(total, tracks.length, trackIndex)
    for (let section = 0; section < sections; section++) {
      const start = section * sectionMs
      const cutStart = (2 + ((trackIndex * 7 + section * 5) % 48)) * 1000
      const cuts = clipsOnTrack(count, sections, section) - 2
      const sourceIndex = shortSources[(trackIndex + section * 5) % shortSources.length]
      const bedIndex = beds[(trackIndex + section) % beds.length]
      track.$children!.push(createClip(id++, bedIndex, start, 0, cutStart))
      let offsetMs = start + cutStart
      let inMs = ((trackIndex + section) % 2) * 1000
      for (let cut = 0; cut < cuts; cut++) {
        const durationMs = subdivisions[(cut + trackIndex + section) % subdivisions.length]
        track.$children!.push(createClip(id++, sourceIndex, offsetMs, inMs, durationMs))
        offsetMs += durationMs
        inMs += durationMs
      }
      const nextBed = beds[(trackIndex + section + 1) % beds.length]
      track.$children!.push(createClip(id++, nextBed, offsetMs, 2000, start + sectionMs - offsetMs))
    }
  })
}

function populateLongform(tracks: ProjectNode[], sources: readonly Source[], total: number): void {
  const lengths = [90000, 150000, 180000, 180000]
  let id = 1
  tracks.forEach((track, index) => {
    let offsetMs = 0
    const count = clipsOnTrack(total, tracks.length, index)
    for (let clip = 0; clip < count; clip++) {
      const sourceIndex = (index + clip) % sources.length
      const durationMs = lengths[(clip + index) % lengths.length]
      const inMs = Math.min(30000, sources[sourceIndex].durationMs - durationMs)
      track.$children!.push(createClip(id++, sourceIndex, offsetMs, inMs, durationMs))
      offsetMs += durationMs
    }
  })
}

function applyProcessing(track: ProjectNode, index: number): void {
  const flavour = index % 4
  if (flavour === 0) return
  track.gain = 10 ** ([0, -3, -6, -1.5][flavour] / 20)
  track.pan = [0, -0.5, 0.4, -0.15][flavour]
  track.toneBassDb = [0, 3, -4, 1.5][flavour]
  track.toneTrebleDb = [0, -2, 2, 3][flavour]

  let paramId: AutomationParamId
  let values: number[]
  if (index % 8 === 1) {
    paramId = 'level'
    values = [-6, -3, -9, -6]
  } else if (index % 8 === 2) {
    paramId = 'pan'
    values = [-0.4, 0.4, 0, -0.4]
  } else if (index % 16 === 3) {
    paramId = 'toneBass'
    values = [-3, 3, 0, -3]
  } else {
    return
  }
  const clips = track.$children!
  const start = Number(clips[0].offsetMs)
  const end = Math.max(...clips.map((clip) => Number(clip.offsetMs) + Number(clip.durationMs)))
  track.automation = [
    {
      paramId,
      points: values.map((value, i) => ({
        timeMs: start + Math.floor(((end - start) * i) / (values.length - 1)),
        value
      }))
    }
  ]
  track.automationLaneView = [{ paramId, heightPx: 100 }]
}
