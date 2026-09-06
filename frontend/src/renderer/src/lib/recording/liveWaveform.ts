// Rolling column buffer for the live recording waveform.
//
// The renderer never receives recorded audio (ADR 0003), so the "waveform" drawn
// while a take is rolling is built from the input level meter the backend
// already broadcasts: one column per sampling tick, held in a ring so a long
// recording costs a fixed amount of memory and the whole take can be drawn at
// once, summarised down to the columns the view has room for.
//
// This is a picture of what the input is doing, not of the file — the real
// waveform, drawn from the peaks cache, arrives with the finished recording.

/** How much wall-clock time one column represents. Matches the meter's own
 *  broadcast rate closely enough that no column is drawn from stale data. */
export const LIVE_COLUMN_MS = 33

export interface LiveWaveformBuffer {
  /** Column magnitudes, 0..1, oldest-first once `count` exceeds `capacity`. */
  readonly values: Float32Array
  /** Where the next column is written. */
  head: number
  /** Total columns ever pushed, so callers know the elapsed span. */
  count: number
  readonly capacity: number
}

export function createLiveWaveform(capacity: number): LiveWaveformBuffer {
  const size = Math.max(1, Math.floor(capacity))
  return { values: new Float32Array(size), head: 0, count: 0, capacity: size }
}

export function resetLiveWaveform(buffer: LiveWaveformBuffer): void {
  buffer.values.fill(0)
  buffer.head = 0
  buffer.count = 0
}

export function pushLiveColumn(buffer: LiveWaveformBuffer, magnitude: number): void {
  const clamped = Math.min(1, Math.max(0, magnitude))
  buffer.values[buffer.head] = clamped
  buffer.head = (buffer.head + 1) % buffer.capacity
  buffer.count += 1
}

/**
 * The most recent `limit` columns, oldest-first.
 *
 * Returned as a plain array because the caller draws them left to right and a
 * ring's wrap-around is exactly the detail a drawing loop should not have to
 * know about.
 */
export function readLiveColumns(buffer: LiveWaveformBuffer, limit: number): number[] {
  const available = Math.min(buffer.count, buffer.capacity)
  const wanted = Math.min(available, Math.max(0, Math.floor(limit)))
  const out: number[] = []
  for (let index = wanted; index > 0; index -= 1) {
    const position = (buffer.head - index + buffer.capacity * 2) % buffer.capacity
    out.push(buffer.values[position] ?? 0)
  }
  return out
}

/**
 * The whole take in `targetColumns` columns, oldest-first.
 *
 * While the take is shorter than the view every column is drawn as it was
 * pushed; past that it is summarised — each drawn column takes the loudest of
 * the columns it covers — so the start of a long take stays on screen instead of
 * scrolling out of it. Peak, not average, because a summary that smooths away
 * transients stops looking like the audio it represents.
 */
export function readFittedColumns(buffer: LiveWaveformBuffer, targetColumns: number): number[] {
  const available = Math.min(buffer.count, buffer.capacity)
  const target = Math.max(1, Math.floor(targetColumns))
  if (available <= 0) return []
  if (available <= target) return readLiveColumns(buffer, available)

  const oldest = (buffer.head - available + buffer.capacity * 2) % buffer.capacity
  const out: number[] = []
  for (let column = 0; column < target; column += 1) {
    const from = Math.floor((column * available) / target)
    const to = Math.max(from + 1, Math.floor(((column + 1) * available) / target))
    let peak = 0
    for (let index = from; index < to && index < available; index += 1) {
      peak = Math.max(peak, buffer.values[(oldest + index) % buffer.capacity] ?? 0)
    }
    out.push(peak)
  }
  return out
}

/**
 * Where beat lines fall across the visible columns, as fractions of the view.
 *
 * `elapsedMs` is the time at the *right* edge, because that is where a live
 * waveform is always writing; the lines therefore scroll left with the audio
 * rather than sitting still under it. Returns an empty list for a tempo or a
 * span that could not produce a sensible grid, so the caller never has to guard.
 */
export function liveBeatFractions(
  elapsedMs: number,
  spanMs: number,
  bpm: number,
  beatsPerBar: number
): { fraction: number; bar: boolean }[] {
  if (!(spanMs > 0) || !(bpm > 0) || !(beatsPerBar > 0)) return []
  const beatMs = 60_000 / bpm
  // A grid finer than a few pixels a beat is noise, not information.
  if (beatMs <= 0 || spanMs / beatMs > 256) return []
  const startMs = Math.max(0, elapsedMs - spanMs)
  const firstBeat = Math.ceil(startMs / beatMs)
  const lastBeat = Math.floor(elapsedMs / beatMs)
  const out: { fraction: number; bar: boolean }[] = []
  for (let beat = firstBeat; beat <= lastBeat; beat += 1) {
    const fraction = (beat * beatMs - startMs) / spanMs
    if (fraction < 0 || fraction > 1) continue
    out.push({ fraction, bar: beat % beatsPerBar === 0 })
  }
  return out
}
