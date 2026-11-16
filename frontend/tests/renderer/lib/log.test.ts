import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushLogBatch, log, setLogEnabled } from '@/lib/log'

afterEach(() => {
  setLogEnabled(false)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('diagnostic log snapshots', () => {
  it('flushes the menu action before its batching timer and waits for IPC', async () => {
    vi.useFakeTimers()
    let acknowledge: (() => void) | undefined
    const logBatch = vi.fn(() => new Promise<void>((resolve) => { acknowledge = resolve }))
    vi.stubGlobal('silverdaw', { logBatch })
    setLogEnabled(true)
    log.info('menu', 'action help.sendDiagnostics')
    let completed = false
    const pending = flushLogBatch().then(() => { completed = true })
    expect(logBatch).toHaveBeenCalledWith([
      expect.objectContaining({ tag: 'menu', message: 'action help.sendDiagnostics' })
    ])
    expect(vi.getTimerCount()).toBe(0)
    await Promise.resolve()
    expect(completed).toBe(false)
    acknowledge!()
    await pending
    expect(completed).toBe(true)
  })
})
