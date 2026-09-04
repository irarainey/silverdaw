// Plain-language reporting for the Record Audio dialog (ADR 0030).
//
// Every failure the capture path can produce is a distinct thing that happened.
// "Recording failed" on its own is the message that makes a working feature look
// broken, so each code says what happened and what to do next.

import type { RecordingErrorCode } from '@shared/bridge-protocol'

const MESSAGES: Record<RecordingErrorCode, string> = {
  noInput: 'No microphone or audio input was found. Plug one in, then reopen this dialog.',
  openFailed:
    'That input could not be opened. Another app may be using it — close that app, or choose a different input.',
  silentInput:
    'This input is delivering silence. Windows may be blocking microphone access: check Settings ▸ Privacy & security ▸ Microphone, then try again.',
  deviceLost: 'The input was disconnected. Reconnect it, or choose a different input.',
  diskFull: 'There is not enough free disk space to record. Free some space, then try again.',
  writeFailed:
    'The recording could not be written to disk. Check that the project folder is writable, then try again.',
  lengthCap:
    'Recording stopped at the 30 minute limit. Everything captured up to that point has been kept.'
}

/** A sentence for a recording failure. A known code always wins: its wording is
 *  written for the person recording, where the backend's `detail` is diagnostic
 *  text that only makes sense as a fallback. */
export function recordingErrorMessage(
  code: RecordingErrorCode | undefined,
  detail?: string
): string {
  if (code && code in MESSAGES) return MESSAGES[code]
  return detail && detail.length > 0
    ? detail
    : 'Something went wrong with the recording. Try again, or choose a different input.'
}

/** Warning shown when the capture ring overflowed: the file has holes, and the
 *  user is told rather than handed a silently damaged recording. */
export function droppedSamplesMessage(droppedSamples: number, sampleRate: number): string {
  const ms = sampleRate > 0 ? Math.round((droppedSamples / sampleRate) * 1000) : 0
  return `Your computer could not keep up and about ${Math.max(1, ms)} ms of audio was lost. Close other apps before recording again.`
}
