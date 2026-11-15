import type {
  EnsureStemModelResult,
  StemModelDownloadProgress,
  StemModelState
} from '@shared/types'

export type StemModelKind = 'vocalPack' | 'rhythmPack' | 'htdemucs'

export interface StemModelSource {
  readonly kind: StemModelKind
  getState(): Promise<StemModelState>
  ensure(): Promise<EnsureStemModelResult>
  onProgress(handler: (progress: StemModelDownloadProgress) => void): () => void
  cancel(): void
}

// Preferences and separation can attach to the same main-process download.
function shareModelDownload(source: StemModelSource): StemModelSource {
  let pending: Promise<EnsureStemModelResult> | null = null
  return {
    ...source,
    ensure: () => {
      if (pending) return pending
      const task = source.ensure().finally(() => {
        if (pending === task) pending = null
      })
      pending = task
      return task
    },
    cancel: () => {
      pending = null
      source.cancel()
    }
  }
}

export const MODEL_SOURCES: Readonly<Record<StemModelKind, StemModelSource>> = {
  vocalPack: shareModelDownload({
    kind: 'vocalPack',
    getState: () => window.silverdaw.getVocalPackState(),
    ensure: () => window.silverdaw.ensureVocalPack(),
    onProgress: (handler) => window.silverdaw.onVocalPackDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelVocalPackDownload()
  }),
  rhythmPack: shareModelDownload({
    kind: 'rhythmPack',
    getState: () => window.silverdaw.getRhythmPackState(),
    ensure: () => window.silverdaw.ensureRhythmPack(),
    onProgress: (handler) => window.silverdaw.onRhythmPackDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelRhythmPackDownload()
  }),
  htdemucs: shareModelDownload({
    kind: 'htdemucs',
    getState: () => window.silverdaw.getStemModelState(),
    ensure: () => window.silverdaw.ensureStemModel(),
    onProgress: (handler) => window.silverdaw.onStemModelDownloadProgress(handler),
    cancel: () => window.silverdaw.cancelStemModelDownload()
  })
}
