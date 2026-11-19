export function exportSampleRate(projectRate: number | null, defaultRate: number): 44100 | 48000 {
  if (projectRate === 44100 || projectRate === 48000) return projectRate
  return defaultRate === 48000 ? 48000 : 44100
}
