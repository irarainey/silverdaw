import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bridgeService', () => ({
  send: vi.fn()
}))

vi.mock('@/lib/log', () => ({
  log: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }
}))

import {
  onConnectionLost,
  onEngineUnresponsive,
  onBackendStatus,
  onProjectStateApplied,
  retryRecovery,
  resetEngineRecovery
} from '@/lib/engineRecovery'
import { useTransportStore } from '@/stores/transportStore'
import { useProjectStore } from '@/stores/projectStore'
import type { ProjectStatePayload } from '@shared/bridge-protocol'

const restartBackend = vi.fn(() => Promise.resolve())
const listRecoverableAutosaves = vi.fn(() => Promise.resolve([]))

function emptySnapshot(reset: boolean): ProjectStatePayload {
  return { reset, filePath: null } as unknown as ProjectStatePayload
}

/** Mark the engine as having been healthy at least once. */
function markReady(): void {
  useTransportStore().setBridgeReady(true)
}

describe('engineRecovery state machine', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetEngineRecovery()
    restartBackend.mockClear()
    listRecoverableAutosaves.mockClear()
    // @ts-expect-error — minimal preload surface for the recovery flow.
    globalThis.window = { silverdaw: { restartBackend, listRecoverableAutosaves } }
  })

  afterEach(() => {
    resetEngineRecovery()
    // @ts-expect-error — tear down the injected global.
    delete globalThis.window
  })

  it('ignores connection loss before the engine has ever been ready', () => {
    onConnectionLost()
    expect(useTransportStore().engineRecovery).toBe('ok')
  })

  it('begins a recovery cycle on mid-session connection loss', () => {
    markReady()
    onConnectionLost()
    const transport = useTransportStore()
    const project = useProjectStore()
    expect(transport.engineRecovery).toBe('recovering')
    expect(project.recoveryInFlight).toBe(true)
  })

  it('treats a failed supervisor status as terminal', () => {
    markReady()
    onConnectionLost()
    onBackendStatus('failed')
    expect(useTransportStore().engineRecovery).toBe('unavailable')
  })

  it('shows recovery on a restarting status even before the socket closes', () => {
    markReady()
    onBackendStatus('restarting')
    expect(useTransportStore().engineRecovery).toBe('recovering')
  })

  it('asks main to restart the backend when the engine is unresponsive', () => {
    markReady()
    onEngineUnresponsive('no pong')
    expect(restartBackend).toHaveBeenCalledWith('no pong')
    expect(useTransportStore().engineRecovery).toBe('recovering')
  })

  it('completes recovery for an untitled project with no autosave', async () => {
    markReady()
    onConnectionLost()
    // Empty reconnect snapshot kicks the restore; with no file + no autosave
    // the empty engine already matches, so recovery finishes silently.
    onProjectStateApplied(emptySnapshot(false))
    await vi.waitFor(() => {
      expect(useTransportStore().engineRecovery).toBe('ok')
    })
    expect(useProjectStore().recoveryInFlight).toBe(false)
  })

  it('re-arms (bumps generation) when the engine drops again mid-recovery', () => {
    markReady()
    onConnectionLost()
    // A second loss while already recovering must not open a parallel cycle;
    // it re-arms the existing one and stays in a recovering phase.
    onConnectionLost()
    expect(useTransportStore().engineRecovery).toBe('recovering')
  })

  it('ignores a failed status during cold start (engine never became ready)', () => {
    // No markReady() — this is a startup failure, owned by StartupScreen.
    onBackendStatus('failed')
    expect(useTransportStore().engineRecovery).toBe('ok')
  })

  it('falls into unavailable if the respawn never reconnects in time', () => {
    vi.useFakeTimers()
    try {
      markReady()
      onConnectionLost()
      expect(useTransportStore().engineRecovery).toBe('recovering')
      // No reconnect snapshot ever arrives → the reconnect deadline fires.
      vi.advanceTimersByTime(15_000)
      expect(useTransportStore().engineRecovery).toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retryRecovery requests another restart from the terminal state', () => {
    markReady()
    onConnectionLost()
    onBackendStatus('failed')
    expect(useTransportStore().engineRecovery).toBe('unavailable')
    retryRecovery()
    expect(restartBackend).toHaveBeenCalledWith('user retry')
    expect(useTransportStore().engineRecovery).toBe('recovering')
  })
})
