// Clip header strip: truncated name label plus link/lock/pitch/reverse/brake/
// backspin/warp status badges.

import { type ShallowRef } from 'vue'
import type { Container, Graphics, Text } from 'pixi.js'
import { isClipTempoWarpActive, type Clip, type TrackPaletteEntry } from '@/stores/projectStore'
import { libraryItemDisplayName, libraryItemShowsLinkBadge, type LibraryItem } from '@/stores/libraryStore'
import { useTransportStore } from '@/stores/transportStore'
import { isWarpPending } from '@/lib/warp'

type PooledGraphics = InstanceType<NonNullable<typeof Graphics>>

export interface ClipHeaderRendererDeps {
  tracksLayer: ShallowRef<Container | null>
  GraphicsCtor: ShallowRef<typeof Graphics | null>
  TextCtor: ShallowRef<typeof Text | null>
  transport: ReturnType<typeof useTransportStore>
  /** Hand back a cleared, pooled Graphics shared with the clip renderer. */
  acquireGraphics: (G: NonNullable<typeof Graphics>) => PooledGraphics
}

export function createClipHeaderRenderer(deps: ClipHeaderRendererDeps) {
  const { tracksLayer, GraphicsCtor, TextCtor, transport, acquireGraphics } = deps

  function drawClipHeader(
    clip: Clip,
    clipX: number,
    clipInnerY: number,
    clipW: number,
    palette: TrackPaletteEntry,
    libItem: LibraryItem | undefined,
    headerSourceBpm: number | undefined
  ): void {
    const tracksL = tracksLayer.value
    const G = GraphicsCtor.value
    const T = TextCtor.value
    if (!tracksL || !G || !T) return

    const HEADER_H = 18
    const PAD_X = 4
    const FONT_SIZE = 11
    const APPROX_CHAR_W = 6
    const LINK_BADGE_FULL_W = 18
    const LOCK_BADGE_FULL_W = 14
    const WARP_BADGE_FULL_W = 40
    const BRAKE_BADGE_FULL_W = 44
    const SPIN_BADGE_FULL_W = 38
    const REV_BADGE_FULL_W = 30
    const STATUS_BADGE_H = 14
    const STATUS_BADGE_R = 5
    const BADGE_GAP = 4
    const NAME_BADGE_GAP = 6
    const PITCH_BADGE_FULL_W = 18

    if (clipW < 20) return

    // Reuse per-clip library/source-BPM resolution from `drawClip`.
    // Saved clips and sample assets (music or simple) are reusable library
    // entries a placed clip stays linked to — show the link badge for both.
    const isLinked = libraryItemShowsLinkBadge(libItem)
    const isLocked = clip.locked === true
    const warpIsPending = isWarpPending({
      warpEnabled: clip.warpEnabled,
      tempoRatio: clip.tempoRatio,
      pendingAutoWarp: clip.pendingAutoWarp,
      sourceBpm: headerSourceBpm,
      projectBpm: transport.bpm
    })
    const warpIsActive = !warpIsPending && isClipTempoWarpActive(clip)

    // Prefer custom name, then library display name, then filename.
    const displayName = clip.name?.trim()
      ? clip.name
      : libItem ? libraryItemDisplayName(libItem) : clip.fileName

    // Measure text after reserving badge space; proportional glyphs vary widely.
    const LINK_BADGE_W = isLinked ? LINK_BADGE_FULL_W : 0
    const LOCK_BADGE_W = isLocked ? LOCK_BADGE_FULL_W : 0
    const WARP_BADGE_W = warpIsPending || warpIsActive ? WARP_BADGE_FULL_W : 0
    const pitchShifted = (clip.semitones ?? 0) !== 0 || (clip.cents ?? 0) !== 0
    const PITCH_BADGE_W = pitchShifted ? PITCH_BADGE_FULL_W : 0
    const hasBrake = clip.brake === true
    const BRAKE_BADGE_W = hasBrake ? BRAKE_BADGE_FULL_W : 0
    const hasBackspin = clip.backspin === true
    const SPIN_BADGE_W = hasBackspin ? SPIN_BADGE_FULL_W : 0
    const hasReversed = clip.reversed === true
    const REV_BADGE_W = hasReversed ? REV_BADGE_FULL_W : 0
    const BADGE_COUNT =
      (isLinked ? 1 : 0) +
      (isLocked ? 1 : 0) +
      (pitchShifted ? 1 : 0) +
      (hasBrake ? 1 : 0) +
      (hasBackspin ? 1 : 0) +
      (hasReversed ? 1 : 0) +
      (warpIsPending || warpIsActive ? 1 : 0)
    const BADGES_W =
      BADGE_COUNT === 0
        ? 0
        : NAME_BADGE_GAP +
          LINK_BADGE_W +
          LOCK_BADGE_W +
          PITCH_BADGE_W +
          BRAKE_BADGE_W +
          SPIN_BADGE_W +
          REV_BADGE_W +
          WARP_BADGE_W +
          Math.max(0, BADGE_COUNT - 1) * BADGE_GAP
    const maxTextW = Math.max(0, clipW - PAD_X * 2 - BADGES_W)
    const label = new T({
      text: displayName,
      style: {
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: FONT_SIZE,
        fontWeight: '600',
        fill: 0xffffff,
        stroke: { color: 0x09090b, width: 2 }
      }
    })
    if (label.width > maxTextW) {
      if (maxTextW <= APPROX_CHAR_W) {
        label.text = ''
      } else {
        let lo = 0
        let hi = displayName.length
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          label.text = displayName.slice(0, mid) + '…'
          if (label.width <= maxTextW) lo = mid
          else hi = mid - 1
        }
        label.text = lo > 0 ? displayName.slice(0, lo) + '…' : ''
      }
    }

    const labelW = label.text.length > 0 ? label.width : 0
    const desiredW = Math.min(clipW, Math.ceil(labelW) + PAD_X * 2 + BADGES_W)
    const headerBg = acquireGraphics(G)
    headerBg
      .rect(clipX, clipInnerY, desiredW, HEADER_H)
      .fill({ color: palette.border, alpha: 0.95 })
    tracksL.addChild(headerBg)

    label.x = Math.round(clipX + PAD_X)
    label.y = Math.round(clipInnerY + (HEADER_H - FONT_SIZE) / 2 - 1)
    if (label.text.length > 0) tracksL.addChild(label)

    let badgeRight = clipX + desiredW - PAD_X
    if (isLinked) {
      const badge = acquireGraphics(G)
      const cx = badgeRight - LINK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      badge
        .roundRect(
          cx - LINK_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          LINK_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x09090b, alpha: 0.85 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      badge
        .circle(cx - 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
        .circle(cx + 2.5, cy, 2.3)
        .stroke({ color: 0xffffff, width: 1.5 })
      tracksL.addChild(badge)
      badgeRight -= LINK_BADGE_FULL_W + BADGE_GAP
    }
    if (isLocked) {
      // Compact padlock glyph sized to match other badges.
      const cx = badgeRight - LOCK_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const bg = acquireGraphics(G)
      bg
        .roundRect(
          cx - LOCK_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          LOCK_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x18181b, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const glyph = acquireGraphics(G)
      const bodyW = 6
      const bodyH = 5
      const bodyX = cx - bodyW / 2
      const bodyY = cy - 1
      glyph.roundRect(bodyX, bodyY, bodyW, bodyH, 1).fill({ color: 0xffffff })
      tracksL.addChild(glyph)
      // Separate shackle path avoids Pixi stroking from the previous origin.
      const shackle = acquireGraphics(G)
      const shackleR = 2.2
      const shackleCy = bodyY
      shackle.moveTo(cx - shackleR, shackleCy)
      shackle
        .arc(cx, shackleCy, shackleR, Math.PI, 0)
        .stroke({ color: 0xffffff, width: 1.2 })
      tracksL.addChild(shackle)
      badgeRight -= LOCK_BADGE_FULL_W + BADGE_GAP
    }
    if (pitchShifted) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - PITCH_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - PITCH_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          PITCH_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x18181b, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: '♪',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 11,
          fontWeight: '700',
          fill: 0xffffff
        }
      })
      badge.x = Math.round(cx - 4)
      badge.y = Math.round(cy - 8)
      tracksL.addChild(badge)
      badgeRight -= PITCH_BADGE_FULL_W + BADGE_GAP
    }
    if (hasReversed) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - REV_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - REV_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          REV_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x134e4a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'REV',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0x5eead4
        }
      })
      badge.x = Math.round(cx - 9)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
      badgeRight -= REV_BADGE_FULL_W + BADGE_GAP
    }
    if (hasBrake) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - BRAKE_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - BRAKE_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          BRAKE_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x3f1d1d, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'BRAKE',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0xfca5a5
        }
      })
      badge.x = Math.round(cx - 15)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
      badgeRight -= BRAKE_BADGE_FULL_W + BADGE_GAP
    }
    if (hasBackspin) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - SPIN_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - SPIN_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          SPIN_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x2e1065, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'SPIN',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0xc4b5fd
        }
      })
      badge.x = Math.round(cx - 11)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
      badgeRight -= SPIN_BADGE_FULL_W + BADGE_GAP
    }
    if (warpIsPending) {
      const badge = acquireGraphics(G)
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      const phase = Math.floor(Date.now() / 125) % 8
      const radius = 4.2
      badge
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      for (let i = 0; i < 8; i++) {
        const angle = ((i - phase) / 8) * Math.PI * 2
        const alpha = 0.25 + ((i + 1) / 8) * 0.65
        badge
          .circle(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, 1.1)
          .fill({ color: 0xffffff, alpha })
      }
      tracksL.addChild(badge)
    } else if (warpIsActive) {
      const bg = acquireGraphics(G)
      const cx = badgeRight - WARP_BADGE_FULL_W / 2
      const cy = clipInnerY + HEADER_H / 2
      bg
        .roundRect(
          cx - WARP_BADGE_FULL_W / 2,
          cy - STATUS_BADGE_H / 2,
          WARP_BADGE_FULL_W,
          STATUS_BADGE_H,
          STATUS_BADGE_R
        )
        .fill({ color: 0x0f172a, alpha: 0.95 })
        .stroke({ color: 0xffffff, width: 1, alpha: 0.95 })
      tracksL.addChild(bg)
      const badge = new T({
        text: 'WARP',
        style: {
          fontFamily: 'system-ui, -apple-system, sans-serif',
          fontSize: 9,
          fontWeight: '700',
          fill: 0xfacc15
        }
      })
      badge.x = Math.round(cx - 14)
      badge.y = Math.round(cy - 7)
      tracksL.addChild(badge)
    }
  }

  return { drawClipHeader }
}
