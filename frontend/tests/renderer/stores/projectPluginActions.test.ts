import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjectStore } from '@/stores/projectStore'
import { hydrateTrackPlugins } from '@/stores/projectHelpers'
import { pluginBridgeHandlers } from '@/lib/bridge/handlers/pluginHandlers'
import {
  isPluginListPayload,
  isPluginScanProgressPayload,
  isTrackPluginBypassAppliedPayload,
  ProjectStatePluginSlotSchema
} from '@shared/bridge-protocol'

const sendMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bridgeService', () => ({
  send: sendMock
}))

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

describe('plugin wire schemas', () => {
  it('treats the optional slot flags as absent-means-false', () => {
    const parsed = ProjectStatePluginSlotSchema.parse({
      slotId: 's1',
      identifier: 'C:/VST3/Reverb.vst3',
      name: 'Reverb'
    })
    expect(parsed.bypassed).toBeUndefined()
    expect(parsed.unresolved).toBeUndefined()
  })

  it('rejects a slot without an id', () => {
    expect(
      ProjectStatePluginSlotSchema.safeParse({ identifier: 'C:/VST3/Reverb.vst3', name: 'Reverb' })
        .success
    ).toBe(false)
  })

  // The chooser disables what is already on the track by identifier, so a slot that arrived
  // without one would silently let the same plugin be added twice.
  it('rejects a slot without an identifier', () => {
    expect(ProjectStatePluginSlotSchema.safeParse({ slotId: 's1', name: 'Reverb' }).success).toBe(
      false
    )
  })

  it('guards the plugin list payload', () => {
    expect(isPluginListPayload({ plugins: [] })).toBe(true)
    expect(isPluginListPayload({ plugins: [{ identifier: 'a', name: 'A' }] })).toBe(true)
    expect(isPluginListPayload({ plugins: [{ name: 'A' }] })).toBe(false)
    expect(isPluginListPayload({})).toBe(false)
  })

  it('guards the scan progress payload', () => {
    expect(isPluginScanProgressPayload({ scanned: 1, total: 4 })).toBe(true)
    expect(isPluginScanProgressPayload({ scanned: -1, total: 4 })).toBe(false)
    expect(isPluginScanProgressPayload({ scanned: 1 })).toBe(false)
  })

  it('guards the bypass ack payload', () => {
    expect(
      isTrackPluginBypassAppliedPayload({ trackId: 't1', slotId: 's1', bypassed: true, ok: true })
    ).toBe(true)
    // `ok` is what distinguishes an applied bypass from one the backend could not store.
    expect(isTrackPluginBypassAppliedPayload({ trackId: 't1', slotId: 's1', bypassed: true })).toBe(
      false
    )
    expect(
      isTrackPluginBypassAppliedPayload({ trackId: 't1', slotId: 's1', bypassed: 'yes', ok: true })
    ).toBe(false)
  })
})

describe('hydrateTrackPlugins', () => {
  it('returns undefined for an absent or empty chain', () => {
    expect(hydrateTrackPlugins(undefined)).toBeUndefined()
    expect(hydrateTrackPlugins([])).toBeUndefined()
  })

  it('defaults the optional flags to false and preserves chain order', () => {
    const slots = hydrateTrackPlugins([
      { slotId: 's1', identifier: 'id-1', name: 'First' },
      {
        slotId: 's2',
        identifier: 'id-2',
        name: 'Second',
        manufacturer: 'Acme',
        bypassed: true,
        unresolved: true
      }
    ])
    expect(slots?.map((s) => s.slotId)).toEqual(['s1', 's2'])
    expect(slots?.map((s) => s.identifier)).toEqual(['id-1', 'id-2'])
    expect(slots?.[0]).toMatchObject({ bypassed: false, unresolved: false })
    expect(slots?.[1]).toMatchObject({ manufacturer: 'Acme', bypassed: true, unresolved: true })
  })
})

describe('plugin store actions', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  it('sends the catalogue request with no payload', () => {
    useProjectStore().requestPluginList()
    expect(sendMock).toHaveBeenCalledWith('PLUGIN_LIST_REQUEST')
  })

  it('marks a scan as running as soon as it is requested', () => {
    const project = useProjectStore()
    project.scanPlugins(true)
    expect(project.pluginScanning).toBe(true)
    expect(sendMock).toHaveBeenCalledWith('PLUGIN_SCAN', { clearBlacklist: true })
  })

  it('refuses to add a plugin to a track that does not exist', () => {
    useProjectStore().addTrackPlugin('missing-track', 'id-1')
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('sends an add for a known track without changing local state', () => {
    const project = useProjectStore()
    project.tracks = [{ id: 't1', name: 'Track 1', gain: 1 }] as never
    project.addTrackPlugin('t1', 'id-1')
    expect(sendMock).toHaveBeenCalledWith('TRACK_ADD_PLUGIN', { trackId: 't1', identifier: 'id-1' })
    // The backend owns the chain: nothing is added optimistically.
    expect(project.tracks[0]?.plugins).toBeUndefined()
  })

  it('drops a reorder with a nonsensical index', () => {
    const project = useProjectStore()
    project.reorderTrackPlugin('t1', 's1', -1)
    project.reorderTrackPlugin('t1', 's1', Number.NaN)
    expect(sendMock).not.toHaveBeenCalled()
    project.reorderTrackPlugin('t1', 's1', 2.7)
    expect(sendMock).toHaveBeenCalledWith('TRACK_REORDER_PLUGIN', {
      trackId: 't1',
      slotId: 's1',
      index: 2
    })
  })

  it('ignores an empty slot id on every slot-scoped action', () => {
    const project = useProjectStore()
    project.removeTrackPlugin('t1', '')
    project.setTrackPluginBypassed('t1', '', true)
    project.openTrackPluginEditor('t1', '')
    expect(sendMock).not.toHaveBeenCalled()
  })
})

describe('plugin bridge handlers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('hides instruments from the catalogue', () => {
    pluginBridgeHandlers.PLUGIN_LIST({
      plugins: [
        { identifier: 'fx', name: 'Filter' },
        { identifier: 'synth', name: 'Synth', isInstrument: true }
      ]
    })
    expect(useProjectStore().pluginCatalogue.map((p) => p.identifier)).toEqual(['fx'])
  })

  it('clears the scanning flag when the list says the scan is over', () => {
    const project = useProjectStore()
    project.pluginScanning = true
    project.pluginScanStatus = 'Scanning 1 of 4…'
    pluginBridgeHandlers.PLUGIN_LIST({ plugins: [], scanning: false })
    expect(project.pluginScanning).toBe(false)
    expect(project.pluginScanStatus).toBeNull()
  })

  it('reports scan progress and then clears it when finished', () => {
    const project = useProjectStore()
    pluginBridgeHandlers.PLUGIN_SCAN_PROGRESS({ scanned: 2, total: 8 })
    expect(project.pluginScanning).toBe(true)
    expect(project.pluginScanStatus).toBe('Scanning 2 of 8…')

    pluginBridgeHandlers.PLUGIN_SCAN_PROGRESS({ scanned: 8, total: 8, finished: true })
    expect(project.pluginScanning).toBe(false)
    expect(project.pluginScanStatus).toBeNull()
  })

  it('falls back to a generic message when the total is unknown', () => {
    pluginBridgeHandlers.PLUGIN_SCAN_PROGRESS({ scanned: 0, total: 0 })
    expect(useProjectStore().pluginScanStatus).toBe('Scanning plugins…')
  })
})

// Bypass is acked narrowly rather than by a whole-project snapshot, because re-sending every
// track and clip to flip one boolean forced a full timeline repaint on each click — visible as
// dropped frames while playing. These tests pin both halves: the click stays non-optimistic,
// and the ack alone is what moves the mirror.
describe('plugin bypass ack', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    sendMock.mockClear()
  })

  const trackWithSlot = (bypassed: boolean): unknown => [
    {
      id: 't1',
      name: 'Track 1',
      gain: 1,
      plugins: [{ slotId: 's1', identifier: 'id-1', name: 'Reverb', bypassed, unresolved: false }]
    }
  ]

  it('sends the command without changing local state', () => {
    const project = useProjectStore()
    project.tracks = trackWithSlot(false) as never
    project.setTrackPluginBypassed('t1', 's1', true)
    expect(sendMock).toHaveBeenCalledWith('TRACK_SET_PLUGIN_BYPASS', {
      trackId: 't1',
      slotId: 's1',
      bypassed: true
    })
    expect(project.tracks[0]?.plugins?.[0]?.bypassed).toBe(false)
  })

  it('applies the backend flag when the ack confirms it', () => {
    const project = useProjectStore()
    project.tracks = trackWithSlot(false) as never
    pluginBridgeHandlers.TRACK_PLUGIN_BYPASS_APPLIED({
      trackId: 't1',
      slotId: 's1',
      bypassed: true,
      ok: true
    })
    expect(project.tracks[0]?.plugins?.[0]?.bypassed).toBe(true)
    // Mirroring must never echo a command back, or the bypass would bounce forever.
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('leaves the mirror alone when the backend could not store the flag', () => {
    const project = useProjectStore()
    project.tracks = trackWithSlot(false) as never
    pluginBridgeHandlers.TRACK_PLUGIN_BYPASS_APPLIED({
      trackId: 't1',
      slotId: 's1',
      bypassed: true,
      ok: false
    })
    expect(project.tracks[0]?.plugins?.[0]?.bypassed).toBe(false)
  })

  it('ignores an ack for a track or slot it no longer holds', () => {
    const project = useProjectStore()
    project.tracks = trackWithSlot(false) as never
    expect(() => {
      pluginBridgeHandlers.TRACK_PLUGIN_BYPASS_APPLIED({
        trackId: 'gone',
        slotId: 's1',
        bypassed: true,
        ok: true
      })
      pluginBridgeHandlers.TRACK_PLUGIN_BYPASS_APPLIED({
        trackId: 't1',
        slotId: 'gone',
        bypassed: true,
        ok: true
      })
    }).not.toThrow()
    expect(project.tracks[0]?.plugins?.[0]?.bypassed).toBe(false)
  })
})
