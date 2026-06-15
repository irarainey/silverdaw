import { describe, expect, it } from 'vitest'
import {
  isAllowedAudioPath,
  isWithinStemsWriteRoot,
  registerIssuedPath,
  registerStemsWriteRoot,
  registerTrustedReadRoot
} from '@main/audioPaths'

// Platform-appropriate absolute roots so the test is valid on Windows and POSIX.
const ROOT = process.platform === 'win32' ? 'C:\\audio' : '/audio'
const sep = process.platform === 'win32' ? '\\' : '/'
const abs = (...parts: string[]): string => ROOT + sep + parts.join(sep)

describe('audioPaths allow-list', () => {
  it('rejects non-string and empty input', () => {
    expect(isAllowedAudioPath(undefined)).toBe(false)
    expect(isAllowedAudioPath(42)).toBe(false)
    expect(isAllowedAudioPath('')).toBe(false)
  })

  it('rejects an unissued path', () => {
    expect(isAllowedAudioPath(abs('never-issued.wav'))).toBe(false)
  })

  it('allows a path once it has been issued', () => {
    const p = abs('issued.wav')
    expect(isAllowedAudioPath(p)).toBe(false)
    registerIssuedPath(p)
    expect(isAllowedAudioPath(p)).toBe(true)
  })

  it('refuses to issue a non-audio extension', () => {
    const p = abs('not-audio.txt')
    registerIssuedPath(p)
    expect(isAllowedAudioPath(p)).toBe(false)
  })

  it('allows audio files under a trusted read root', () => {
    const root = abs('stems')
    const stem = abs('stems', 'job-123', 'song - vocals.wav')
    expect(isAllowedAudioPath(stem)).toBe(false)
    registerTrustedReadRoot(root)
    expect(isAllowedAudioPath(stem)).toBe(true)
  })

  it('still enforces the audio extension inside a trusted root', () => {
    const root = abs('trusted')
    registerTrustedReadRoot(root)
    expect(isAllowedAudioPath(abs('trusted', 'secret.txt'))).toBe(false)
    expect(isAllowedAudioPath(abs('trusted', 'clip.wav'))).toBe(true)
  })

  it('does not allow `..` traversal out of a trusted root', () => {
    const root = abs('confined')
    registerTrustedReadRoot(root)
    expect(isAllowedAudioPath(abs('confined', '..', 'escape.wav'))).toBe(false)
  })

  it('treats a registered stems write root as both a sidecar root and a read root', () => {
    const stemsRoot = abs('ProjectFolder', 'Stems')
    const stemDir = abs('ProjectFolder', 'Stems', 'song - vocals')
    const stemWav = abs('ProjectFolder', 'Stems', 'song - vocals', 'vocals.wav')
    expect(isWithinStemsWriteRoot(stemDir)).toBe(false)
    expect(isAllowedAudioPath(stemWav)).toBe(false)
    registerStemsWriteRoot(stemsRoot)
    // Sidecar metadata may be written here, and the stem WAVs may be read.
    expect(isWithinStemsWriteRoot(stemDir)).toBe(true)
    expect(isAllowedAudioPath(stemWav)).toBe(true)
  })

  it('confines the stems write root (no `..` traversal, rejects non-absolute)', () => {
    const stemsRoot = abs('Confined', 'Stems')
    registerStemsWriteRoot(stemsRoot)
    expect(isWithinStemsWriteRoot(abs('Confined', 'Stems', '..', 'escape'))).toBe(false)
    expect(isWithinStemsWriteRoot('relative/Stems')).toBe(false)
    expect(isWithinStemsWriteRoot(42)).toBe(false)
  })
})
