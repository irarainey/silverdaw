// Scratch Editor input preferences (a renderer-only app preference). Currently
// just the momentary crossfader cut key; it maps keyboard input to crossfader
// control and is never sent to the backend. Persisted via the prefs IPC and
// hydrated on demand so the Scratch Editor and Preferences dialog stay in sync.

import { defineStore } from 'pinia'
import { log } from '@/lib/log'
import type { ScratchCrossfaderCutKeyDto } from '@shared/types'

interface ScratchInputSettingsState {
  crossfaderCutKey: ScratchCrossfaderCutKeyDto
  hydrated: boolean
}

export const useScratchInputSettingsStore = defineStore('scratchInputSettings', {
  state: (): ScratchInputSettingsState => ({ crossfaderCutKey: 'KeyZ', hydrated: false }),
  actions: {
    /** Persist + apply a new cut key. */
    setCrossfaderCutKey(key: ScratchCrossfaderCutKeyDto): void {
      this.crossfaderCutKey = key
      this.hydrated = true
      window.silverdaw.setScratchSettings({ crossfaderCutKey: key })
    },

    /** Load the persisted cut key once; safe to call on every editor open. */
    async hydrate(): Promise<void> {
      if (this.hydrated) return
      try {
        const prefs = await window.silverdaw.getScratchSettings()
        this.crossfaderCutKey = prefs.crossfaderCutKey
      } catch (err) {
        log.warn('scratch', `scratch input settings hydrate failed, using default: ${String(err)}`)
        this.crossfaderCutKey = 'KeyZ'
      }
      this.hydrated = true
    }
  }
})
