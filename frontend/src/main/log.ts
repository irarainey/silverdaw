// Cross-layer dev logger for the Electron main process.
//
// Aligns with the JUCE backend's `silverdaw::log` and the renderer's
// `lib/log.ts`: each session writes one directory `<log-parent>/<ISO-stamp>/`
// with main.log (this process), backend.log (JUCE, via `SILVERDAW_LOG_DIR` on
// spawn) and renderer.log (Vue events over `log:append-batch`). All lines share
// `<ISO timestamp ms>Z LEVEL [tag] message` so the three merge by timestamp.

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { inspect } from 'node:util'

/** Five-char padded level matches the backend so columns line up in a merged tail. */
export type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

let sessionDir = ''
let mainStream: WriteStream | null = null
let rendererStream: WriteStream | null = null
// Always-on diagnostics stream, independent of the user's logging preference:
// captures backend spawn/exit and startup milestones so a failed launch on a
// machine we can't attach to leaves an easy-to-find trace next to the backend's
// own crash report. See initDiagnostics / logDiag.
let diagStream: WriteStream | null = null
let diagnosticsDir = ''

/** Preserve Error stacks and render objects readably instead of `[object Object]`. */
function formatLogValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message
  if (typeof value === 'string') return value
  return inspect(value, { depth: 4, breakLength: Infinity })
}

/** Route the mirrored line to the console method that matches its level. */
function mirrorToConsole(level: LogLevel, line: string): void {
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN ') console.warn(line)
  else console.log(line)
}

/**
 * Resolve `<logParentDir>/<ISO-stamp>/` and open the main + renderer log
 * streams for append. Returns the absolute session directory path so the
 * caller can export it as `SILVERDAW_LOG_DIR` when spawning the backend.
 *
 * Stamps are filesystem-safe (`:` and `.` replaced with `-`) so the dir
 * works on every platform.
 */
export function initLogs(logParentDir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  sessionDir = join(logParentDir, stamp)
  mkdirSync(sessionDir, { recursive: true })
  mainStream = createWriteStream(join(sessionDir, 'main.log'), { flags: 'a' })
  rendererStream = createWriteStream(join(sessionDir, 'renderer.log'), { flags: 'a' })
  return sessionDir
}

/**
 * Append one structured line to `main.log` (once `initLogs()` has run) and
 * always mirror it to the console so diagnostics are visible in the dev
 * terminal and during the pre-init/bootstrap phase. Extra `args` (errors,
 * paths, objects) are folded into the message; `Error`s keep their stack.
 */
export function logMain(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
  const detail = args.length > 0 ? ` ${args.map(formatLogValue).join(' ')}` : ''
  const line = `${new Date().toISOString()} ${level} [${tag}] ${message}${detail}`
  mainStream?.write(`${line}\n`)
  mirrorToConsole(level, line)
}

/**
 * Append a renderer-originated line to `renderer.log`. Called from the
 * `log:append-batch` IPC handler.
 */
export function logRendererLine(level: LogLevel, tag: string, message: string, timestampMs?: number): void {
  if (!rendererStream) return
  const ts = typeof timestampMs === 'number' ? new Date(timestampMs).toISOString() : new Date().toISOString()
  rendererStream.write(`${ts} ${level} [${tag}] ${message}\n`)
}

/** Flush + close both streams. Idempotent. */
export function closeLogs(): void {
  mainStream?.end()
  rendererStream?.end()
  mainStream = null
  rendererStream = null
}

/** Absolute path to the current session's log directory, or empty string before init. */
export function getSessionDir(): string {
  return sessionDir
}

/**
 * Open the ALWAYS-ON diagnostics log at `<diagDir>/startup.log` (append). Unlike
 * `initLogs`, this runs on every launch regardless of the user's diagnostic-logging
 * preference, so a crashed or failed-to-connect startup is always traceable. The
 * same `diagDir` is handed to the backend (`SILVERDAW_DIAG_DIR`) for its crash
 * report. Returns the directory, or empty string if it could not be opened.
 */
export function initDiagnostics(diagDir: string): string {
  try {
    mkdirSync(diagDir, { recursive: true })
    diagnosticsDir = diagDir
    diagStream = createWriteStream(join(diagDir, 'startup.log'), { flags: 'w' })
    logDiag('INFO ', 'diag', `--- launch ${new Date().toISOString()} ---`)
    return diagDir
  } catch {
    diagStream = null
    diagnosticsDir = ''
    return ''
  }
}

/** Absolute path to the always-on diagnostics directory, or empty before init. */
export function getDiagnosticsDir(): string {
  return diagnosticsDir
}

/** Append a line to the always-on diagnostics log (no-op before initDiagnostics). */
export function logDiag(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
  if (!diagStream) return
  const detail = args.length > 0 ? ` ${args.map(formatLogValue).join(' ')}` : ''
  diagStream.write(`${new Date().toISOString()} ${level} [${tag}] ${message}${detail}\n`)
}

/** Flush + close the diagnostics stream. Idempotent. */
export function closeDiagnostics(): void {
  diagStream?.end()
  diagStream = null
}
