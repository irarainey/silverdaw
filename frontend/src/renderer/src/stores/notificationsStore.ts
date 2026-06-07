// Transient toast notifications: low-priority, time-limited feedback that
// doesn't warrant a modal (e.g. backend `CLIP_ADD` rejection). A tiny
// append-only ring with auto-dismiss; `<NotificationToasts>` renders `items`.

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
     * Push a toast and schedule auto-dismiss. `ttlMs <= 0` keeps it until an
     * explicit `dismiss()`. When toasts are disabled in Preferences the item is
     * not appended but the event is still logged so debug info isn't lost.
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
