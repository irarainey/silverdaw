// Renderer-side logger.
//
// Buffers structured log entries and flushes them over IPC to the main
// process, which persists them to `.logs/<session>/renderer.log` in the
// same per-session directory as `main.log` and `backend.log`. All three
// files share a single line format:
//
//   <ISO timestamp ms>Z LEVEL [tag] message
//
// so post-mortem analysis is a simple `cat *.log | sort` away.
//
// Batching policy:
//   - Each `log.*(tag, message)` call enqueues an entry with the
//     current wall-clock timestamp (Date.now()).
//   - The first enqueue arms a 50 ms timer; subsequent calls just push.
//   - On timer fire we ship the whole queue via `silverdaw.logBatch`.
//
// Why batch: high-frequency events (drag frames, mouse moves) would
// otherwise saturate IPC. A 50 ms window collapses a drag into one or
// two IPC round trips without losing temporal granularity in the log.
//
// On window unload we attempt a synchronous flush so the final actions
// before close still make it to disk.

export type LogLevel = 'DEBUG' | 'INFO ' | 'WARN ' | 'ERROR'

interface LogEntry {
  level: LogLevel
  tag: string
  message: string
  timestamp: number
}

const queue: LogEntry[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  flushTimer = null
  if (queue.length === 0) return
  const batch = queue.splice(0, queue.length)
  // window.silverdaw is set up by preload before the renderer module
  // graph evaluates, but log calls fire from constructors / setup blocks
  // before that's guaranteed in every path. Guard so a too-early call
  // is silently dropped rather than crashing the app.
  const api = (globalThis as { silverdaw?: { logBatch?: (entries: LogEntry[]) => Promise<void> } }).silverdaw
  if (!api?.logBatch) return
  void api.logBatch(batch).catch((err) => {
    // Suppressed: if IPC is unavailable (e.g. during teardown) there's
    // nothing useful to do with the failure beyond keeping the renderer
    // alive. The original messages are already gone.
    console.warn('[log] failed to flush batch', err)
  })
}

function enqueue(level: LogLevel, tag: string, message: string): void {
  queue.push({ level, tag, message, timestamp: Date.now() })
  if (!flushTimer) flushTimer = setTimeout(flush, 50)
}

/**
 * Cross-layer logger. Use this instead of `console.log` for anything
 * worth correlating against backend / main events.
 *
 * Tags should be short subsystem names (`'bridge'`, `'project'`,
 * `'transport'`, `'timeline'`); keep them consistent across one file's
 * call sites so logs are easy to grep.
 */
export const log = {
  debug: (tag: string, message: string): void => enqueue('DEBUG', tag, message),
  info: (tag: string, message: string): void => enqueue('INFO ', tag, message),
  warn: (tag: string, message: string): void => enqueue('WARN ', tag, message),
  error: (tag: string, message: string): void => enqueue('ERROR', tag, message)
}

// Best-effort final flush on page unload so the very last events make
// it to disk. The IPC is async; we kick it but can't await.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => flush())
}
