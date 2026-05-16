// Cross-layer dev logger for the Electron main process.
//
// Aligns with the JUCE backend's `silverdaw::log` and the renderer's
// `lib/log.ts`: each silverdaw session writes a single directory under
// `<repo>/.logs/<ISO-stamp>/` containing
//
//   - main.log       — events from this process (this file)
//   - backend.log    — JUCE backend events (env var `SILVERDAW_LOG_DIR`
//                      is exported on spawn so the C++ logger writes
//                      into the same directory)
//   - renderer.log   — Vue / renderer-process events delivered here over
//                      the `log:append-batch` IPC and persisted via this
//                      module
//
// All lines share the format
//
//   <ISO timestamp ms>Z LEVEL [tag] message
//
// so the three logs can be merged and sorted by timestamp post-mortem.

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** Five-char padded level matches the backend so columns line up in a merged tail. */
export type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

let sessionDir = ''
let mainStream: WriteStream | null = null
let rendererStream: WriteStream | null = null

/**
 * Resolve `<repo>/.logs/<ISO-stamp>/` and open the main + renderer log
 * streams for append. Returns the absolute session directory path so the
 * caller can export it as `SILVERDAW_LOG_DIR` when spawning the backend.
 *
 * Stamps are filesystem-safe (`:` and `.` replaced with `-`) so the dir
 * works on every platform.
 */
export function initLogs(repoRoot: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  sessionDir = join(repoRoot, '.logs', stamp)
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
