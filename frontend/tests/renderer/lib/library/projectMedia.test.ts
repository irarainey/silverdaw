import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProjectMedia, withoutAudioGeometry } from '@/lib/library/projectMedia'
import type { AudioMetadata } from '@shared/types'

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

const sourceMedia: AudioMetadata = {
  title: 'Get Down Saturday Night',
  artist: 'The Originals',
  // Source-file geometry — must NOT leak onto a derived stem/sample sharing the GUID.
  durationMs: 58_000,
  geometryOrigin: 'recording',
  sampleRate: 44_100,
  channelCount: 2,
  coverArt: { data: new ArrayBuffer(8), mimeType: 'image/jpeg' }
}

function stubMedia(meta: AudioMetadata | null): void {
  globalThis.window = {
    silverdaw: { getProjectMedia: vi.fn().mockResolvedValue(meta) }
  } as unknown as Window & typeof globalThis
}

afterEach(() => {
  vi.restoreAllMocks()
})

it('does not promote output or ambiguous legacy WAV lengths, even with matching tags', () => {
  for (const geometryOrigin of ['output', undefined] as const) {
    expect(withoutAudioGeometry({ ...sourceMedia, container: 'WAVE', geometryOrigin }))
      .not.toHaveProperty('recordingDurationMs')
  }
  expect(withoutAudioGeometry({ ...sourceMedia, geometryOrigin: 'output', recordingDurationMs: 90_000 }))
    .toHaveProperty('recordingDurationMs', 90_000)
})

describe('withoutAudioGeometry', () => {
  it('drops duration / sample-rate / channel-count but keeps identity tags + cover', () => {
    const stripped = withoutAudioGeometry(sourceMedia)
    expect(stripped.durationMs).toBeUndefined()
    expect(stripped.recordingDurationMs).toBe(sourceMedia.durationMs)
    expect(stripped.sampleRate).toBeUndefined()
    expect(stripped.channelCount).toBeUndefined()
    expect(stripped.title).toBe('Get Down Saturday Night')
    expect(stripped.artist).toBe('The Originals')
    expect(stripped.coverArt).toBeDefined()
  })
})

describe('getProjectMedia', () => {
  it('strips the source geometry so a derived item keeps its own duration', async () => {
    stubMedia(sourceMedia)
    const media = await getProjectMedia('guid-1')
    expect(media).not.toBeNull()
    expect(media?.durationMs).toBeUndefined()
    expect(media?.sampleRate).toBeUndefined()
    expect(media?.channelCount).toBeUndefined()
    expect(media?.title).toBe('Get Down Saturday Night')
    expect(media?.coverArt).toBeDefined()
  })

  it('returns null and skips the IPC call when no mediaId is given', async () => {
    const getMedia = vi.fn()
    globalThis.window = { silverdaw: { getProjectMedia: getMedia } } as unknown as Window & typeof globalThis
    expect(await getProjectMedia(undefined)).toBeNull()
    expect(getMedia).not.toHaveBeenCalled()
  })

  it('returns null when the store has no entry', async () => {
    stubMedia(null)
    expect(await getProjectMedia('missing')).toBeNull()
  })
})
