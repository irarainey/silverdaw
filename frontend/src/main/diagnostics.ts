// Nothing is uploaded: reveal a local bundle and open a draft for manual attachment.
import { app, shell } from 'electron'
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { DiagnosticLogsResult } from '../shared/types'
import { compressDiagnostics } from './diagnosticsZip'
import { flushLogs, getDiagnosticsDir, getSessionDir, logMain } from './log'

const SUPPORT_EMAIL = 'support@silverdaw.com'

async function stageLogs(
  source: string,
  destination: string
): Promise<{ copied: number; skipped: number }> {
  if (!source) return { copied: 0, skipped: 0 }
  let entries
  try {
    entries = await readdir(source, { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { copied: 0, skipped: 0 }
    }
    throw error
  }
  await mkdir(destination, { recursive: true })
  let copied = 0
  let skipped = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      await copyFile(join(source, entry.name), join(destination, entry.name))
      copied++
    } catch (error) {
      skipped++
      logMain('WARN ', 'diag', `could not stage log ${entry.name}`, error)
    }
  }
  return { copied, skipped }
}

async function openSupportDraft(path: string, zipped: boolean): Promise<void> {
  const version = app.getVersion()
  const body = [
    'Please describe the problem here:',
    '',
    '',
    '------------------------------------------------------------',
    `Silverdaw version: ${version}`,
    zipped
      ? 'Please attach this diagnostics ZIP from File Explorer:'
      : 'Please compress this diagnostics folder into a ZIP and attach it:',
    path
  ].join('\r\n')
  const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Silverdaw diagnostic logs (v${version})`)}&body=${encodeURIComponent(body)}`
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      shell.openExternal(mailto),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Opening the mail client timed out')), 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Prepare local logs; failures retain copied logs and are returned to the UI. */
export async function sendDiagnosticLogs(): Promise<DiagnosticLogsResult> {
  let staging: string | undefined
  let copied = 0
  try {
    await flushLogs()
    const sessionDir = getSessionDir()
    const diagDir = getDiagnosticsDir()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    staging = await mkdtemp(join(tmpdir(), `silverdaw-diagnostics-${stamp}-`))
    const session = await stageLogs(sessionDir, join(staging, 'session'))
    copied += session.copied
    const diagnostics =
      diagDir && diagDir !== sessionDir
        ? await stageLogs(diagDir, join(staging, 'diagnostics'))
        : { copied: 0, skipped: 0 }
    copied += diagnostics.copied
    if (copied === 0) {
      logMain('WARN ', 'diag', 'send diagnostics: no log files could be copied')
      return {
        ok: false,
        error:
          'No diagnostic logs could be copied. Check the log folder in Preferences > Developer.'
      }
    }

    const warnings: string[] = []
    if (session.skipped + diagnostics.skipped > 0)
      warnings.push('Some log files could not be copied.')
    const zipPath = join(sessionDir ? dirname(sessionDir) : tmpdir(), `${basename(staging)}.zip`)
    const zipped = await compressDiagnostics(staging, zipPath)
    const path = zipped ? zipPath : staging
    if (!zipped) {
      warnings.push('ZIP creation failed. Compress the prepared folder before attaching it.')
      try {
        await rm(zipPath, { force: true })
      } catch (error) {
        logMain('WARN ', 'diag', 'could not remove incomplete diagnostics ZIP', error)
      }
    }
    logMain(
      'INFO ',
      'diag',
      `diagnostics bundle ready: format=${zipped ? 'zip' : 'folder'} files=${copied} path=${path}`
    )
    try {
      shell.showItemInFolder(path)
    } catch (error) {
      logMain('WARN ', 'diag', 'could not reveal diagnostics bundle', error)
      warnings.push('File Explorer could not be opened; use the path below.')
    }
    try {
      await openSupportDraft(path, zipped)
    } catch (error) {
      logMain('WARN ', 'diag', 'could not open mail client', error)
      warnings.push(`The email draft could not be opened. Send the logs to ${SUPPORT_EMAIL}.`)
    }
    // Keep an uncompressed fallback accessible; successful ZIPs no longer need staging.
    if (zipped) {
      try {
        await rm(staging, { recursive: true, force: true })
        staging = undefined
      } catch (error) {
        logMain('WARN ', 'diag', 'could not remove diagnostics staging folder', error)
      }
    }
    return { ok: true, path, zipped, warning: warnings.length > 0 ? warnings.join(' ') : undefined }
  } catch (error) {
    logMain('ERROR', 'diag', 'could not prepare diagnostic logs', error)
    return {
      ok: false,
      error:
        copied > 0 && staging
          ? `Diagnostic preparation failed. Copied logs remain at ${staging}.`
          : 'Diagnostic preparation failed. Open the log folder in Preferences > Developer.'
    }
  } finally {
    if (copied === 0 && staging) {
      try {
        await rm(staging, { recursive: true, force: true })
      } catch (error) {
        logMain('WARN ', 'diag', 'could not remove empty diagnostics staging folder', error)
      }
    }
  }
}
