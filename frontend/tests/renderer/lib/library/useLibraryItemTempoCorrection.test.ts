import { createPinia, setActivePinia } from 'pinia'
import { nextTick, shallowRef } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLibraryItemTempoCorrection } from '@/lib/library/useLibraryItemTempoCorrection'
import { useLibraryStore } from '@/stores/libraryStore'
import type { LibraryItem } from '@/stores/libraryTypes'
import { useTransportStore } from '@/stores/transportStore'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

vi.mock('@/lib/audioDecode', () => ({
  PEAKS_PER_SECOND: 200,
  decodeAudioToPeaks: vi.fn()
}))

const DETECTED_BPM = 98.8
const CORRECTED_BPM = 102.76

let uuidCounter = 0

function addSource(overrides: Partial<LibraryItem> = {}): LibraryItem {
  const library = useLibraryStore()
  const id = library.addItem({
    filePath: `C:\\audio\\song-${++uuidCounter}.wav`,
    fileName: `song-${uuidCounter}.wav`,
    durationMs: 268_094,
    sampleRate: 44_100,
    channelCount: 2,
    peaks: new Float32Array([0, 1])
  })
  const item = library.byId[id]!
  item.bpm = DETECTED_BPM
  item.beatAnchorSec = 0.25
  item.beats = [0.25]
  Object.assign(item, overrides)
  return item
}

describe('useLibraryItemTempoCorrection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
    uuidCounter = 0
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${++uuidCounter}`) })
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:cover'),
      revokeObjectURL: vi.fn()
    })
  })

  it('seeds the field from the item tempo', () => {
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)

    expect(correction.bpmInput.value).toBe('98.80')
    expect(correction.currentBpm.value).toBe(DETECTED_BPM)
    expect(correction.isCorrectable.value).toBe(true)
    // Nothing to correct until the number actually differs.
    expect(correction.canCorrect.value).toBe(false)
  })

  it('offers the correction once a different, valid tempo is typed', () => {
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)

    correction.bpmInput.value = String(CORRECTED_BPM)

    expect(correction.canCorrect.value).toBe(true)
    expect(correction.typedBpm.value).toBe(CORRECTED_BPM)
  })

  it.each([
    ['below the range', '19'],
    ['above the range', '301'],
    ['empty', '   '],
    ['not a number', 'fast']
  ])('refuses a tempo that is %s', (_label, typed) => {
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)

    correction.bpmInput.value = typed

    expect(correction.canCorrect.value).toBe(false)
    expect(correction.apply()).toBe(false)
    expect(sendMock).not.toHaveBeenCalledWith('LIBRARY_ITEM_CORRECT_TEMPO', expect.anything())
  })

  it('sends the correction against the item, and nothing about the project tempo', () => {
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)
    correction.bpmInput.value = String(CORRECTED_BPM)
    sendMock.mockClear()

    expect(correction.apply()).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_CORRECT_TEMPO', {
      itemId: item.id,
      bpm: CORRECTED_BPM,
      beatAnchorSec: 0.25
    })
  })

  // Setting the project tempo from the first clip dropped is merely a convenience, with
  // no linkage and no history (ADR 0027), so the number is the user's rather than the
  // file's. Correcting a file must leave it alone, even when the two agree exactly.
  it('leaves the project tempo alone even when it reads the number being corrected', () => {
    const transport = useTransportStore()
    transport.bpm = DETECTED_BPM
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)
    correction.bpmInput.value = String(CORRECTED_BPM)
    sendMock.mockClear()

    expect(correction.apply()).toBe(true)

    expect(sendMock.mock.calls[0]?.[1]).not.toHaveProperty('carryProjectTempo')
    expect(transport.bpm).toBe(DETECTED_BPM)
  })

  it('corrects the ancestor when the tempo is inherited, using the ancestor phase', () => {
    // A stem has no tempo of its own; correcting it on the stem would split it from the
    // track every sibling shares, and pushing the stem's phase would slide their grids.
    const library = useLibraryStore()
    const source = addSource({ beatAnchorSec: 0.5, beats: [0.5] })
    const stem = addSource({
      bpm: undefined,
      beats: undefined,
      beatAnchorSec: 3.75,
      name: 'Drums',
      kind: 'stem',
      derivedFrom: { sourceItemId: source.id, inMs: 0, durationMs: 268_094 }
    })

    const correction = useLibraryItemTempoCorrection(() => library.byId[stem.id]!)
    expect(correction.currentBpm.value).toBe(DETECTED_BPM)
    expect(correction.ownerName.value).toBe(source.fileName)

    correction.bpmInput.value = String(CORRECTED_BPM)
    sendMock.mockClear()
    expect(correction.apply()).toBe(true)

    expect(sendMock).toHaveBeenCalledWith('LIBRARY_ITEM_CORRECT_TEMPO', {
      itemId: source.id,
      bpm: CORRECTED_BPM,
      beatAnchorSec: 0.5
    })
  })

  it('offers nothing for a one-shot, which has no tempo to correct', () => {
    const item = addSource({ audioType: 'simple' })
    const correction = useLibraryItemTempoCorrection(() => item)

    expect(correction.owner.value).toBeNull()
    expect(correction.isCorrectable.value).toBe(false)
    expect(correction.canCorrect.value).toBe(false)
  })

  it('shows the corrected value straight away rather than the number that was wrong', () => {
    const library = useLibraryStore()
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)
    correction.bpmInput.value = String(CORRECTED_BPM)

    correction.apply()

    expect(library.byId[item.id]!.bpm).toBe(CORRECTED_BPM)
    expect(correction.bpmInput.value).toBe('102.76')
    expect(correction.canCorrect.value).toBe(false)
  })

  it('re-seeds when the dialog re-targets, so a number typed for one item cannot land on another', async () => {
    const first = addSource()
    const second = addSource({ bpm: 128 })
    // Mirrors the dialog, which passes a reactive `() => props.item` and re-targets in
    // place rather than remounting for each item the user asks about.
    const target = shallowRef<LibraryItem>(first)
    const correction = useLibraryItemTempoCorrection(() => target.value)

    correction.bpmInput.value = String(CORRECTED_BPM)
    target.value = second
    await nextTick()

    expect(correction.bpmInput.value).toBe('128.00')
    expect(correction.canCorrect.value).toBe(false)
  })

  it('leaves a number being typed alone when the backend echoes an unrelated change', async () => {
    const library = useLibraryStore()
    const item = addSource()
    const correction = useLibraryItemTempoCorrection(() => item)
    correction.bpmInput.value = String(CORRECTED_BPM)

    library.byId[item.id]!.bpm = 99.5
    await nextTick()

    expect(correction.bpmInput.value).toBe(String(CORRECTED_BPM))
  })
})
