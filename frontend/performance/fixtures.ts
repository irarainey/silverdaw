import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeToneWav } from '../e2e/helpers/audioFixtures.ts'
import type { ProjectNode } from '../e2e/helpers/projectDocument.ts'
import { manifestSchema, type Manifest } from './contracts.ts'
import type { Scenario } from './scenarios.ts'
import { populateArrangement, sourcePalette } from './arrangement.ts'

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex')

function validProfile(scenario: Scenario): boolean {
  if (scenario.profile === undefined) return true
  if (scenario.clips < scenario.tracks) return false
  switch (scenario.profile) {
    case 'varied-v1':
      return scenario.sources === 16
    case 'chopped-v1':
      return (
        scenario.sources === 16 &&
        scenario.clips >= scenario.tracks * 30 &&
        scenario.clips <= scenario.tracks * 90
      )
    case 'longform-v1':
      return scenario.sources === 4 && scenario.clips === scenario.tracks * 4
    default:
      return false
  }
}

export function projectDocument(scenario: Scenario): object {
  const tracks: ProjectNode[] = Array.from({ length: scenario.tracks }, (_, i) => ({
    $type: 'TRACK',
    id: `t${i + 1}`,
    name: `Benchmark ${i + 1}`,
    gain: 1,
    colorIndex: i % 8,
    $children: []
  }))
  const sources = sourcePalette(scenario)
  populateArrangement(tracks, sources, scenario)
  const library: ProjectNode = {
    $type: 'LIBRARY',
    $children: sources.map((source, i) => ({
      $type: 'ITEM',
      id: `l${i + 1}`,
      mediaId: scenario.profile
        ? `perf-${sha256(JSON.stringify(source.tone))}`
        : `perf-v1-${scenario.id}-${i + 1}`,
      kind: 'source',
      name: source.fileName,
      filePath: source.fileName,
      playbackFilePath: source.fileName,
      durationMs: source.durationMs,
      sampleRate: 48000,
      channelCount: source.tone.channels ?? 2,
      bpm: 120,
      beats: Array.from({ length: Math.ceil(source.durationMs / 500) }, (_, beat) => beat * 0.5),
      beatAnchorSec: 0
    }))
  }
  return {
    schemaVersion: 1,
    appVersion: '1.10.0',
    savedAt: '2026-11-04T00:00:00Z',
    project: {
      $type: 'PROJECT',
      name: scenario.id,
      bpm: 120,
      bpmSeeded: true,
      masterVolume: scenario.profile ? 0.1 / scenario.voices : 0.1,
      ...(scenario.profile
        ? {
            projectLengthMs: Math.max(
              300000,
              ...tracks.flatMap((track) =>
                track.$children!.map((clip) => Number(clip.offsetMs) + Number(clip.durationMs))
              )
            )
          }
        : {}),
      viewScrollX: 0,
      viewPxPerSecond:
        scenario.profile === 'chopped-v1' ? 40 : scenario.profile === 'longform-v1' ? 10 : 100,
      playheadMs: 0,
      $children: [library, { $type: 'MARKERS' }, ...tracks]
    }
  }
}

export async function generateProject(directory: string, scenario: Scenario): Promise<Manifest> {
  if (
    !Number.isInteger(scenario.tracks) ||
    scenario.tracks < 1 ||
    !Number.isInteger(scenario.clips) ||
    scenario.clips < scenario.voices ||
    !Number.isInteger(scenario.voices) ||
    scenario.voices < 1 ||
    scenario.voices > scenario.tracks ||
    !Number.isInteger(scenario.sources) ||
    scenario.sources < 1 ||
    scenario.sources > scenario.clips ||
    !Number.isInteger(scenario.clipMs) ||
    scenario.clipMs < 1 ||
    scenario.clipMs > 2000 ||
    !/^[a-z0-9-]+$/.test(scenario.id) ||
    !validProfile(scenario)
  ) {
    throw new Error('Invalid benchmark scenario')
  }
  // Refuse existing directories, including previous benchmark outputs.
  await mkdir(directory)
  const projectFile = `${scenario.id}.silverdaw`
  await writeFile(
    join(directory, projectFile),
    JSON.stringify(projectDocument(scenario), null, 2) + '\n'
  )
  const sources = sourcePalette(scenario)
  for (const source of sources) {
    writeToneWav(join(directory, source.fileName), source.tone)
  }
  const files = await Promise.all(
    [projectFile, ...sources.map((source) => source.fileName)].sort().map(async (path) => {
      const data = await readFile(join(directory, path))
      return { path, bytes: data.length, sha256: sha256(data) }
    })
  )
  const manifest: Manifest = {
    version: 1,
    scenario,
    projectFile,
    files,
    fingerprint: sha256(JSON.stringify({ version: 1, scenario, projectFile, files }))
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export async function verifyProject(directory: string): Promise<Manifest> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  )
  if (!manifest.files.some((file) => file.path === manifest.projectFile)) {
    throw new Error('Project file is not covered by the fixture manifest')
  }
  for (const file of manifest.files) {
    const data = await readFile(join(directory, file.path))
    if (data.length !== file.bytes || sha256(data) !== file.sha256) {
      throw new Error(`Fixture changed: ${file.path}; generate a fresh corpus`)
    }
  }
  const { version, scenario, projectFile, files } = manifest
  if (manifest.fingerprint !== sha256(JSON.stringify({ version, scenario, projectFile, files }))) {
    throw new Error('Fixture manifest fingerprint mismatch')
  }
  return manifest
}
