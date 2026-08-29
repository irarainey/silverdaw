import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { libraryBridgeHandlers } from '@/lib/bridge/handlers/libraryHandlers'
import { useLibraryStore } from '@/stores/libraryStore'
import { useProjectStore } from '@/stores/projectStore'
import { useNotificationsStore } from '@/stores/notificationsStore'
import type { TempoCorrectionAppliedPayload } from '@shared/bridge-protocol'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))
vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))
vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

type Applied = Extract<TempoCorrectionAppliedPayload, { ok: true }>

function applied(overrides: Partial<Applied> = {}): Applied {
  return {
    ok: true,
    itemId: 'src',
    ownerItemId: 'src',
    ownerReason: 'ownBpm',
    appliedBpm: 102.76,
    previousBpm: 98.8,
    musicalLengthDiscarded: false,
    clipsUpdated: 2,
    clipsPinnedExcluded: 0,
    clipsUnwarpedExcluded: 0,
    transitionsRemoved: 0,
    clipsPastProjectLength: 0,
    ...overrides
  }
}

function addSource(): string {
  return useLibraryStore().addItem({
    filePath: 'C:\\audio\\song.wav',
    fileName: 'song.wav',
    durationMs: 268_094,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
}

describe('TEMPO_CORRECTION_APPLIED', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'uuid-1') })
    vi.stubGlobal('URL', { createObjectURL: vi.fn(), revokeObjectURL: vi.fn() })
  })

  it('reports a refused correction as an error, saying nothing was applied', () => {
    // The command validates before it writes, so a failure leaves the project whole;
    // the message must not imply a half-finished correction.
    const notifications = useNotificationsStore()
    const pushError = vi.spyOn(notifications, 'pushError').mockImplementation(() => 0)

    libraryBridgeHandlers.TEMPO_CORRECTION_APPLIED({
      ok: false,
      itemId: 'src',
      error: 'This is a one-shot and has no tempo to correct.'
    })

    expect(pushError).toHaveBeenCalledTimes(1)
    expect(pushError.mock.calls[0]?.[0]).toContain('one-shot')
  })

  it('reports a successful correction as information, not an error', () => {
    const notifications = useNotificationsStore()
    const pushInfo = vi.spyOn(notifications, 'pushInfo').mockImplementation(() => 0)
    const pushError = vi.spyOn(notifications, 'pushError').mockImplementation(() => 0)
    const id = addSource()

    libraryBridgeHandlers.TEMPO_CORRECTION_APPLIED(applied({ itemId: id, ownerItemId: id }))

    expect(pushError).not.toHaveBeenCalled()
    expect(pushInfo).toHaveBeenCalledTimes(1)
    const text = String(pushInfo.mock.calls[0]?.[0])
    expect(text).toContain('song.wav')
    expect(text).toContain('98.80')
    expect(text).toContain('102.76')
    expect(text).toContain('2 clips re-warped')
  })

  it('puts the exclusions in the same message as the summary', () => {
    // One action, one outcome to read. Splitting the caveats into their own toast would
    // make an already-nuanced result harder to follow, not easier.
    const notifications = useNotificationsStore()
    const pushInfo = vi.spyOn(notifications, 'pushInfo').mockImplementation(() => 0)
    const id = addSource()

    libraryBridgeHandlers.TEMPO_CORRECTION_APPLIED(
      applied({ itemId: id, ownerItemId: id, clipsPinnedExcluded: 1, transitionsRemoved: 1 })
    )

    expect(pushInfo).toHaveBeenCalledTimes(1)
    const text = String(pushInfo.mock.calls[0]?.[0])
    expect(text).toContain('left as they are')
    expect(text).toContain('no longer had an overlap')
  })

  it('falls back to a neutral name when the item is not in the library', () => {
    const notifications = useNotificationsStore()
    const pushInfo = vi.spyOn(notifications, 'pushInfo').mockImplementation(() => 0)

    libraryBridgeHandlers.TEMPO_CORRECTION_APPLIED(applied({ itemId: 'gone', ownerItemId: 'gone' }))

    expect(String(pushInfo.mock.calls[0]?.[0])).toContain('the track')
  })

  // A correction respells a file's beat grid and nothing else; ADR 0027's invariant is
  // that no clip start, no clip length and no project tempo moves as a result.
  it('leaves every clip where it is', () => {
    const notifications = useNotificationsStore()
    vi.spyOn(notifications, 'pushInfo').mockImplementation(() => 0)
    const project = useProjectStore()
    project.clips = { c1: { startMs: 1234 } as unknown as (typeof project.clips)[string] }
    const id = addSource()

    libraryBridgeHandlers.TEMPO_CORRECTION_APPLIED(applied({ itemId: id, ownerItemId: id }))

    expect(project.clips.c1?.startMs).toBe(1234)
  })
})
