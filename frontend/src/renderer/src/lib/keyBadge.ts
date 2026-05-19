const KEY_BADGE_BASE_CLASS =
  'whitespace-nowrap rounded border px-1 py-0.5 text-[9px] tracking-wide shadow-sm'
const KEY_BADGE_FALLBACK_CLASS = 'border-zinc-700 bg-zinc-800 text-zinc-300'

const KEY_BADGE_CLASSES: Record<string, { major: string; minor: string }> = {
  C: {
    major: 'border-red-500/60 bg-red-700/40 text-red-100',
    minor: 'border-red-800/70 bg-red-950/70 text-red-300'
  },
  'C#': {
    major: 'border-orange-500/60 bg-orange-700/40 text-orange-100',
    minor: 'border-orange-800/70 bg-orange-950/70 text-orange-300'
  },
  D: {
    major: 'border-amber-500/60 bg-amber-700/40 text-amber-100',
    minor: 'border-amber-800/70 bg-amber-950/70 text-amber-300'
  },
  'D#': {
    major: 'border-yellow-500/60 bg-yellow-700/40 text-yellow-100',
    minor: 'border-yellow-800/70 bg-yellow-950/70 text-yellow-300'
  },
  E: {
    major: 'border-lime-500/60 bg-lime-700/40 text-lime-100',
    minor: 'border-lime-800/70 bg-lime-950/70 text-lime-300'
  },
  F: {
    major: 'border-green-500/60 bg-green-700/40 text-green-100',
    minor: 'border-green-800/70 bg-green-950/70 text-green-300'
  },
  'F#': {
    major: 'border-emerald-500/60 bg-emerald-700/40 text-emerald-100',
    minor: 'border-emerald-800/70 bg-emerald-950/70 text-emerald-300'
  },
  G: {
    major: 'border-teal-500/60 bg-teal-700/40 text-teal-100',
    minor: 'border-teal-800/70 bg-teal-950/70 text-teal-300'
  },
  'G#': {
    major: 'border-cyan-500/60 bg-cyan-700/40 text-cyan-100',
    minor: 'border-cyan-800/70 bg-cyan-950/70 text-cyan-300'
  },
  A: {
    major: 'border-sky-500/60 bg-sky-700/40 text-sky-100',
    minor: 'border-sky-800/70 bg-sky-950/70 text-sky-300'
  },
  'A#': {
    major: 'border-blue-500/60 bg-blue-700/40 text-blue-100',
    minor: 'border-blue-800/70 bg-blue-950/70 text-blue-300'
  },
  B: {
    major: 'border-violet-500/60 bg-violet-700/40 text-violet-100',
    minor: 'border-violet-800/70 bg-violet-950/70 text-violet-300'
  }
}

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

export function keyBadgeClass(key: string): string {
  const match = /^\s*([A-Ga-g])([#b]?)/.exec(key)
  if (!match) return `${KEY_BADGE_BASE_CLASS} ${KEY_BADGE_FALLBACK_CLASS}`

  const note = `${match[1]!.toUpperCase()}${match[2] ?? ''}`
  const pitchClass = KEY_NOTE_ALIASES[note] ?? note
  const colours = KEY_BADGE_CLASSES[pitchClass]
  if (!colours) return `${KEY_BADGE_BASE_CLASS} ${KEY_BADGE_FALLBACK_CLASS}`

  const isMinor = /\bminor\b/i.test(key) || /^\s*[A-Ga-g][#b]?m\b/.test(key)
  return `${KEY_BADGE_BASE_CLASS} ${isMinor ? colours.minor : colours.major}`
}
