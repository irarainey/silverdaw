// Locating and killing the audio engine spawned by a test's own app instance.
//
// The engine is killed by PID, and that PID is only ever resolved as a *child of
// this test's Electron main process*. Matching on the executable name alone
// would be enough to find a backend, but it would also find a developer's own
// running Silverdaw, so the parent check is the safety property here rather than
// an optimisation.

import { execFileSync } from 'node:child_process'

const BACKEND_EXE = 'SilverdawBackend.exe'

/**
 * Returns the PIDs of engine processes spawned by `parentPid`. Normally one; a
 * respawn in flight can briefly show none.
 */
export function findBackendPids(parentPid: number): number[] {
  const script =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}" ` +
    `| Where-Object { $_.Name -eq '${BACKEND_EXE}' } ` +
    `| Select-Object -ExpandProperty ProcessId`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8'
  })
  return out
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/**
 * Hard-kills the engine belonging to `parentPid`, simulating a crash rather than
 * a clean shutdown, and returns the PID that was killed.
 */
export function killBackend(parentPid: number): number {
  const [pid] = findBackendPids(parentPid)
  if (pid === undefined) {
    throw new Error(`no ${BACKEND_EXE} found as a child of Electron main pid ${parentPid}`)
  }
  // SIGKILL maps to TerminateProcess on Windows: no unwind, no clean socket
  // close — which is the point, since a graceful exit would not exercise
  // recovery.
  process.kill(pid, 'SIGKILL')
  return pid
}
