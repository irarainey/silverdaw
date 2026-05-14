<script setup lang="ts">
// Timeline canvas. Renders track rows with their clips' waveforms.
//
// Implementation notes:
// - PixiJS v8 Application with WebGL preferred (falls back to WebGPU/canvas).
// - One Container per track row; clips are drawn into a single Graphics per
//   clip (cheap, since clips redraw only when the underlying clip changes).
// - The whole layout repaints on resize, track count change, or zoom change.
// - Time-axis is left-to-right, fixed `PX_PER_SECOND` (no zoom yet).

import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Application, Container, Graphics } from 'pixi.js'
import { useProjectStore, type Clip } from '@/stores/projectStore'
import { PEAKS_PER_SECOND } from '@/lib/audio'

const project = useProjectStore()
const host = ref<HTMLDivElement | null>(null)

// Layout constants.
const PX_PER_SECOND = 60
const TRACK_HEIGHT = 96
const TRACK_GAP = 4
const TRACK_HEADER_WIDTH = 140
const RULER_HEIGHT = 28

// Theme (matches tailwind zinc palette).
const BG = 0x09090b // zinc-950
const TRACK_BG = 0x18181b // zinc-900
const TRACK_HEADER_BG = 0x27272a // zinc-800
const RULER_BG = 0x18181b
const RULER_TICK = 0x52525b // zinc-600
const RULER_LABEL_HINT = 0xa1a1aa // zinc-400 (unused without text yet)
const CLIP_FILL = 0x1e3a8a // blue-900
const CLIP_BORDER = 0x3b82f6 // blue-500
const WAVE = 0x93c5fd // blue-300

let app: Application | null = null
let resizeObserver: ResizeObserver | null = null
let rulerLayer: Container | null = null
let tracksLayer: Container | null = null
let headersLayer: Container | null = null
// Constructor handles populated after the dynamic pixi.js import resolves.
let GraphicsCtor: typeof Graphics | null = null
let ContainerCtor: typeof Container | null = null

onMounted(async () => {
  if (!host.value) return

  // Lazy-load PixiJS so the title bar + transport bar render before the
  // ~500 KB pixi bundle finishes parsing. Also apply the CSP-safe shader
  // patch (Electron's renderer disallows `unsafe-eval`) before constructing
  // the WebGL renderer.
  // @ts-expect-error -- pixi.js/unsafe-eval has no published .d.ts; it's side-effect-only.
  await import('pixi.js/unsafe-eval')
  const pixi = await import('pixi.js')
  GraphicsCtor = pixi.Graphics
  ContainerCtor = pixi.Container

  // The component could have unmounted while pixi was loading.
  if (!host.value) return

  app = new pixi.Application()
  await app.init({
    background: BG,
    antialias: true,
    resizeTo: host.value,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1
  })

  // And again — component might have unmounted while init was awaiting.
  if (!host.value) {
    app.destroy(true, { children: true, texture: true })
    app = null
    return
  }

  host.value.appendChild(app.canvas)
  app.canvas.style.display = 'block'

  rulerLayer = new ContainerCtor()
  tracksLayer = new ContainerCtor()
  // Headers drawn last so they sit above any scrolled clip content (future).
  headersLayer = new ContainerCtor()

  app.stage.addChild(rulerLayer)
  app.stage.addChild(tracksLayer)
  app.stage.addChild(headersLayer)

  redraw()

  resizeObserver = new ResizeObserver(() => redraw())
  resizeObserver.observe(host.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
  app?.destroy(true, { children: true, texture: true })
  app = null
})

// Re-render whenever the project changes. `tracks` is what triggers most updates
// because clips are added via `addTrackFromAudio` which mutates this array.
// (For per-clip mutations later, deep-watching `clips` would also be needed.)
watch(
  () => project.tracks.length,
  () => redraw()
)

function redraw(): void {
  if (!app || !rulerLayer || !tracksLayer || !headersLayer) return

  rulerLayer.removeChildren()
  tracksLayer.removeChildren()
  headersLayer.removeChildren()

  const width = app.renderer.width / app.renderer.resolution

  drawRuler(width)
  drawTracks(width)
}

function drawRuler(width: number): void {
  if (!rulerLayer || !GraphicsCtor) return

  const bg = new GraphicsCtor()
  bg.rect(0, 0, width, RULER_HEIGHT).fill(RULER_BG)
  bg.moveTo(0, RULER_HEIGHT - 0.5).lineTo(width, RULER_HEIGHT - 0.5).stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
  rulerLayer.addChild(bg)

  // Tick every second; major tick every 5s.
  const totalSeconds = Math.ceil((width - TRACK_HEADER_WIDTH) / PX_PER_SECOND) + 1
  const ticks = new GraphicsCtor()
  for (let s = 0; s <= totalSeconds; s++) {
    const x = TRACK_HEADER_WIDTH + s * PX_PER_SECOND + 0.5
    const isMajor = s % 5 === 0
    const tickH = isMajor ? 12 : 6
    ticks.moveTo(x, RULER_HEIGHT - tickH).lineTo(x, RULER_HEIGHT - 1)
  }
  ticks.stroke({ color: RULER_TICK, width: 1, alpha: 0.8 })
  rulerLayer.addChild(ticks)

  // Header column background sits in the ruler row too.
  const headerCorner = new GraphicsCtor()
  headerCorner.rect(0, 0, TRACK_HEADER_WIDTH, RULER_HEIGHT).fill(TRACK_HEADER_BG)
  rulerLayer.addChild(headerCorner)

  // Silence "unused" lint for label-colour constant we'll wire to BitmapText later.
  void RULER_LABEL_HINT
}

function drawTracks(width: number): void {
  if (!tracksLayer || !headersLayer || !GraphicsCtor) return

  const tracks = project.tracks
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]
    const y = RULER_HEIGHT + i * (TRACK_HEIGHT + TRACK_GAP)

    // Row background (spans full width, behind both header and clips).
    const rowBg = new GraphicsCtor()
    rowBg.rect(0, y, width, TRACK_HEIGHT).fill(TRACK_BG)
    tracksLayer.addChild(rowBg)

    // Track header.
    const header = new GraphicsCtor()
    header.rect(0, y, TRACK_HEADER_WIDTH, TRACK_HEIGHT).fill(TRACK_HEADER_BG)
    header
      .moveTo(TRACK_HEADER_WIDTH - 0.5, y)
      .lineTo(TRACK_HEADER_WIDTH - 0.5, y + TRACK_HEIGHT)
      .stroke({ color: RULER_TICK, width: 1, alpha: 0.6 })
    headersLayer.addChild(header)

    // Clips for this track.
    for (const clipId of track.clipIds) {
      const clip = project.clips[clipId]
      if (!clip) continue
      drawClip(clip, y)
    }
  }
}

function drawClip(clip: Clip, rowY: number): void {
  if (!tracksLayer || !GraphicsCtor) return

  const x = TRACK_HEADER_WIDTH + (clip.startMs / 1000) * PX_PER_SECOND
  const w = (clip.durationMs / 1000) * PX_PER_SECOND
  const padding = 4
  const innerY = rowY + padding
  const innerH = TRACK_HEIGHT - padding * 2
  const midY = innerY + innerH / 2

  // Clip block + border.
  const block = new GraphicsCtor()
  block.roundRect(x, innerY, w, innerH, 4).fill({ color: CLIP_FILL, alpha: 0.85 }).stroke({ color: CLIP_BORDER, width: 1, alpha: 0.9 })
  tracksLayer.addChild(block)

  // Waveform.
  const wave = new GraphicsCtor()
  // peaks array has 2 entries (min, max) per peak; PEAKS_PER_SECOND peaks per second.
  const peaks = clip.peaks
  const peakCount = peaks.length / 2
  const samplesPerPixel = Math.max(1, peakCount / w)
  const half = innerH / 2 - 2

  for (let px = 0; px < w; px++) {
    const startIdx = Math.floor(px * samplesPerPixel)
    const endIdx = Math.min(peakCount, Math.floor((px + 1) * samplesPerPixel))
    if (startIdx >= peakCount) break

    let min = 0
    let max = 0
    for (let i = startIdx; i < endIdx; i++) {
      const lo = peaks[i * 2]
      const hi = peaks[i * 2 + 1]
      if (lo < min) min = lo
      if (hi > max) max = hi
    }

    // Skip silent columns (single-pixel-wide minimum to keep continuity).
    const yTop = midY + max * -half
    const yBot = midY + min * -half
    wave.moveTo(x + px + 0.5, yTop).lineTo(x + px + 0.5, yBot < yTop + 1 ? yTop + 1 : yBot)
  }
  wave.stroke({ color: WAVE, width: 1, alpha: 0.95 })
  tracksLayer.addChild(wave)

  // Silence "unused" lint warning for the imported constant.
  void PEAKS_PER_SECOND
}
</script>

<template>
  <div class="relative h-full w-full overflow-hidden">
    <div
      ref="host"
      class="absolute inset-0"
    />

    <!-- HTML overlay for track names; PixiJS BitmapText would work too,
         but using DOM keeps font rendering crisp and accessible. -->
    <div
      class="pointer-events-none absolute left-0 top-0 select-none"
      :style="{ width: '140px' }"
    >
      <div
        v-for="(track, i) in project.tracks"
        :key="track.id"
        class="absolute flex flex-col justify-center px-3 text-xs text-zinc-200"
        :style="{
          top: 28 + i * (96 + 4) + 'px',
          height: '96px',
          width: '140px'
        }"
      >
        <div class="truncate font-medium">
          {{ track.name }}
        </div>
        <div class="truncate text-zinc-500">
          {{ track.id }}
        </div>
      </div>
    </div>

    <!-- Empty state hint. -->
    <div
      v-if="project.tracks.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-zinc-600"
    >
      Add a track via File &rsaquo; Add Track from File... (Ctrl+T)
    </div>
  </div>
</template>
