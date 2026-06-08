// Dynamic loopback bridge-port resolution for the Electron main process.
// Main owns the port and passes it to the backend and renderer.

import { createServer as createNetServer } from 'node:net'
import { logMain } from './log'

export const DEFAULT_BRIDGE_PORT = 8765
export const MIN_BRIDGE_PORT = 1024
export const MAX_BRIDGE_PORT = 65535

/** Resolves the configured base port from the environment, falling back safely. */
export function resolveBridgePort(): number {
  const raw = process.env['SILVERDAW_BRIDGE_PORT']
  if (raw === undefined || raw === '') return DEFAULT_BRIDGE_PORT
  const parsed = Number.parseInt(raw, 10)
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < MIN_BRIDGE_PORT ||
    parsed > MAX_BRIDGE_PORT
  ) {
    logMain(
      'WARN ',
      'main',
      `SILVERDAW_BRIDGE_PORT=${raw} is not a valid port in [${MIN_BRIDGE_PORT}, ${MAX_BRIDGE_PORT}]; using default ${DEFAULT_BRIDGE_PORT}`
    )
    return DEFAULT_BRIDGE_PORT
  }
  return parsed
}

/** True when the user explicitly pinned the port via the environment. */
export function isBridgePortEnvOverridden(): boolean {
  return (
    typeof process.env['SILVERDAW_BRIDGE_PORT'] === 'string' &&
    process.env['SILVERDAW_BRIDGE_PORT']!.length > 0
  )
}

// Probe with a short-lived listener for locale-independent port checks.
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once('error', () => {
      resolve(false)
    })
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

export async function findFreeBridgePort(start: number, count: number): Promise<number | null> {
  for (let i = 0; i < count; i++) {
    const candidate = start + i
    if (candidate > MAX_BRIDGE_PORT) break
    if (await isPortFree(candidate)) return candidate
  }
  return null
}
