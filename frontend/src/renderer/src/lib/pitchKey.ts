const KEY_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const KEY_NOTE_ALIASES: Record<string, string> = {
  'B#': 'C',
  Db: 'C#',
  Eb: 'D#',
  'E#': 'F',
  Gb: 'F#',
  Ab: 'G#',
  Bb: 'A#',
  Cb: 'B'
}

export interface ParsedMusicalKey {
  pitchClass: number
  mode: 'major' | 'minor'
}

export interface KeyPreset {
  note: string
  label: string
  semitones: number
}

export function parseMusicalKey(key: string | undefined): ParsedMusicalKey | null {
  if (!key) return null
  const match = /^\s*([A-Ga-g])([#b]?)/.exec(key)
  if (!match) return null
  const note = `${match[1]!.toUpperCase()}${match[2] ?? ''}`
  const pitchName = KEY_NOTE_ALIASES[note] ?? note
  const pitchClass = KEY_NOTES.indexOf(pitchName as (typeof KEY_NOTES)[number])
  if (pitchClass < 0) return null
  const mode = /\bminor\b/i.test(key) || /^\s*[A-Ga-g][#b]?m\b/.test(key) ? 'minor' : 'major'
  return { pitchClass, mode }
}

export function shortestSemitoneDelta(from: number, to: number): number {
  const up = (to - from + 12) % 12
  return up > 6 ? up - 12 : up
}

export function keyPresetsFor(sourceKey: string | undefined): KeyPreset[] {
  const parsed = parseMusicalKey(sourceKey)
  if (!parsed) return []
  return KEY_NOTES.map((note, index) => {
    const semitones = shortestSemitoneDelta(parsed.pitchClass, index)
    return { note, semitones, label: `${note} ${parsed.mode}` }
  })
}

export function shiftedKey(sourceKey: string | undefined, semitones?: number, cents?: number): string | undefined {
  const parsed = parseMusicalKey(sourceKey)
  if (!parsed) return undefined
  const semitoneShift = Number.isFinite(semitones) ? Math.trunc(semitones ?? 0) : 0
  const shifted = (parsed.pitchClass + semitoneShift) % 12
  const index = shifted < 0 ? shifted + 12 : shifted
  const centShift = Number.isFinite(cents) ? Math.trunc(cents ?? 0) : 0
  const suffix = centShift === 0 ? '' : ` ${centShift > 0 ? '+' : ''}${centShift}c`
  return `${KEY_NOTES[index]} ${parsed.mode}${suffix}`
}
