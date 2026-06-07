import { extname, isAbsolute, resolve as pathResolve } from 'node:path'

// Keep accepted audio extensions aligned with backend decoder support.
export const AUDIO_FILE_EXTENSIONS = ['wav', 'mp3', 'flac', 'aiff', 'aif', 'm4a'] as const
const AUDIO_FILE_EXTENSIONS_SET: ReadonlySet<string> = new Set<string>(AUDIO_FILE_EXTENSIONS)

// Renderer may only read audio paths main previously surfaced through trusted UI.
const issuedAudioPaths: Set<string> = new Set<string>()

export function canonicalisePath(p: string): string {
  return pathResolve(p)
}

// Only canonical absolute audio paths can enter the renderer read allow-list.
export function registerIssuedPath(filePath: string): void {
  if (typeof filePath !== 'string' || filePath === '') return
  if (!isAbsolute(filePath)) {
    console.warn('[main] refusing to register non-absolute path:', filePath)
    return
  }
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) {
    console.warn('[main] refusing to register non-audio path:', filePath)
    return
  }
  issuedAudioPaths.add(canonicalisePath(filePath))
}

// Re-check the audio extension at read time as defence in depth.
export function isAllowedAudioPath(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || filePath === '') return false
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!AUDIO_FILE_EXTENSIONS_SET.has(ext)) return false
  return issuedAudioPaths.has(canonicalisePath(filePath))
}
