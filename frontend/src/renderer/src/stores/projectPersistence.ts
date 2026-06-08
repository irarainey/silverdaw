// Project persistence request/ack coordination. Owns the in-flight resolver
// state (save / view-state save / autosave / recovery load) and the bridge
// commands that drive them. The store exposes thin action wrappers; this module
// is the single owner of the Promise resolvers (kept out of Pinia's reactive
// proxy, which can't serialise functions).

import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import { useNotificationsStore } from '@/stores/notificationsStore'
import type { ProjectState } from './projectTypes'

/** Store fields the persistence handshakes read/write. */
type PersistenceTarget = Pick<
  ProjectState,
  'currentFilePath' | 'viewScrollX' | 'viewPxPerSecond' | 'pendingRecoveredProjectId'
>

type SaveResult = { ok: boolean; error?: string }

// Single in-flight resolver per concern; module-level because Promise resolvers
// aren't serialisable into Pinia's proxy.
let pendingSaveResolver: ((result: SaveResult) => void) | null = null
let pendingViewStateSaveResolver: ((result: SaveResult) => void) | null = null
let pendingSaveTimeout: ReturnType<typeof setTimeout> | null = null
const PENDING_SAVE_TIMEOUT_MS = 10000
let pendingRecoveryLoadResolver: ((result: SaveResult) => void) | null = null
let pendingRecoveryLoadTimeout: ReturnType<typeof setTimeout> | null = null
const PENDING_LOAD_TIMEOUT_MS = 10000

/** Outstanding autosave resolvers keyed by filePath so a project swap can't cross-resolve acks. */
const pendingAutosaveResolvers = new Map<string, (result: SaveResult) => void>()

/** Save current path; caller owns Save As dialog fallback. */
export function requestSave(target: PersistenceTarget): boolean {
  if (!target.currentFilePath) return false
  log.info('project', `requestSave path=${target.currentFilePath}`)
  const sent = sendBridge('PROJECT_SAVE', {
    filePath: target.currentFilePath,
    viewScrollX: target.viewScrollX ?? undefined,
    viewPxPerSecond: target.viewPxPerSecond ?? undefined
  })
  if (!sent) {
    useNotificationsStore().pushError('Save failed: the audio engine isn\'t connected.')
  }
  return true
}

export function requestSaveAs(target: PersistenceTarget, filePath: string): void {
  log.info('project', `requestSaveAs path=${filePath}`)
  const sent = sendBridge('PROJECT_SAVE_AS', {
    filePath,
    viewScrollX: target.viewScrollX ?? undefined,
    viewPxPerSecond: target.viewPxPerSecond ?? undefined
  })
  if (!sent) {
    useNotificationsStore().pushError('Save failed: the audio engine isn\'t connected.')
  }
}

/** Await PROJECT_SAVED so unsaved-change flows can continue deterministically. */
export function saveAndWait(target: PersistenceTarget, filePath: string, isSaveAs: boolean): Promise<SaveResult> {
  // Supersede stale waits so backend restarts cannot block the UI forever.
  if (pendingSaveResolver) pendingSaveResolver({ ok: false, error: 'Superseded by a newer save' })
  if (pendingSaveTimeout) {
    clearTimeout(pendingSaveTimeout)
    pendingSaveTimeout = null
  }
  const promise = new Promise<SaveResult>((resolve) => {
    pendingSaveResolver = resolve
    pendingSaveTimeout = setTimeout(() => {
      pendingSaveTimeout = null
      if (!pendingSaveResolver) return
      pendingSaveResolver({ ok: false, error: 'Timed out waiting for the audio engine to save' })
      pendingSaveResolver = null
    }, PENDING_SAVE_TIMEOUT_MS)
  })
  const sent = isSaveAs
    ? sendBridge('PROJECT_SAVE_AS', {
        filePath,
        viewScrollX: target.viewScrollX ?? undefined,
        viewPxPerSecond: target.viewPxPerSecond ?? undefined
      })
    : sendBridge('PROJECT_SAVE', {
        filePath,
        viewScrollX: target.viewScrollX ?? undefined,
        viewPxPerSecond: target.viewPxPerSecond ?? undefined
      })
  if (!sent) {
    if (pendingSaveTimeout) {
      clearTimeout(pendingSaveTimeout)
      pendingSaveTimeout = null
    }
    pendingSaveResolver?.({ ok: false, error: 'The audio engine isn\'t connected' })
    pendingSaveResolver = null
  }
  return promise
}

/** Resolve any pending saveAndWait on PROJECT_SAVED. */
export function notifySaveAck(ok: boolean, error?: string): void {
  if (pendingSaveTimeout) {
    clearTimeout(pendingSaveTimeout)
    pendingSaveTimeout = null
  }
  if (pendingSaveResolver) {
    pendingSaveResolver({ ok, error })
    pendingSaveResolver = null
  }
}

export function saveViewStateAndWait(target: PersistenceTarget): Promise<SaveResult> {
  if (!target.currentFilePath) return Promise.resolve({ ok: true })
  if (pendingViewStateSaveResolver) {
    pendingViewStateSaveResolver({ ok: false, error: 'Superseded by a newer view-state save' })
  }
  const promise = new Promise<SaveResult>((resolve) => {
    pendingViewStateSaveResolver = resolve
  })
  sendBridge('PROJECT_SAVE_VIEW_STATE', {
    filePath: target.currentFilePath,
    viewScrollX: target.viewScrollX ?? 0,
    viewPxPerSecond: target.viewPxPerSecond ?? undefined
  })
  return promise
}

export function notifyViewStateSaveAck(ok: boolean, error?: string): void {
  if (pendingViewStateSaveResolver) {
    pendingViewStateSaveResolver({ ok, error })
    pendingViewStateSaveResolver = null
  }
}

/** Autosave tick with timeout so manifest resolvers cannot leak. */
export function autosaveAndWait(target: PersistenceTarget, filePath: string): Promise<SaveResult> {
  // Supersede older ticks for this file so acks cannot resolve the wrong promise.
  const existing = pendingAutosaveResolvers.get(filePath)
  if (existing) {
    existing({ ok: false, error: 'Superseded by a newer autosave' })
    pendingAutosaveResolvers.delete(filePath)
  }
  const promise = new Promise<SaveResult>((resolve) => {
    pendingAutosaveResolvers.set(filePath, resolve)
  })
  const sent = sendBridge('PROJECT_AUTOSAVE', {
    filePath,
    viewScrollX: target.viewScrollX ?? undefined,
    viewPxPerSecond: target.viewPxPerSecond ?? undefined
  })
  if (!sent) {
    pendingAutosaveResolvers.delete(filePath)
    return Promise.resolve({ ok: false, error: 'The audio engine isn\'t connected' })
  }
  // Dropped acks must not leak resolvers.
  const timeoutId = setTimeout(() => {
    const r = pendingAutosaveResolvers.get(filePath)
    if (r) {
      r({ ok: false, error: 'Autosave timed out' })
      pendingAutosaveResolvers.delete(filePath)
    }
  }, PENDING_SAVE_TIMEOUT_MS)
  // Bridge dispatch must clear the timeout before resolving.
  const original = pendingAutosaveResolvers.get(filePath)!
  const wrapped = (result: SaveResult): void => {
    clearTimeout(timeoutId)
    original(result)
  }
  pendingAutosaveResolvers.set(filePath, wrapped)
  return promise
}

export function notifyAutosaveAck(filePath: string, ok: boolean, error?: string): void {
  const resolver = pendingAutosaveResolvers.get(filePath)
  if (resolver) {
    pendingAutosaveResolvers.delete(filePath)
    resolver({ ok, error })
  }
}

export function requestLoad(filePath: string): void {
  log.info('project', `requestLoad path=${filePath}`)
  sendBridge('PROJECT_LOAD', { filePath })
}

/** Recovery loads autosave content but keeps the original path dirty. */
export function requestLoadRecovery(
  target: PersistenceTarget,
  autosavePath: string,
  originalPath: string | null,
  projectId?: string
): Promise<SaveResult> {
  log.info(
    'project',
    `requestLoadRecovery autosavePath=${autosavePath} originalPath=${originalPath ?? 'null'} projectId=${projectId ?? 'null'}`
  )
  target.pendingRecoveredProjectId = projectId ?? null
  if (pendingRecoveryLoadResolver) {
    pendingRecoveryLoadResolver({ ok: false, error: 'Superseded by a newer recovery load' })
  }
  if (pendingRecoveryLoadTimeout) {
    clearTimeout(pendingRecoveryLoadTimeout)
    pendingRecoveryLoadTimeout = null
  }
  const promise = new Promise<SaveResult>((resolve) => {
    pendingRecoveryLoadResolver = resolve
    pendingRecoveryLoadTimeout = setTimeout(() => {
      pendingRecoveryLoadTimeout = null
      target.pendingRecoveredProjectId = null
      if (!pendingRecoveryLoadResolver) return
      pendingRecoveryLoadResolver({
        ok: false,
        error: 'Timed out waiting for the audio engine to load'
      })
      pendingRecoveryLoadResolver = null
    }, PENDING_LOAD_TIMEOUT_MS)
  })
  const sent = sendBridge('PROJECT_LOAD_RECOVERY', { autosavePath, originalPath })
  if (!sent) {
    if (pendingRecoveryLoadTimeout) {
      clearTimeout(pendingRecoveryLoadTimeout)
      pendingRecoveryLoadTimeout = null
    }
    target.pendingRecoveredProjectId = null
    pendingRecoveryLoadResolver?.({ ok: false, error: 'The audio engine isn\'t connected' })
    pendingRecoveryLoadResolver = null
  }
  return promise
}

export function notifyProjectLoadFailed(target: PersistenceTarget, error?: string): void {
  if (pendingRecoveryLoadTimeout) {
    clearTimeout(pendingRecoveryLoadTimeout)
    pendingRecoveryLoadTimeout = null
  }
  target.pendingRecoveredProjectId = null
  if (pendingRecoveryLoadResolver) {
    pendingRecoveryLoadResolver({ ok: false, error })
    pendingRecoveryLoadResolver = null
  }
}

/** Resolve a successful recovery load once its PROJECT_STATE snapshot has applied. */
export function resolvePendingRecoveryLoad(): void {
  if (pendingRecoveryLoadTimeout) {
    clearTimeout(pendingRecoveryLoadTimeout)
    pendingRecoveryLoadTimeout = null
  }
  if (pendingRecoveryLoadResolver) {
    pendingRecoveryLoadResolver({ ok: true })
    pendingRecoveryLoadResolver = null
  }
}
