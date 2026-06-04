/**
 * Backend process supervisor.
 *
 * The JUCE audio engine runs as a separate child process. Historically it
 * was spawned exactly once and a crash (or an OS sleep/resume fault that
 * invalidates the WASAPI device) was permanent: the exit handler only
 * nulled the handle, the renderer's bridge reconnect loop retried a dead
 * port forever, and the only user-visible signal was a tiny status-bar
 * dot. This module replaces that with a real supervisor that:
 *
 * - Respawns the backend on unexpected exit, reusing the SAME port + AUTH
 *   token so the renderer's cached bridge connection reconnects
 *   transparently (no port/token churn).
 * - Bounds respawn attempts with backoff, and gives up into a terminal
 *   `failed` state instead of fork-bombing.
 * - Resets its failure budget once a backend has stayed up long enough to
 *   be considered stable, so unrelated crashes spread over a long session
 *   don't accumulate toward the cap.
 * - Tags every spawn with a monotonic generation so callers can ignore
 *   stale lifecycle events.
 * - Pushes coarse process-level status (`restarting` / `recovered` /
 *   `failed`) to the renderer, which drives the user-facing recovery UX.
 *
 * Dependencies are injected so this stays decoupled from the main-process
 * god module and is unit-testable in isolation.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { BackendStatus } from '../shared/ipc-channels'

export interface BackendSupervisorDeps {
  /** Absolute path to the backend executable. Re-resolved per spawn. */
  resolveExePath: () => string
  /** Spawn environment (token, device prefs, log dir). Rebuilt per spawn. */
  buildEnv: () => NodeJS.ProcessEnv
  /** The fixed loopback port the backend must bind. Stable for the session. */
  getPort: () => number
  /** Structured logger (mirrors `logMain` in the main module). */
  log: (level: string, scope: string, message: string) => void
  /** Push process-level status to the renderer. Must tolerate no window. */
  sendStatus: (status: BackendStatus) => void
}

/** Quick burst of retries (ms), then a steady slow cadence past the burst. */
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 5000
/** Hard cap on consecutive respawns before declaring terminal failure. */
const MAX_CONSECUTIVE_FAILURES = 8
/** A backend that stays up this long resets the failure budget. */
const STABILITY_WINDOW_MS = 10_000

export class BackendSupervisor {
  private readonly deps: BackendSupervisorDeps
  private process: ChildProcess | null = null
  private generation = 0
  private consecutiveFailures = 0
  private shuttingDown = false
  private givenUp = false
  private restartTimer: NodeJS.Timeout | null = null
  private stabilityTimer: NodeJS.Timeout | null = null

  constructor(deps: BackendSupervisorDeps) {
    this.deps = deps
  }

  /** Generation of the most recent spawn (monotonic, starts at 1). */
  get currentGeneration(): number {
    return this.generation
  }

  /** Whether a backend process is currently believed to be running. */
  get isRunning(): boolean {
    return this.process != null
  }

  /** Spawn the first backend. Subsequent respawns are automatic. */
  start(): void {
    this.spawn()
  }

  /**
   * Force a restart — used when the renderer's liveness watchdog declares
   * the engine hung (the socket is open but the message thread is wedged).
   * Resets the failure budget and `givenUp` so a user-driven recovery
   * always gets a fresh set of attempts, honouring "always able to
   * recover and continue".
   */
  requestRestart(reason: string): void {
    if (this.shuttingDown) return
    this.deps.log('WARN ', 'backend', `restart requested: ${reason}`)
    this.consecutiveFailures = 0
    this.givenUp = false
    this.clearRestartTimer()
    if (this.process) {
      // Killing fires 'exit', which schedules the respawn through the
      // normal path — no separate spawn here, so we can't double-spawn.
      this.deps.sendStatus('restarting')
      this.process.kill()
    } else {
      // Already dead (mid-backoff or never started): spawn immediately.
      this.spawn()
    }
  }

  /** Mark an intentional app shutdown so the next exit isn't respawned. */
  markShuttingDown(): void {
    this.shuttingDown = true
    this.clearRestartTimer()
    this.clearStabilityTimer()
  }

  /** Terminate the backend (used by the app quit paths). */
  kill(): void {
    this.markShuttingDown()
    if (this.process) {
      this.process.kill()
      this.process = null
    }
  }

  private spawn(): void {
    if (this.shuttingDown) return
    this.clearRestartTimer()

    const exePath = this.deps.resolveExePath()
    const port = this.deps.getPort()
    this.generation += 1
    const generation = this.generation
    this.deps.log('INFO ', 'backend', `spawning (generation ${generation}) on port ${port}`)

    let child: ChildProcess
    try {
      child = spawn(exePath, ['--port', String(port)], {
        stdio: 'inherit',
        windowsHide: true,
        env: this.deps.buildEnv()
      })
    } catch (err) {
      this.deps.log(
        'ERROR',
        'backend',
        `spawn threw (generation ${generation}): ${err instanceof Error ? err.message : String(err)}`
      )
      this.scheduleRespawn()
      return
    }

    this.process = child

    // A backend that survives the stability window is considered healthy;
    // reset the failure budget so later, unrelated crashes get a full set
    // of retries rather than inheriting an old count.
    this.armStabilityTimer(generation)

    child.on('exit', (code, signal) => {
      // Ignore exits from a process we've already superseded.
      if (generation !== this.generation) return
      this.process = null
      this.clearStabilityTimer()
      this.deps.log(
        'INFO ',
        'backend',
        `exited (generation ${generation}) code=${String(code)} signal=${String(signal)}`
      )
      if (this.shuttingDown) return
      this.scheduleRespawn()
    })

    child.on('error', (err) => {
      if (generation !== this.generation) return
      this.deps.log('ERROR', 'backend', `process error (generation ${generation}): ${err.message}`)
      // 'exit' usually follows 'error'; if the process never came up,
      // null the handle so 'exit' (if it fires) and scheduleRespawn agree.
    })
  }

  private scheduleRespawn(): void {
    if (this.shuttingDown || this.givenUp) return
    this.consecutiveFailures += 1

    if (this.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
      this.givenUp = true
      this.deps.log(
        'ERROR',
        'backend',
        `giving up after ${MAX_CONSECUTIVE_FAILURES} consecutive failed respawns`
      )
      this.deps.sendStatus('failed')
      return
    }

    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1), BACKOFF_MAX_MS)
    this.deps.log(
      'WARN ',
      'backend',
      `respawning in ${delay}ms (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`
    )
    this.deps.sendStatus('restarting')
    this.clearRestartTimer()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.spawn()
    }, delay)
  }

  private armStabilityTimer(generation: number): void {
    this.clearStabilityTimer()
    this.stabilityTimer = setTimeout(() => {
      this.stabilityTimer = null
      if (generation !== this.generation || this.process == null) return
      // Only announce recovery for an actual respawn, not the first launch.
      const wasRecovering = this.consecutiveFailures > 0
      this.consecutiveFailures = 0
      if (wasRecovering) {
        this.deps.log('INFO ', 'backend', `stable again (generation ${generation})`)
        this.deps.sendStatus('recovered')
      }
    }, STABILITY_WINDOW_MS)
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  private clearStabilityTimer(): void {
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer)
      this.stabilityTimer = null
    }
  }
}
