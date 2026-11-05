export interface Scenario {
  id: string
  tracks: number
  clips: number
  voices: number
  sources: number
  clipMs: number
  profile?: 'varied-v1' | 'chopped-v1' | 'longform-v1'
}

const scenario = (
  id: string,
  tracks: number,
  clips: number,
  voices: number,
  sources = 8,
  clipMs = 2000
): Scenario => ({ id, tracks, clips, voices, sources, clipMs })

const varied = (id: string, tracks: number, clips: number): Scenario => ({
  ...scenario(id, tracks, clips, tracks, 16),
  profile: 'varied-v1'
})

export const SCENARIOS: readonly Scenario[] = [
  scenario('smoke', 8, 32, 2, 2),
  varied('large', 16, 128),
  varied('stress', 32, 512),
  varied('extreme', 64, 1024),
  { ...scenario('chopped', 24, 2048, 24, 16), profile: 'chopped-v1' },
  { ...scenario('longform', 8, 32, 8, 4), profile: 'longform-v1' },
  ...[8, 32, 64].map((tracks) => scenario(`tracks-${tracks}`, tracks, 256, 1, 2)),
  ...[64, 128, 256].map((clips) => scenario(`clips-${clips}`, 16, clips, 1, 2)),
  ...[1, 2, 8].map((voices) => scenario(`voices-${voices}`, 16, 256, voices, 2)),
  scenario('view-sparse', 16, 256, 1, 2),
  scenario('view-dense', 16, 256, 1, 2, 125),
  ...[1, 8].map((sources) => scenario(`media-${sources}`, 16, 256, 1, sources))
]

export function selectScenarios(ids: readonly string[]): Scenario[] {
  const selected = ids.length ? ids : ['large']
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate scenario IDs')
  return selected.map((id) => {
    const found = SCENARIOS.find((item) => item.id === id)
    if (!found)
      throw new Error(`Unknown scenario ${id}; available: ${SCENARIOS.map((s) => s.id).join(', ')}`)
    return found
  })
}
