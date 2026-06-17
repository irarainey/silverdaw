import { describe, expect, it } from 'vitest'
import {
  isAllowedAudioPath,
  isPrunableArtifactSubdir,
  isWithinSamplesWriteRoot,
  isWithinStemsWriteRoot,
  registerIssuedPath,
  registerSamplesWriteRoot,
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

  it('treats a registered samples write root as both a sidecar root and a read root', () => {
    const samplesRoot = abs('ProjectFolder', 'Samples')
    const sampleDir = abs('ProjectFolder', 'Samples', 'Funky President')
    const sampleWav = abs('ProjectFolder', 'Samples', 'Funky President', 'Drums-sample-001.wav')
    expect(isWithinSamplesWriteRoot(sampleDir)).toBe(false)
    expect(isAllowedAudioPath(sampleWav)).toBe(false)
    registerSamplesWriteRoot(samplesRoot)
    // A music-sample sidecar may be written into the per-source subdir, and the
    // sample WAVs under the Samples root may be read.
    expect(isWithinSamplesWriteRoot(sampleDir)).toBe(true)
    expect(isAllowedAudioPath(sampleWav)).toBe(true)
  })

  it('confines the samples write root (no `..` traversal, rejects non-absolute)', () => {
    const samplesRoot = abs('ConfinedS', 'Samples')
    registerSamplesWriteRoot(samplesRoot)
    expect(isWithinSamplesWriteRoot(abs('ConfinedS', 'Samples', '..', 'escape'))).toBe(false)
    expect(isWithinSamplesWriteRoot('relative/Samples')).toBe(false)
    expect(isWithinSamplesWriteRoot(42)).toBe(false)
  })

  it('marks only strict per-source subfolders of write roots as prunable', () => {
    const stemsRoot = abs('Prune', 'stems')
    const samplesRoot = abs('Prune', 'samples')
    registerStemsWriteRoot(stemsRoot)
    registerSamplesWriteRoot(samplesRoot)
    // The roots themselves must never be prunable.
    expect(isPrunableArtifactSubdir(stemsRoot)).toBe(false)
    expect(isPrunableArtifactSubdir(samplesRoot)).toBe(false)
    // A per-source subfolder inside either root is prunable.
    expect(isPrunableArtifactSubdir(abs('Prune', 'stems', 'song-stems'))).toBe(true)
    expect(isPrunableArtifactSubdir(abs('Prune', 'samples', 'song'))).toBe(true)
    // Outside / traversal / non-absolute are rejected.
    expect(isPrunableArtifactSubdir(abs('Prune', 'elsewhere'))).toBe(false)
    expect(isPrunableArtifactSubdir(abs('Prune', 'stems', '..', 'escape'))).toBe(false)
    expect(isPrunableArtifactSubdir('relative/stems/x')).toBe(false)
    expect(isPrunableArtifactSubdir(42)).toBe(false)
  })
})
