import { afterEach, describe, expect, it, vi } from 'vitest'
import { htdemucsRequired } from '@/lib/stems/stemSeparationFlow'

interface Stub {
  useBackupModel?: boolean
  vocalPath?: string
  rhythmPath?: string
  throws?: boolean
}

function stubSilverdaw({ useBackupModel = false, vocalPath = '', rhythmPath = '', throws = false }: Stub): void {
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: {
      getStemPrefs: vi.fn(async () => {
        if (throws) throw new Error('boom')
        return { useBackupModel }
      }),
      getVocalPackPath: vi.fn(async () => vocalPath),
      getRhythmPackPath: vi.fn(async () => rhythmPath)
    }
  }
}

describe('htdemucsRequired', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('is true when the user forces the backup model, regardless of packs', async () => {
    stubSilverdaw({ useBackupModel: true, vocalPath: 'v.onnx', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['vocals', 'drums', 'bass', 'other'])).toBe(true)
  })

  it('is false when both packs cover an all-four selection', async () => {
    stubSilverdaw({ vocalPath: 'v.onnx', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['vocals', 'drums', 'bass', 'other'])).toBe(false)
  })

  it('is true when vocals are selected but the vocal pack is missing', async () => {
    stubSilverdaw({ vocalPath: '', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['vocals', 'drums', 'bass', 'other'])).toBe(true)
  })

  it('is true when drums/bass are selected but the rhythm pack is missing', async () => {
    stubSilverdaw({ vocalPath: 'v.onnx', rhythmPath: '' })
    expect(await htdemucsRequired(['drums', 'bass'])).toBe(true)
  })

  it('is false for a pack-covered partial selection (vocals only)', async () => {
    stubSilverdaw({ vocalPath: 'v.onnx', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['vocals'])).toBe(false)
  })

  it('is true when "other" is selected without all of vocals/drums/bass (residual unavailable)', async () => {
    stubSilverdaw({ vocalPath: 'v.onnx', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['other'])).toBe(true)
    expect(await htdemucsRequired(['drums', 'bass', 'other'])).toBe(true)
  })

  it('is false when "other" rides the residual of a full pack-covered selection', async () => {
    stubSilverdaw({ vocalPath: 'v.onnx', rhythmPath: 'r.onnx' })
    expect(await htdemucsRequired(['vocals', 'drums', 'bass', 'other'])).toBe(false)
  })

  it('defaults to requiring the backup on a lookup failure', async () => {
    stubSilverdaw({ throws: true })
    expect(await htdemucsRequired(['vocals'])).toBe(true)
  })
})
