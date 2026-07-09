import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useAppKeyboardShortcuts, type AppKeyboardShortcutsDeps } from '@/lib/app/useAppKeyboardShortcuts'

// The handler's editable-target guard uses `instanceof HTMLElement`, a browser
// global absent under the node test env. Stub it so plain-object targets read
// as non-editable (the desired state for these dispatch tests).
vi.stubGlobal('HTMLElement', class HTMLElement {})

const sendBridge = vi.fn()
vi.mock('@/lib/bridgeService', () => ({
  send: (...args: unknown[]) => sendBridge(...args)
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

interface FakeStores {
  transport: {
    bridgeReady: boolean
    engineRecovery: string
    isPlaying: boolean
    positionMs: number
    bpm: number
    setPlaybackState: ReturnType<typeof vi.fn>
    setPosition: ReturnType<typeof vi.fn>
  }
  project: {
    durationMs: number
    selectedClipId: string | null
    selectedClipIds: Set<string>
    setSelectedClipsLocked: ReturnType<typeof vi.fn>
    selectedTrackId: string | null
    metronomeEnabled: boolean
    clips: Record<string, { locked: boolean; startMs: number }>
    tracks: { clipIds: string[] }[]
    markers: { positionMs: number }[]
    viewPxPerSecond: number
    setClipLocked: ReturnType<typeof vi.fn>
    toggleMarkerAt: ReturnType<typeof vi.fn>
    moveClip: ReturnType<typeof vi.fn>
    selectClip: ReturnType<typeof vi.fn>
    selectTrack: ReturnType<typeof vi.fn>
    clearClipSelection: ReturnType<typeof vi.fn>
    setMetronomeEnabled: ReturnType<typeof vi.fn>
    toggleMute: ReturnType<typeof vi.fn>
    toggleSolo: ReturnType<typeof vi.fn>
  }
  ui: {
    requestTimelineZoom: ReturnType<typeof vi.fn>
    requestTimelineZoomTo: ReturnType<typeof vi.fn>
    requestTimelineScroll: ReturnType<typeof vi.fn>
    requestTimelineScrollToPosition: ReturnType<typeof vi.fn>
    selectedAutomationPoint: unknown
    setSelectedAutomationPoint: ReturnType<typeof vi.fn>
  }
  library: {
    byId: Record<string, unknown>
    items: unknown[]
  }
}

function makeDeps(overrides: { modalOpen?: boolean } = {}): {
  deps: AppKeyboardShortcutsDeps
  stores: FakeStores
  openExportMixdown: ReturnType<typeof vi.fn>
} {
  const stores: FakeStores = {
    transport: {
      bridgeReady: true,
      engineRecovery: 'ok',
      isPlaying: false,
      positionMs: 0,
      bpm: 120,
      setPlaybackState: vi.fn(),
      setPosition: vi.fn()
    },
    project: {
      durationMs: 10_000,
      selectedClipId: null,
      selectedClipIds: new Set<string>(),
      setSelectedClipsLocked: vi.fn(),
      selectedTrackId: null,
      metronomeEnabled: false,
      clips: {},
      tracks: [],
      markers: [],
      viewPxPerSecond: 100,
      setClipLocked: vi.fn(),
      toggleMarkerAt: vi.fn(),
      moveClip: vi.fn(),
      selectClip: vi.fn(),
      selectTrack: vi.fn(),
      clearClipSelection: vi.fn(),
      setMetronomeEnabled: vi.fn(),
      toggleMute: vi.fn(),
      toggleSolo: vi.fn()
    },
    ui: {
      requestTimelineZoom: vi.fn(),
      requestTimelineZoomTo: vi.fn(),
      requestTimelineScroll: vi.fn(),
      requestTimelineScrollToPosition: vi.fn(),
      selectedAutomationPoint: null,
      setSelectedAutomationPoint: vi.fn()
    },
    library: {
      byId: {},
      items: []
    }
  }
  const openExportMixdown = vi.fn()
  const deps: AppKeyboardShortcutsDeps = {
    transport: stores.transport as unknown as AppKeyboardShortcutsDeps['transport'],
    project: stores.project as unknown as AppKeyboardShortcutsDeps['project'],
    ui: stores.ui as unknown as AppKeyboardShortcutsDeps['ui'],
    library: stores.library as unknown as AppKeyboardShortcutsDeps['library'],
    isModalOpen: () => overrides.modalOpen === true,
    openExportMixdown
  }
  return { deps, stores, openExportMixdown }
}

interface KeyOpts {
  key?: string
  code?: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
  repeat?: boolean
}

function makeKey(opts: KeyOpts = {}): {
  e: KeyboardEvent
  preventDefault: ReturnType<typeof vi.fn>
} {
  const preventDefault = vi.fn()
  const e = {
    key: opts.key ?? '',
    code: opts.code ?? '',
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    altKey: opts.altKey ?? false,
    repeat: opts.repeat ?? false,
    preventDefault,
    stopPropagation: vi.fn(),
    // Plain object target is not an HTMLElement instance -> treated as
    // non-editable, which is what we want for these dispatch tests.
    target: {}
  } as unknown as KeyboardEvent
  return { e, preventDefault }
}

describe('useAppKeyboardShortcuts — onGlobalShortcutKey', () => {
  let h: ReturnType<typeof makeDeps>
  let kb: ReturnType<typeof useAppKeyboardShortcuts>

  beforeEach(() => {
    sendBridge.mockClear()
    h = makeDeps()
    kb = useAppKeyboardShortcuts(h.deps)
  })

  it('Space starts playback from a stopped transport', () => {
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_PLAY')
    expect(h.stores.transport.setPlaybackState).toHaveBeenCalledWith(true)
  })

  it('Space pauses when playing', () => {
    h.stores.transport.isPlaying = true
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_PAUSE')
    expect(h.stores.transport.setPlaybackState).toHaveBeenCalledWith(false)
  })

  it('Space at end-of-project is a no-op', () => {
    h.stores.transport.positionMs = 10_000
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('suppresses shortcuts while a modal is open', () => {
    h = makeDeps({ modalOpen: true })
    kb = useAppKeyboardShortcuts(h.deps)
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('suppresses shortcuts before the bridge is ready', () => {
    h.stores.transport.bridgeReady = false
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('suppresses shortcuts during engine recovery', () => {
    h.stores.transport.engineRecovery = 'recovering'
    const { e } = makeKey({ code: 'Space' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('Ctrl+M opens the export dialog when clips exist', () => {
    h.stores.project.tracks = [{ clipIds: ['c1'] }]
    const { e } = makeKey({ key: 'm', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.openExportMixdown).toHaveBeenCalledTimes(1)
  })

  it('Ctrl+M is a no-op with no clips', () => {
    const { e } = makeKey({ key: 'm', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.openExportMixdown).not.toHaveBeenCalled()
  })

  it('Ctrl+L toggles lock on the selected clip', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 0 } }
    const { e } = makeKey({ key: 'l', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.setClipLocked).toHaveBeenCalledWith('c1', true)
  })

  it('Ctrl+L with no selection is a no-op', () => {
    const { e } = makeKey({ key: 'l', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.setClipLocked).not.toHaveBeenCalled()
  })

  it('bare M toggles a marker at the snapped playhead', () => {
    h.stores.transport.positionMs = 500
    const { e } = makeKey({ key: 'm' })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.toggleMarkerAt).toHaveBeenCalledTimes(1)
  })

  it('Ctrl++ requests a zoom-in', () => {
    const { e } = makeKey({ key: '+', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoom).toHaveBeenCalledWith('in')
  })

  it('Ctrl+0 requests a zoom reset', () => {
    const { e } = makeKey({ code: 'Digit0', key: '0', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoom).toHaveBeenCalledWith('reset')
  })

  it('Ctrl+1 zooms to 100% (100 px/s)', () => {
    const { e } = makeKey({ code: 'Digit1', key: '1', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoomTo).toHaveBeenCalledWith(100)
  })

  it('Ctrl+8 zooms to 800% (800 px/s)', () => {
    const { e } = makeKey({ code: 'Digit8', key: '8', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoomTo).toHaveBeenCalledWith(800)
  })

  it('Ctrl+Numpad3 zooms to 300% (300 px/s)', () => {
    const { e } = makeKey({ code: 'Numpad3', key: '3', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoomTo).toHaveBeenCalledWith(300)
  })

  it('Ctrl+9 is not a zoom shortcut', () => {
    const { e } = makeKey({ code: 'Digit9', key: '9', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoomTo).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+1 does not zoom (plain Ctrl+N only)', () => {
    const { e } = makeKey({ code: 'Digit1', key: '1', ctrlKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineZoomTo).not.toHaveBeenCalled()
  })

  it('Escape clears only the track when just a track is selected', () => {
    h.stores.project.selectedTrackId = 't1'
    kb.onGlobalShortcutKey(makeKey({ key: 'Escape' }).e)
    expect(h.stores.project.selectTrack).toHaveBeenCalledWith(null)
    expect(h.stores.project.clearClipSelection).not.toHaveBeenCalled()
  })

  it('Escape steps: first clears clip(s) keeping the track, then clears the track', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.selectedClipIds = new Set(['c1'])
    h.stores.project.selectedTrackId = 't1'

    // First hit clears the clip selection but leaves the track selected.
    kb.onGlobalShortcutKey(makeKey({ key: 'Escape' }).e)
    expect(h.stores.project.clearClipSelection).toHaveBeenCalledTimes(1)
    expect(h.stores.project.selectTrack).not.toHaveBeenCalled()

    // Simulate the store clearing the clip selection, then hit Escape again.
    h.stores.project.selectedClipId = null
    h.stores.project.selectedClipIds = new Set()
    kb.onGlobalShortcutKey(makeKey({ key: 'Escape' }).e)
    expect(h.stores.project.selectTrack).toHaveBeenCalledWith(null)
  })

  it('Escape first clears an automation point, keeping the track', () => {
    h.stores.ui.selectedAutomationPoint = { pointId: 'p1' }
    h.stores.project.selectedTrackId = 't1'
    kb.onGlobalShortcutKey(makeKey({ key: 'Escape' }).e)
    expect(h.stores.ui.setSelectedAutomationPoint).toHaveBeenCalledWith(null)
    expect(h.stores.project.selectTrack).not.toHaveBeenCalled()
  })

  it('Escape is a no-op when nothing is selected', () => {
    const { e } = makeKey({ key: 'Escape' })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.clearClipSelection).not.toHaveBeenCalled()
    expect(h.stores.project.selectTrack).not.toHaveBeenCalled()
  })

  it('K toggles the project metronome', () => {
    h.stores.project.metronomeEnabled = false
    const { e } = makeKey({ key: 'k' })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.setMetronomeEnabled).toHaveBeenCalledWith(true)
  })

  it('Shift+M mutes the selected track', () => {
    h.stores.project.selectedTrackId = 't1'
    const { e } = makeKey({ key: 'm', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.toggleMute).toHaveBeenCalledWith('t1')
  })

  it('Shift+S solos the selected track', () => {
    h.stores.project.selectedTrackId = 't2'
    const { e } = makeKey({ key: 's', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.toggleSolo).toHaveBeenCalledWith('t2')
  })

  it('Shift+M with no track selected is a no-op', () => {
    const { e } = makeKey({ key: 'm', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.toggleMute).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+ArrowLeft skips to start', () => {
    const { e } = makeKey({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineScroll).toHaveBeenCalledWith('start')
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 0 })
  })

  it('Ctrl+Shift+ArrowRight skips to end', () => {
    const { e } = makeKey({ key: 'ArrowRight', ctrlKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineScroll).toHaveBeenCalledWith('end')
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 10_000 })
  })

  it('Home skips to the start of the timeline', () => {
    const { e } = makeKey({ key: 'Home' })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineScroll).toHaveBeenCalledWith('start')
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 0 })
  })

  it('End skips to the end of the timeline', () => {
    const { e } = makeKey({ key: 'End' })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineScroll).toHaveBeenCalledWith('end')
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 10_000 })
  })

  it('modified Home is ignored (left to the browser / OS)', () => {
    const { e } = makeKey({ key: 'Home', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.ui.requestTimelineScroll).not.toHaveBeenCalled()
    expect(sendBridge).not.toHaveBeenCalled()
  })

  it('Ctrl+ArrowRight seeks to the next marker', () => {
    h.stores.project.markers = [{ positionMs: 2000 }, { positionMs: 4000 }]
    h.stores.transport.positionMs = 1000
    const { e } = makeKey({ key: 'ArrowRight', ctrlKey: true })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 2000 })
  })

  it('bare ArrowRight steps forward to the next sub-beat grid line', () => {
    // 120 bpm -> 500 ms/beat -> 125 ms/sub-beat.
    h.stores.transport.positionMs = 0
    const { e } = makeKey({ key: 'ArrowRight' })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 125 })
  })

  it('Alt+ArrowRight steps forward by one pixel of time', () => {
    // 100 px/s -> 10 ms/px.
    h.stores.transport.positionMs = 0
    const { e } = makeKey({ key: 'ArrowRight', altKey: true })
    kb.onGlobalShortcutKey(e)
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 10 })
  })

  it('Shift+Alt+ArrowRight nudges the selected clip forward by 1 ms', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 500 } }
    const { e, preventDefault } = makeKey({ key: 'ArrowRight', altKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).toHaveBeenCalledWith('c1', 501)
    expect(preventDefault).toHaveBeenCalled()
    // Clip nudge owns the key — no playhead seek.
    expect(sendBridge).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })

  it('Shift+Alt+ArrowLeft nudges the selected clip back by 1 ms, clamped at 0', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 500 } }
    const { e } = makeKey({ key: 'ArrowLeft', altKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).toHaveBeenCalledWith('c1', 499)
  })

  it('Shift+Alt+Arrow does not move a locked selected clip', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: true, startMs: 500 } }
    const { e } = makeKey({ key: 'ArrowRight', altKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).not.toHaveBeenCalled()
    expect(sendBridge).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })

  it('Shift+Alt+Arrow with no clip selected does nothing (no clip move, no seek)', () => {
    const { e } = makeKey({ key: 'ArrowRight', altKey: true, shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).not.toHaveBeenCalled()
    expect(sendBridge).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })

  it('Alt+Arrow still seeks the playhead when a clip is selected', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 500 } }
    h.stores.transport.positionMs = 0
    const { e } = makeKey({ key: 'ArrowRight', altKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).not.toHaveBeenCalled()
    expect(sendBridge).toHaveBeenCalledWith('TRANSPORT_SEEK', { positionMs: 10 })
  })

  it('Shift+ArrowRight moves the selected clip to the next sub-beat grid line', () => {
    // 120 bpm -> 125 ms/sub-beat; no source beats -> snap the clip left edge.
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 500 } }
    const { e } = makeKey({ key: 'ArrowRight', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).toHaveBeenCalledWith('c1', 625)
    expect(sendBridge).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })

  it('Shift+ArrowLeft moves the selected clip to the previous sub-beat grid line', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: false, startMs: 500 } }
    const { e } = makeKey({ key: 'ArrowLeft', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).toHaveBeenCalledWith('c1', 375)
  })

  it('Shift+Arrow does not move a locked selected clip', () => {
    h.stores.project.selectedClipId = 'c1'
    h.stores.project.clips = { c1: { locked: true, startMs: 500 } }
    const { e } = makeKey({ key: 'ArrowRight', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).not.toHaveBeenCalled()
  })

  it('Shift+Arrow with no clip selected does nothing', () => {
    const { e } = makeKey({ key: 'ArrowRight', shiftKey: true })
    kb.onGlobalShortcutKey(e)
    expect(h.stores.project.moveClip).not.toHaveBeenCalled()
    expect(sendBridge).not.toHaveBeenCalledWith('TRANSPORT_SEEK', expect.anything())
  })
})
