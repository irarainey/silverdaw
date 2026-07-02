"""Generate the MSIX/AppX logo assets and the .silverdaw file-type icon.

Outputs (relative to repo root), all under frontend/resources/:
  appx/StoreLogo.png            50x50    tile logo on white (+ scale-100..400)
  appx/Square44x44Logo.png      44x44    tile logo on white (+ scale-100..400)
  appx/Square150x150Logo.png    150x150  tile logo on white (+ scale-100..400)
  appx/Wide310x150Logo.png      310x150  tile logo on white (+ scale-100..400)
  appx/Square44x44Logo.targetsize-<N>[.altform].png   taskbar/list/App-Installer
  icons/silverdaw-file.ico      multi-resolution document icon for .silverdaw

Tiles bake an opaque white plate (APPX_TILE_BG) matching `appx.backgroundColor`
in electron-builder.yml, so Start tiles look consistent.

The `target-size` assets drive the taskbar, Alt-Tab, the Start app list and —
crucially — the Windows App Installer dialog. Windows *plates* a plain
target-size icon with the system accent colour (the "blue border") unless it
finds an `altform-unplated` variant at the requested size, so we ship the full
set including size 44 (the size the App Installer asks for) in the plain,
`altform-unplated` and `altform-lightunplated` forms. All use the full-detail
original logo (recolouring washes out detail at icon sizes); the unplated
naming is what suppresses the accent plate.

Run from any working directory:
  python scripts/Build-InstallerArt.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[1]
RES_DIR = REPO_ROOT / "frontend" / "resources"
ICON_DIR = RES_DIR / "icons"
APPX_DIR = RES_DIR / "appx"
SOURCE_LOGO = ICON_DIR / "256x256.png"

# Opaque plate baked into the square/wide tile logos. Keep in sync with
# `appx.backgroundColor` in electron-builder.yml. The jackdaw reads on light,
# and this matches the Windows 11 light App Installer dialog surface (#F3F3F3)
# so the tile plate blends into the dialog rather than showing as a square.
APPX_TILE_BG = (243, 243, 243)

# Target-size icon sizes. 44 matters most: the App Installer dialog asks for
# `targetsize-44[_altform-unplated]` first and plates with the accent colour if
# it's missing.
TARGET_SIZES = [16, 24, 32, 44, 48, 256]


def _load_logo_rgba() -> Image.Image:
    img = Image.open(SOURCE_LOGO).convert("RGBA")
    # The source ships a clean, anti-aliased transparent alpha channel, so crop
    # to the visible content by alpha and leave the edges untouched. (Do NOT
    # threshold-knock-out "near-white" pixels: that erases the jackdaw's light
    # highlights and hardens the anti-aliased edge, which reads as rough rims
    # once the logo is composited onto an opaque plate.)
    bbox = img.getchannel("A").getbbox()
    if bbox is not None:
        img = img.crop(bbox)
    return img


def _make_tile(size: tuple[int, int], logo: Image.Image,
               logo_ratio: float,
               bg: tuple[int, int, int] | None = APPX_TILE_BG) -> Image.Image:
    """Centre the logo on a canvas of `size`.

    `bg` is the opaque plate colour, or `None` for a transparent canvas (used
    for the unplated target-size assets). `logo_ratio` sizes the logo against
    the shorter edge, leaving a margin so it never touches the edge."""
    w, h = size
    logo_h = max(1, int(min(w, h) * logo_ratio))
    logo_w = max(1, int(logo.width * (logo_h / logo.height)))
    if bg is not None:
        # Matte the logo onto the plate colour at the logo's native resolution
        # first — a per-pixel composite that uses the source's clean alpha with
        # no interpolation — then downscale the resulting opaque image. Resizing
        # an opaque image avoids the dark edge fringing that straight (non-
        # premultiplied) RGBA resizing produces, which showed as rough edges
        # against the coloured plate.
        matte = Image.new("RGBA", logo.size, (*bg, 255))
        matte.alpha_composite(logo)
        resized = matte.convert("RGB").resize((logo_w, logo_h), Image.LANCZOS)
        canvas = Image.new("RGB", (w, h), bg)
        canvas.paste(resized, ((w - logo_w) // 2, (h - logo_h) // 2))
        return canvas.convert("RGBA")
    resized = logo.resize((logo_w, logo_h), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.paste(resized, ((w - logo_w) // 2, (h - logo_h) // 2), resized)
    return canvas


def _make_appx_assets(logo: Image.Image) -> list[Path]:
    """Write the MSIX/AppX tile logos (with DPI scale variants) and the themed
    target-size assets."""
    APPX_DIR.mkdir(parents=True, exist_ok=True)
    scales = [100, 125, 150, 200, 400]
    tiles = {
        "StoreLogo": ((256, 256), 0.72),
        "Square44x44Logo": ((44, 44), 0.72),
        "Square150x150Logo": ((150, 150), 0.62),
        "Wide310x150Logo": ((310, 150), 0.62),
    }
    written: list[Path] = []
    for name, ((bw, bh), ratio) in tiles.items():
        # StoreLogo is a large opaque white tile: the App Installer scales it to
        # fit its icon slot, so a full-bleed opaque plate fills the slot cleanly
        # instead of leaving the system accent colour showing as a border.
        _make_tile((bw * 4, bh * 4), logo, ratio, bg=APPX_TILE_BG).save(APPX_DIR / f"{name}.png", "PNG")
        written.append(APPX_DIR / f"{name}.png")
        for scale in scales:
            size = (round(bw * scale / 100), round(bh * scale / 100))
            out = APPX_DIR / f"{name}.scale-{scale}.png"
            _make_tile(size, logo, ratio, bg=APPX_TILE_BG).save(out, "PNG")
            written.append(out)

    # Transparent target-size assets. The `altform-unplated` /
    # `altform-lightunplated` variants tell Windows NOT to plate the icon (this
    # is what removes the accent-colour "border" on the taskbar and in the App
    # Installer). We use the full-detail original logo for every form — the
    # source jackdaw already reads on both light and dark surfaces, and any
    # recolouring washes out its detail at icon sizes.
    for ts in TARGET_SIZES:
        for suffix in ("", "_altform-lightunplated", "_altform-unplated"):
            out = APPX_DIR / f"Square44x44Logo.targetsize-{ts}{suffix}.png"
            _make_tile((ts, ts), logo, 0.9, bg=None).save(out, "PNG")
            written.append(out)
    return written


def _make_file_icon(logo: Image.Image, size: int) -> Image.Image:
    """Render a white document shape with a folded top-right corner and the
    jackdaw logo centred in the lower portion, on a transparent square canvas."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    page_w = int(size * 0.66)
    page_h = int(size * 0.92)
    left = (size - page_w) // 2
    top = (size - page_h) // 2
    right = left + page_w - 1
    bottom = top + page_h - 1
    fold = max(2, int(page_w * 0.22))

    page = [
        (left, top),
        (right - fold, top),
        (right, top + fold),
        (right, bottom),
        (left, bottom),
    ]
    border = (180, 184, 190, 255)
    draw.polygon(page, fill=(255, 255, 255, 255), outline=border)

    fold_tri = [
        (right - fold, top),
        (right - fold, top + fold),
        (right, top + fold),
    ]
    draw.polygon(fold_tri, fill=(232, 235, 240, 255), outline=border)

    logo_target_w = int(page_w * 0.55)
    logo_target_h = int(logo.height * (logo_target_w / logo.width))
    resized = logo.resize((logo_target_w, logo_target_h), Image.LANCZOS)
    lx = left + (page_w - logo_target_w) // 2
    ly = top + (page_h - logo_target_h) // 2
    img.paste(resized, (lx, ly), resized)
    return img


def main() -> None:
    if not SOURCE_LOGO.exists():
        raise SystemExit(f"missing source logo: {SOURCE_LOGO}")
    logo = _load_logo_rgba()

    appx_assets = _make_appx_assets(logo)

    # File-type icon: pack the standard Windows shell sizes so File Explorer
    # picks the right one for each view.
    file_sizes = [16, 24, 32, 48, 64, 128, 256]
    layers = [_make_file_icon(logo, s) for s in file_sizes]
    layers[-1].save(
        ICON_DIR / "silverdaw-file.ico",
        format="ICO",
        sizes=[(s, s) for s in file_sizes],
        append_images=layers[:-1],
    )

    print("wrote:")
    for p in [*appx_assets, ICON_DIR / "silverdaw-file.ico"]:
        print(f"  {p.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
