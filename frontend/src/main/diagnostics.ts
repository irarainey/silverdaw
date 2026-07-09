// "Send Diagnostic Logs" support flow (Help ▸ Send Diagnostic Logs, enabled only when
// diagnostic logging is on for the run). Because a `mailto:` URI cannot carry an
// attachment, this zips the current run's logs, REVEALS the zip in the file manager, and
// opens a pre-filled email draft to support — the user drags the revealed zip into the
// draft and sends it. Nothing is transmitted automatically.

import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getDiagnosticsDir, getSessionDir, logMain } from './log'

const SUPPORT_EMAIL = 'support@silverdaw.com'

/** Absolute paths of every log file in `dir` (non-recursive). Missing dir → nothing. */
function collectLogFiles(dir: string): string[] {
  if (!dir || !existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).isFile()) out.push(p)
    } catch {
      // A vanished/locked entry is not worth failing the whole bundle over.
    }
  }
  return out
}

/** Zip a folder's contents with the OS's built-in PowerShell Compress-Archive (Windows). */
function compressToZip(sourceDir: string, zipPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Single-quote the paths for PowerShell; embedded single quotes are escaped by doubling.
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const command = `Compress-Archive -Path ${q(join(sourceDir, '*'))} -DestinationPath ${q(zipPath)} -Force`
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true }
    )
    ps.on('error', (err) => {
      logMain('ERROR', 'diag', 'diagnostics zip failed to spawn', err)
      resolve(false)
    })
    ps.on('exit', (code) => {
      if (code !== 0) logMain('WARN ', 'diag', `diagnostics zip exited with code ${code}`)
      resolve(code === 0 && existsSync(zipPath))
    })
  })
}

/**
 * Build a zip of the current run's logs, reveal it in the file manager, and open a
 * pre-filled support email draft. Best-effort: any failure is logged and the flow
 * degrades (e.g. still reveals the staged logs) rather than throwing to the caller.
 * Resolves `true` when a bundle (zip or staged folder) was produced for the user.
 */
export async function sendDiagnosticLogs(): Promise<boolean> {
  // The current run's verbose logs, plus the always-on diagnostics (startup + crash).
  const sessionDir = getSessionDir()
  const diagDir = getDiagnosticsDir()
  const files = [
    ...collectLogFiles(sessionDir),
    ...(diagDir && diagDir !== sessionDir ? collectLogFiles(diagDir) : [])
  ]
  if (files.length === 0) {
    logMain('WARN ', 'diag', 'send diagnostics: no log files found for this run')
    return false
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Stage copies first: the live logs are open for append, so zip a fresh, unlocked copy.
  const staging = join(tmpdir(), `silverdaw-diagnostics-${stamp}`)
  // Write the finished zip into the logs directory itself (the parent of the per-run
  // session folder), so it sits alongside the logs it bundles rather than in the OS
  // temp — easy to find, and it travels with the app's Silverdaw\Logs folder.
  const logsRoot = sessionDir ? dirname(sessionDir) : tmpdir()
  const zipPath = join(logsRoot, `silverdaw-diagnostics-${stamp}.zip`)
  try {
    mkdirSync(staging, { recursive: true })
    for (const src of files) {
      try {
        copyFileSync(src, join(staging, basename(src)))
      } catch (err) {
        logMain('WARN ', 'diag', `could not stage log ${basename(src)}`, err)
      }
    }
  } catch (err) {
    logMain('ERROR', 'diag', 'could not create diagnostics staging folder', err)
    return false
  }

  const zipped = await compressToZip(staging, zipPath)
  // Reveal whatever we produced so the user can attach it: the zip if it built, else the
  // staged folder of plain logs as a fallback.
  const revealTarget = zipped ? zipPath : staging
  shell.showItemInFolder(revealTarget)

  const version = app.getVersion()
  const subject = `Silverdaw diagnostic logs (v${version})`
  const body = [
    'Please describe the problem here:',
    '',
    '',
    '',
    '------------------------------------------------------------',
    `Silverdaw version: ${version}`,
    'Please attach the diagnostics file that was just revealed in File Explorer:',
    revealTarget
  ].join('\r\n')
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  try {
    await shell.openExternal(mailto)
  } catch (err) {
    logMain('WARN ', 'diag', 'could not open mail client', err)
  }
  logMain('INFO ', 'diag', `diagnostics bundle ready (${files.length} file(s))`)
  return true
}
