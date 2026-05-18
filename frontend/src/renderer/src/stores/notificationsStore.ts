// Transient toast notifications.
//
// Used for low-priority, time-limited feedback that doesn't belong in a
// modal but shouldn't be a silent console log either — currently:
//
//   - Backend rejection of a `CLIP_ADD` (file not decodable, missing, …)
//   - Future: bridge reconnect / disconnect, save failures, …
//
// The store is intentionally tiny: an append-only ring with auto-dismiss.
// `<NotificationToasts>` reads `items` and renders one card per entry.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import { useAppStore } from '@/stores/appStore'

export type NotificationKind = 'error' | 'info'

export interface Notification {
  readonly id: number
  readonly kind: NotificationKind
  readonly message: string
}

interface NotificationsState {
  items: Notification[]
  nextId: number
}

/** How long a toast stays on screen before auto-dismissing. */
const DEFAULT_TTL_MS = 5000

export const useNotificationsStore = defineStore('notifications', {
  state: (): NotificationsState => ({ items: [], nextId: 1 }),

  actions: {
    /**
     * Push a new toast and schedule its auto-dismiss. `ttlMs` of `0` (or
     * negative) keeps the toast on screen until `dismiss()` is called
     * explicitly — only useful for fatal errors, which we don't have yet.
     *
     * When the user has disabled toasts in Preferences the item is NOT
     * appended to the visible list, but the event is still written to
     * the renderer log so debugging information isn't lost.
     */
    push(kind: NotificationKind, message: string, ttlMs: number = DEFAULT_TTL_MS): number {
      const id = this.nextId++
      log[kind === 'error' ? 'warn' : 'info']('notify', `${kind}: ${message}`)
      const appStore = useAppStore()
      if (!appStore.toastsEnabled) {
        return id
      }
      this.items.push({ id, kind, message })
      if (ttlMs > 0) {
        setTimeout(() => this.dismiss(id), ttlMs)
      }
      return id
    },

    /** Convenience: red error toast. */
    pushError(message: string, ttlMs: number = DEFAULT_TTL_MS): number {
      return this.push('error', message, ttlMs)
    },

    /** Convenience: neutral info toast. */
    pushInfo(message: string, ttlMs: number = DEFAULT_TTL_MS): number {
      return this.push('info', message, ttlMs)
    },

    /** Remove a toast by id. No-op if already gone. */
    dismiss(id: number): void {
      const idx = this.items.findIndex((n) => n.id === id)
      if (idx >= 0) this.items.splice(idx, 1)
    },

    /** Remove every toast. Used by tests / explicit "clear" affordances. */
    clear(): void {
      this.items = []
    }
  }
})
