import { send as sendBridge } from '@/lib/bridgeService'
import { log } from '@/lib/log'
import type { BeatRepeatDivision } from '@shared/bridge-protocol'
import type { ProjectState } from './projectTypes'

export const beatRepeatActions = {
  addTrackBeatRepeat(
    trackId: string,
    startBeat: number,
    lengthBeats: number,
    division: BeatRepeatDivision
  ): void {
    if (!this.tracks.some((track) => track.id === trackId)) return
    sendBridge('TRACK_BEAT_REPEAT_ADD', { trackId, startBeat, lengthBeats, division })
    log.debug('project', `addBeatRepeat track=${trackId} beat=${startBeat} division=${division}`)
  },

  deleteTrackBeatRepeat(trackId: string, regionId: string): void {
    if (!this.tracks.some((track) => track.id === trackId) || regionId.length === 0) return
    sendBridge('TRACK_BEAT_REPEAT_DELETE', { trackId, regionId })
    log.debug('project', `deleteBeatRepeat track=${trackId} region=${regionId}`)
  }
} satisfies Record<string, (this: ProjectState, ...args: never[]) => unknown> & ThisType<ProjectState>
