import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useAppMenuActions, type AppMenuActionsDeps } from '@/lib/app/useAppMenuActions'

const sendBridge = vi.fn()
vi.mock('@/lib/bridgeService', () => ({
  send: (...args: unknown[]) => sendBridge(...args)
}))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))
vi.mock('@/stores/projectStore', () => ({
  // Effective duration ignores warp for these tests.
  effectiveClipDurationMs: (clip: { durationMs: number }) => clip.durationMs
}))
vi.mock('@/lib/timeline/zoomPresets', () => ({
  isZoomPresetAction: (a: string) => a.startsWith('view.zoomPreset:'),
  parseZoomPresetAction: (a: string) => Number.parseInt(a.split(':')[1] ?? '', 10) || null
}))
const openAndImportAudioFilesIntoLibrary = vi.fn()
vi.mock('@/lib/importAudio', () => ({
  openAndImportAudioFilesIntoLibrary: (...args: unknown[]) => openAndImportAudioFilesIntoLibrary(...args)
}))

const menuAction = vi.fn()
const clearRecentProjects = vi.fn()
const chooseProjectOpen = vi.fn()
const chooseProjectSaveAs = vi.fn()
const prepareProjectOpen = vi.fn()

function makeDeps(overrides: { bridgeReady?: boolean; modalOpen?: boolean } = {}): {
  deps: AppMenuActionsDeps
  stores: {
    project: Record<string, ReturnType<typeof vi.fn> | unknown>
    transport: Record<string, unknown>
    ui: Record<string, ReturnType<typeof vi.fn>>
    library: Record<string, unknown>
    notifications: Record<string, ReturnType<typeof vi.fn>>
    appStore: Record<string, unknown>
  }
  refs: {
    aboutOpen: ReturnType<typeof ref<boolean>>
    preferencesOpen: ReturnType<typeof ref<boolean>>
    projectPropertiesOpen: ReturnType<typeof ref<boolean>>
    exportMixdownOpen: ReturnType<typeof ref<boolean>>
  }
  guard: ReturnType<typeof vi.fn>
  openRecentPath: ReturnType<typeof vi.fn>
} {
  const stores = {
    project: {
      currentFilePath: null as string | null,
      projectName: 'Untitled',
      selectedClipId: null as string | null,
      selectedTrackId: null as string | null,
      durationMs: 10_000,
      clips: {} as Record<string, unknown>,
      tracks: [] as { id: string; clipIds: string[] }[],
      addTrack: vi.fn(),
      requestNewProject: vi.fn(),
      requestLoad: vi.fn(),
      requestUndo: vi.fn(),
      requestRedo: vi.fn(),
      cutSelectedClip: vi.fn(),
      copySelectedClip: vi.fn(),
      pasteClipAtPlayhead: vi.fn(),
      duplicateClip: vi.fn(),
      removeClip: vi.fn(),
      splitClipAt: vi.fn(),
      setProjectLengthMs: vi.fn(),
      saveAndWait: vi.fn(() => Promise.resolve({ ok: true }))
    },
    transport: { bridgeReady: overrides.bridgeReady ?? true, positionMs: 0 },
    ui: {
      requestTimelineZoom: vi.fn(),
      requestTimelineZoomTo: vi.fn(),
      toggleLibraryPanelCollapsed: vi.fn()
    },
    library: { byId: {} as Record<string, unknown> },
    notifications: { pushError: vi.fn(), pushInfo: vi.fn() },
    appStore: {
      recentProjects: [] as { path: string; name: string }[],
      dismissStartScreen: vi.fn(),
      refreshRecentProjects: vi.fn()
    }
  }
  const refs = {
    aboutOpen: ref(false),
    preferencesOpen: ref(false),
    projectPropertiesOpen: ref(false),
    exportMixdownOpen: ref(false)
  }
  const guard = vi.fn((proceed: () => void) => proceed())
  const openRecentPath = vi.fn()

  const deps = {
    project: stores.project,
    transport: stores.transport,
    ui: stores.ui,
    library: stores.library,
    notifications: stores.notifications,
    appStore: stores.appStore,
    aboutOpen: refs.aboutOpen,
    preferencesOpen: refs.preferencesOpen,
    projectPropertiesOpen: refs.projectPropertiesOpen,
    exportMixdownOpen: refs.exportMixdownOpen,
    guardAgainstUnsavedChanges: guard,
    isModalOpen: () => overrides.modalOpen === true,
    openRecentPath
  } as unknown as AppMenuActionsDeps

  return { deps, stores, refs, guard, openRecentPath }
}

beforeEach(() => {
  sendBridge.mockClear()
  menuAction.mockClear()
  chooseProjectOpen.mockReset()
  chooseProjectSaveAs.mockReset()
  prepareProjectOpen.mockReset()
  clearRecentProjects.mockClear()
  ;(globalThis as unknown as { window: unknown }).window = {
    silverdaw: {
      menuAction,
      clearRecentProjects,
      chooseProjectOpen,
      chooseProjectSaveAs,
      prepareProjectOpen,
      refreshRecentProjects: vi.fn()
    }
  }
})

describe('useAppMenuActions — handleMenuAction', () => {
  it('opens the About dialog even before the bridge is ready', () => {
    const h = makeDeps({ bridgeReady: false })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('help.about')
    expect(h.refs.aboutOpen.value).toBe(true)
  })

  it('opens Preferences before the bridge is ready', () => {
    const h = makeDeps({ bridgeReady: false })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.preferences')
    expect(h.refs.preferencesOpen.value).toBe(true)
  })

  it('routes file.exit through the unsaved-changes guard when the bridge is ready', () => {
    const h = makeDeps({ bridgeReady: true })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.exit')
    expect(h.guard).toHaveBeenCalledTimes(1)
    expect(menuAction).toHaveBeenCalledWith('file.exitConfirmed')
  })

  it('file.exit bypasses the unsaved-changes guard and exits when the bridge is down', () => {
    const h = makeDeps({ bridgeReady: false })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.exit')
    expect(h.guard).not.toHaveBeenCalled()
    expect(menuAction).toHaveBeenCalledWith('file.exitConfirmed')
  })

  it('app.requestClose routes through the unsaved-changes guard when the bridge is ready', () => {
    const h = makeDeps({ bridgeReady: true })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('app.requestClose')
    expect(h.guard).toHaveBeenCalledTimes(1)
    expect(menuAction).toHaveBeenCalledWith('app.confirmClose')
  })

  it('app.requestClose bypasses the guard and closes when the bridge is down', () => {
    const h = makeDeps({ bridgeReady: false })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('app.requestClose')
    expect(h.guard).not.toHaveBeenCalled()
    expect(menuAction).toHaveBeenCalledWith('app.confirmClose')
  })

  it('drops non-essential actions while the bridge is not ready', () => {
    const h = makeDeps({ bridgeReady: false })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.addTrack')
    expect(h.stores.project.addTrack).not.toHaveBeenCalled()
  })

  it('addTrack creates a track once ready', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.addTrack')
    expect(h.stores.project.addTrack).toHaveBeenCalledTimes(1)
  })

  it('importToLibrary opens the audio import flow', () => {
    openAndImportAudioFilesIntoLibrary.mockClear()
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.importToLibrary')
    expect(openAndImportAudioFilesIntoLibrary).toHaveBeenCalledTimes(1)
  })

  it('view.zoomIn is suppressed behind a modal', () => {
    const h = makeDeps({ modalOpen: true })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('view.zoomIn')
    expect(h.stores.ui.requestTimelineZoom).not.toHaveBeenCalled()
  })

  it('view.zoomIn zooms when no modal is open', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('view.zoomIn')
    expect(h.stores.ui.requestTimelineZoom).toHaveBeenCalledWith('in')
  })

  it('a zoom preset routes to requestTimelineZoomTo', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('view.zoomPreset:200')
    expect(h.stores.ui.requestTimelineZoomTo).toHaveBeenCalledWith(200)
  })

  it('view.toggleLibraryPanel toggles the library/FX panel', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('view.toggleLibraryPanel')
    expect(h.stores.ui.toggleLibraryPanelCollapsed).toHaveBeenCalledTimes(1)
  })

  it('file.exportMixdown opens the export dialog', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.exportMixdown')
    expect(h.refs.exportMixdownOpen.value).toBe(true)
  })

  it('file.save with no path recurses into Save As', () => {
    const h = makeDeps()
    chooseProjectSaveAs.mockResolvedValue(null)
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.save')
    expect(chooseProjectSaveAs).toHaveBeenCalledTimes(1)
  })

  it('file.save with a path saves in place', () => {
    const h = makeDeps()
    h.stores.project.currentFilePath = 'C:/p.silverdaw'
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.save')
    expect(h.stores.project.saveAndWait).toHaveBeenCalledWith('C:/p.silverdaw', false)
  })

  it('file.openRecentByIndex opens the mirrored MRU path', () => {
    const h = makeDeps()
    h.stores.appStore.recentProjects = [
      { path: 'C:/a.silverdaw', name: 'A' },
      { path: 'C:/b.silverdaw', name: 'B' }
    ]
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.openRecentByIndex:1')
    expect(h.openRecentPath).toHaveBeenCalledWith('C:/b.silverdaw')
  })

  it('edit.deleteClip removes the selected clip', () => {
    const h = makeDeps()
    h.stores.project.selectedClipId = 'c1'
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.deleteClip')
    expect(h.stores.project.removeClip).toHaveBeenCalledWith('c1')
  })

  it('edit.splitAtPlayhead splits the clip under the playhead', () => {
    const h = makeDeps()
    h.stores.transport.positionMs = 500
    h.stores.project.selectedTrackId = 't1'
    h.stores.project.tracks = [{ id: 't1', clipIds: ['c1'] }]
    h.stores.project.clips = { c1: { id: 'c1', startMs: 0, durationMs: 1000, libraryItemId: 'lib1' } }
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.splitAtPlayhead')
    expect(h.stores.project.splitClipAt).toHaveBeenCalledWith('c1', 500)
  })

  it('edit.splitAtPlayhead delegates a saved ("clip"-kind) clip to splitClipAt (which surfaces the toast) rather than silently skipping it', () => {
    // Regression: the handler used to pre-filter clips whose library item was a
    // saved clip, so Split silently did nothing on a track built from saved clips.
    // It must now still hand the clip to splitClipAt, which owns the rejection.
    const h = makeDeps()
    h.stores.transport.positionMs = 500
    h.stores.project.selectedTrackId = 't1'
    h.stores.project.tracks = [{ id: 't1', clipIds: ['c1'] }]
    h.stores.project.clips = { c1: { id: 'c1', startMs: 0, durationMs: 1000, libraryItemId: 'lib1' } }
    h.stores.library.byId = { lib1: { id: 'lib1', kind: 'clip' } }
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.splitAtPlayhead')
    expect(h.stores.project.splitClipAt).toHaveBeenCalledWith('c1', 500)
  })

  it('cropProjectToLastClip with no clips notifies instead of cropping', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.cropProjectToLastClip')
    expect(h.stores.notifications.pushInfo).toHaveBeenCalled()
    expect(h.stores.project.setProjectLengthMs).not.toHaveBeenCalled()
  })

  it('cropProjectToLastClip crops to the latest clip end and notifies the backend', () => {
    const h = makeDeps()
    h.stores.project.clips = { c1: { startMs: 0, durationMs: 4000, libraryItemId: 'lib1' } }
    // setProjectLengthMs mutates durationMs to simulate the store clamp.
    ;(h.stores.project.setProjectLengthMs as ReturnType<typeof vi.fn>).mockImplementation((ms: number) => {
      h.stores.project.durationMs = ms
    })
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('edit.cropProjectToLastClip')
    expect(h.stores.project.setProjectLengthMs).toHaveBeenCalledWith(4000)
    expect(sendBridge).toHaveBeenCalledWith('PROJECT_SET_LENGTH', { lengthMs: 4000 })
  })

  it('file.clearRecentProjects clears the MRU', () => {
    const h = makeDeps()
    const { handleMenuAction } = useAppMenuActions(h.deps)
    handleMenuAction('file.clearRecentProjects')
    expect(clearRecentProjects).toHaveBeenCalledTimes(1)
  })
})
