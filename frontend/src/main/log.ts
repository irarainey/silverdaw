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

/** Five-char padded level matches the backend so columns line up in a merged tail. */
export type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

let sessionDir = ''
let mainStream: WriteStream | null = null
let rendererStream: WriteStream | null = null

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

/** Append one line to `main.log`. Safe to call before `initLogs()`; ignored if so. */
export function logMain(level: LogLevel, tag: string, message: string): void {
  if (!mainStream) return
  mainStream.write(`${new Date().toISOString()} ${level} [${tag}] ${message}\n`)
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
