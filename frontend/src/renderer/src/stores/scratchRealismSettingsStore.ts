// Global Scratch Editor realism preference. Applied after every backend ready
// snapshot so pointer and MIDI platter input share the same sound response.

import { defineStore } from 'pinia'
import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { ScratchRealismLevelDto } from '@shared/types'

interface ScratchRealismSettingsState {
  level: ScratchRealismLevelDto
}

export const useScratchRealismSettingsStore = defineStore('scratchRealismSettings', {
  state: (): ScratchRealismSettingsState => ({ level: 'medium' }),
  actions: {
    sendToBackend(): void {
      sendBridge('SCRATCH_REALISM_SET', { level: this.level })
    },

    setScratchRealismLevel(level: ScratchRealismLevelDto): void {
      this.level = level
      window.silverdaw.setScratchRealismSettings({ level })
      this.sendToBackend()
    },

    async applyScratchRealismOnReady(): Promise<void> {
      try {
        this.level = (await window.silverdaw.getScratchRealismSettings()).level
      } catch (err) {
        log.warn('scratch', `scratch realism hydrate failed, using default: ${String(err)}`)
        this.level = 'medium'
      }
      this.sendToBackend()
    }
  }
})
