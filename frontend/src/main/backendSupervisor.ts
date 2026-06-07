/** Supervises the JUCE backend with bounded respawns on the same port/token. */
import { spawn, type ChildProcess } from 'node:child_process'
import type { BackendStatus } from '../shared/ipc-channels'

export interface BackendSupervisorDeps {
  resolveExePath: () => string
  buildEnv: () => NodeJS.ProcessEnv
  getPort: () => number
  log: (level: string, scope: string, message: string) => void
  sendStatus: (status: BackendStatus) => void
}

// Bounded respawn backoff, in milliseconds.
const BACKOFF_BASE_MS = 500
const BACKOFF_MAX_MS = 5000
const MAX_CONSECUTIVE_FAILURES = 8
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

  get currentGeneration(): number {
    return this.generation
  }

  get isRunning(): boolean {
    return this.process != null
  }

  start(): void {
    this.spawn()
  }

  /** Force a watchdog restart with a fresh failure budget. */
  requestRestart(reason: string): void {
    if (this.shuttingDown) return
    this.deps.log('WARN ', 'backend', `restart requested: ${reason}`)
    this.consecutiveFailures = 0
    this.givenUp = false
    this.clearRestartTimer()
    if (this.process) {
      // Let the normal exit path schedule the respawn to avoid double-spawning.
      this.deps.sendStatus('restarting')
      this.process.kill()
    } else {
      this.spawn()
    }
  }

  markShuttingDown(): void {
    this.shuttingDown = true
    this.clearRestartTimer()
    this.clearStabilityTimer()
  }

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

    // A stable run resets old crash history.
    this.armStabilityTimer(generation)

    child.on('exit', (code, signal) => {
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
