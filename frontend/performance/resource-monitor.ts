import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resourceSchema, type ResourceSample } from './contracts.ts'

export function monitorResources(
  pids: readonly number[],
  maxPrivateMiB: number,
  intervalMs: number
): {
  samples: ResourceSample[]
  failure: Promise<never>
  ready: Promise<void>
  stop: () => Promise<void>
} {
  if (!pids.length || pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error('Expected owned, positive process IDs')
  }
  const script = `
    $ErrorActionPreference = 'Stop'
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      $sampleMs = $clock.Elapsed.TotalMilliseconds
      $data = @(Get-Process -Id ${pids.join(',')} | ForEach-Object {
        [pscustomobject]@{
          pid = $_.Id; sampleMs = $sampleMs; privateBytes = $_.PrivateMemorySize64
          workingSetBytes = $_.WorkingSet64; handles = $_.HandleCount
          cpuMs = $_.TotalProcessorTime.TotalMilliseconds
        }
      })
      ConvertTo-Json -InputObject $data -Compress
      Start-Sleep -Milliseconds ${intervalMs}
    }`
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const samples: ResourceSample[] = []
  let stopping = false
  let stderr = ''
  let fail: (error: Error) => void = () => {}
  let markReady: () => void = () => {}
  const failure = new Promise<never>((_, reject) => {
    fail = reject
  })
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    try {
      const sample = resourceSchema.parse(JSON.parse(line))
      samples.push(sample)
      markReady()
      if (sample.reduce((sum, item) => sum + item.privateBytes, 0) > maxPrivateMiB * 1024 ** 2) {
        fail(new Error(`Private-memory budget exceeded (${maxPrivateMiB} MiB)`))
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  const closed = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      fail(error)
      resolve()
    })
    child.on('close', (code) => {
      if (!stopping) fail(new Error(`Resource monitor exited (${code}): ${stderr}`))
      resolve()
    })
  })
  return {
    samples,
    ready,
    failure,
    stop: async () => {
      stopping = true
      lines.close()
      child.stdout.destroy()
      child.stderr.destroy()
      child.kill()
      await closed
    }
  }
}
