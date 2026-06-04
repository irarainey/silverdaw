import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the child-process spawn so no real backend is launched. Each call
// returns a fresh fake process we can drive ('exit') and assert on (kill).
const spawnMock = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

import { BackendSupervisor, type BackendSupervisorDeps } from './backendSupervisor'
import type { BackendStatus } from '../shared/ipc-channels'

/** Minimal stand-in for a spawned ChildProcess. */
class FakeProcess extends EventEmitter {
  kill = vi.fn(() => {
    // Mirror real behaviour: killing eventually emits 'exit'.
    this.emit('exit', null, 'SIGTERM')
    return true
  })
}

function makeDeps(overrides: Partial<BackendSupervisorDeps> = {}): {
  deps: BackendSupervisorDeps
  statuses: BackendStatus[]
} {
  const statuses: BackendStatus[] = []
  const deps: BackendSupervisorDeps = {
    resolveExePath: () => 'C:/fake/SilverdawBackend.exe',
    buildEnv: () => ({}),
    getPort: () => 9999,
    log: () => {},
    sendStatus: (s) => statuses.push(s),
    ...overrides
  }
  return { deps, statuses }
}

describe('BackendSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => new FakeProcess())
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('spawns once on start and tags the generation', () => {
    const { deps } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'C:/fake/SilverdawBackend.exe',
      ['--port', '9999'],
      expect.objectContaining({ windowsHide: true })
    )
    expect(sup.currentGeneration).toBe(1)
    expect(sup.isRunning).toBe(true)
  })

  it('respawns on unexpected exit after a backoff delay', () => {
    const { deps, statuses } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()
    const first = spawnMock.mock.results[0].value as FakeProcess

    // Engine dies unexpectedly.
    first.emit('exit', 1, null)
    expect(sup.isRunning).toBe(false)
    expect(statuses).toContain('restarting')
    // Nothing spawned yet — it's waiting out the backoff.
    expect(spawnMock).toHaveBeenCalledTimes(1)

    // First backoff is 500ms.
    vi.advanceTimersByTime(500)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    expect(sup.currentGeneration).toBe(2)
    expect(sup.isRunning).toBe(true)
  })

  it('gives up into a terminal failed state after the failure cap', () => {
    const { deps, statuses } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()

    // Drive 9 consecutive immediate crashes (cap is 8). Each respawn lands
    // via its backoff timer, then immediately exits again.
    for (let i = 0; i < 9; i++) {
      const proc = spawnMock.mock.results.at(-1)!.value as FakeProcess
      proc.emit('exit', 1, null)
      // Advance past the max backoff so the next spawn (if any) fires.
      vi.advanceTimersByTime(5000)
    }

    expect(statuses).toContain('failed')
    expect(sup.isRunning).toBe(false)
    const spawnsAtFailure = spawnMock.mock.calls.length
    // No further spawns once given up.
    vi.advanceTimersByTime(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(spawnsAtFailure)
  })

  it('resets the failure budget once the engine stays up past the stability window', () => {
    const { deps, statuses } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()

    // One crash + respawn.
    ;(spawnMock.mock.results[0].value as FakeProcess).emit('exit', 1, null)
    vi.advanceTimersByTime(500)
    expect(sup.currentGeneration).toBe(2)

    // The respawn stays alive past the 10s stability window → 'recovered'.
    vi.advanceTimersByTime(10_000)
    expect(statuses).toContain('recovered')
  })

  it('does not respawn after an intentional shutdown', () => {
    const { deps } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()
    const proc = spawnMock.mock.results[0].value as FakeProcess

    sup.kill()
    expect(proc.kill).toHaveBeenCalled()

    // Any late exit must not trigger a respawn.
    proc.emit('exit', 0, null)
    vi.advanceTimersByTime(60_000)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('requestRestart kills the running engine and respawns it', () => {
    const { deps, statuses } = makeDeps()
    const sup = new BackendSupervisor(deps)
    sup.start()
    const proc = spawnMock.mock.results[0].value as FakeProcess

    sup.requestRestart('watchdog: no pong')
    expect(proc.kill).toHaveBeenCalled()
    expect(statuses).toContain('restarting')

    // The kill's 'exit' schedules a respawn through the normal backoff.
    vi.advanceTimersByTime(500)
    expect(spawnMock).toHaveBeenCalledTimes(2)
  })
})
