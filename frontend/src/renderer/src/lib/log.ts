// Renderer-side logger. Batches entries over IPC into per-session debug logs.
// Format: <ISO timestamp ms>Z LEVEL [tag] message.
// A 50 ms window keeps high-frequency UI events from saturating IPC.

export type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

interface LogEntry {
  level: LogLevel
  tag: string
  message: string
  timestamp: number
}

// Fast off-switch until startup enables renderer logging.
let enabled = false

const queue: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function setLogEnabled(value: boolean): void {
  enabled = value
  if (!enabled) {
    queue.length = 0
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }
}

function flush(): void {
  flushTimer = null
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  // Drop too-early log calls before preload exposes the IPC API.
  const api = (globalThis as { silverdaw?: { logBatch?: (entries: LogEntry[]) => Promise<void> } }).silverdaw
  if (!api?.logBatch) return
  void api.logBatch(batch).catch((err) => {
    // Keep teardown-time IPC failures from crashing the renderer.
    console.warn('[log] failed to flush batch', err)
  })
}

function enqueue(level: LogLevel, tag: string, message: string): void {
  if (!enabled) return
  queue.push({ level, tag, message, timestamp: Date.now() })
  if (!flushTimer) flushTimer = setTimeout(flush, 50)
}

/** Cross-layer logger for events worth correlating with main/backend logs. */
export const log = {
  debug: (tag: string, message: string): void => enqueue('DEBUG', tag, message),
  info: (tag: string, message: string): void => enqueue('INFO ', tag, message),
  warn: (tag: string, message: string): void => enqueue('WARN ', tag, message),
  error: (tag: string, message: string): void => enqueue('ERROR', tag, message)
}

// Best-effort final flush; IPC is async and can't be awaited here.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flush())
}
