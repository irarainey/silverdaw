import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { logMain } from './log'

/** Compress staged copies without wildcard expansion or a PowerShell module dependency. */
export async function compressDiagnostics(sourceDir: string, zipPath: string): Promise<boolean> {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(sourceDir)}, ${quote(zipPath)})`
  ].join('; ')
  const completed = await new Promise<boolean>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          logMain('WARN ', 'diag', 'diagnostics ZIP failed', error, stderr.trim())
          resolve(false)
        } else {
          resolve(true)
        }
      }
    )
  })
  if (!completed) return false
  try {
    const output = await stat(zipPath)
    if (output.isFile() && output.size > 0) return true
    logMain('WARN ', 'diag', 'diagnostics ZIP output is empty or not a file')
  } catch (error) {
    logMain('WARN ', 'diag', 'diagnostics ZIP output is missing', error)
  }
  return false
}
