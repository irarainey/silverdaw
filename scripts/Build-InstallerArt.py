"""Generate MSIX/AppX tile logos, the .silverdaw file-type icon, and the
(legacy) NSIS installer banners.

Outputs (relative to repo root):
  frontend/resources/appx/StoreLogo.png          50x50    logo on white
  frontend/resources/appx/Square44x44Logo.png    44x44    logo on white
  frontend/resources/appx/Square150x150Logo.png  150x150  logo on white
  frontend/resources/appx/Wide310x150Logo.png    310x150  logo on white
  frontend/resources/icons/silverdaw-file.ico     multi-resolution
  frontend/resources/installerHeader.bmp     150x57   logo on white
  frontend/resources/installerSidebar.bmp    164x314  logo on black→grey gradient
  frontend/resources/uninstallerSidebar.bmp  164x314  logo on black→grey gradient

The AppX tiles bake an opaque white plate (see APPX_TILE_BG) so the logo looks
identical on the App Installer surface, Start tiles and the taskbar rather than
picking up the system accent colour. Keep it in sync with
`appx.backgroundColor` in electron-builder.yml.

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

# Solid backdrop baked into the AppX tile logos. The App Installer surface and
# the taskbar composite a *transparent* logo over the system accent colour
# (blue by default) / the taskbar colour, so a transparent tile shows an
# unwanted blue plate and the dark bird can vanish on a dark taskbar. Baking an
# opaque plate makes the icon look identical everywhere. The silvery jackdaw is
# designed to read on light, so we use white. Keep this in sync with
# `appx.backgroundColor` in electron-builder.yml.
APPX_TILE_BG = (255, 255, 255)


def _load_logo_rgba() -> Image.Image:
    img = Image.open(SOURCE_LOGO).convert("RGBA")
    # Knock out the near-white backdrop the source PNG ships with so the
    # logo composites cleanly over arbitrary backgrounds. Anything with all
    # three channels >= 240 is treated as background.
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r >= 240 and g >= 240 and b >= 240:
                px[x, y] = (r, g, b, 0)
    # Crop to the actual visible content so callers can centre the bird,
    # not the (much larger) PNG canvas with its transparent padding.
    bbox = img.getbbox()
    if bbox is not None:
        img = img.crop(bbox)
    return img


def _make_gradient_banner(size: tuple[int, int],
                          top: tuple[int, int, int],
                          bottom: tuple[int, int, int],
                          logo: Image.Image,
                          logo_height_ratio: float) -> Image.Image:
    """Vertical gradient `top` → `bottom`, with the logo centred on top."""
    w, h = size
    canvas = Image.new("RGB", (w, h))
    px = canvas.load()
    for y in range(h):
        t = y / max(1, h - 1)
        r = round(top[0] + (bottom[0] - top[0]) * t)
        g = round(top[1] + (bottom[1] - top[1]) * t)
        b = round(top[2] + (bottom[2] - top[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    logo_h = int(h * logo_height_ratio)
    logo_w = int(logo.width * (logo_h / logo.height))
    resized = logo.resize((logo_w, logo_h), Image.LANCZOS)
    x = (w - logo_w) // 2
    y = (h - logo_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def _make_tile(size: tuple[int, int], logo: Image.Image,
               logo_ratio: float,
               bg: tuple[int, int, int] | None = APPX_TILE_BG) -> Image.Image:
    """Centre the logo on a canvas of `size`.

    `bg` is the opaque plate colour, or `None` for a fully transparent canvas
    (used for the taskbar `altform-unplated` assets). `logo_ratio` sizes the
    logo against the tile's shorter edge, leaving a margin so it never touches
    the edge."""
    w, h = size
    fill = (*bg, 255) if bg is not None else (0, 0, 0, 0)
    canvas = Image.new("RGBA", (w, h), fill)
    logo_h = int(min(w, h) * logo_ratio)
    logo_w = int(logo.width * (logo_h / logo.height))
    resized = logo.resize((logo_w, logo_h), Image.LANCZOS)
    x = (w - logo_w) // 2
    y = (h - logo_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def _make_appx_assets(logo: Image.Image) -> list[Path]:
    """Write the MSIX/AppX logo assets electron-builder requires, each with a
    full set of DPI scale variants.

    Windows resolves `<Name>.png` (referenced in the manifest) to the closest
    `<Name>.scale-<pct>.png` for the display DPI/size. If only one small size
    exists, the App Installer / shell render it at native size inside a larger
    container and pad the surround with the system accent colour (a blue box).
    Emitting scale-100→400 at the correct pixel sizes keeps the icon crisp and
    edge-to-edge everywhere. The bare `<Name>.png` is kept as the scale-100
    fallback that the manifest points at."""
    APPX_DIR.mkdir(parents=True, exist_ok=True)
    scales = [100, 125, 150, 200, 400]
    # base size at scale-100, and the logo size ratio against the tile's
    # shorter edge (leaving a consistent margin around the bird).
    tiles = {
        "StoreLogo": ((50, 50), 0.72),
        "Square44x44Logo": ((44, 44), 0.72),
        "Square150x150Logo": ((150, 150), 0.62),
        "Wide310x150Logo": ((310, 150), 0.62),
    }
    written: list[Path] = []
    for name, ((bw, bh), ratio) in tiles.items():
        # Bare name = scale-100 fallback referenced by the manifest.
        base = _make_tile((bw, bh), logo, ratio)
        bare = APPX_DIR / f"{name}.png"
        base.save(bare, "PNG")
        written.append(bare)
        for scale in scales:
            size = (round(bw * scale / 100), round(bh * scale / 100))
            out = APPX_DIR / f"{name}.scale-{scale}.png"
            _make_tile(size, logo, ratio).save(out, "PNG")
            written.append(out)

    # Taskbar, Alt-Tab and the title bar use the Square44x44Logo "target-size"
    # assets. The `altform-unplated` variants are drawn directly on the taskbar
    # with NO plate, so they MUST be transparent — otherwise the icon shows as
    # a white box on the taskbar. We ship transparent target-size assets (both
    # the plain and unplated forms); Windows plates the plain ones with
    # `backgroundColor` where a tile plate is expected and uses the unplated
    # ones on the taskbar. This mirrors the transparent look of the dev
    # (icon.ico) window icon.
    for ts in [16, 24, 32, 48, 256]:
        transparent = _make_tile((ts, ts), logo, 0.9, bg=None)
        for suffix in ("", "_altform-unplated"):
            out = APPX_DIR / f"Square44x44Logo.targetsize-{ts}{suffix}.png"
            transparent.save(out, "PNG")
            written.append(out)
    return written


def _make_banner(size: tuple[int, int], bg: tuple[int, int, int],
                 logo: Image.Image, logo_height_ratio: float = 0.78) -> Image.Image:
    w, h = size
    canvas = Image.new("RGB", (w, h), bg)
    logo_h = int(h * logo_height_ratio)
    logo_w = int(logo.width * (logo_h / logo.height))
    resized = logo.resize((logo_w, logo_h), Image.LANCZOS)
    # Centre vertically; horizontally inset from the left edge for the
    # sidebar banner so it doesn't feel cramped against the page text.
    if w == h or w < h:
        # Sidebar: centre horizontally.
        x = (w - logo_w) // 2
    else:
        # Header: tuck against the right edge (NSIS draws the title on the
        # left). Pad ~12 px in from the right.
        x = w - logo_w - 12
    y = (h - logo_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def _make_file_icon(logo: Image.Image, size: int) -> Image.Image:
    """Render a white document shape with a folded top-right corner and the
    jackdaw logo centred in the lower portion. The page is drawn as a
    portrait rectangle (taller than wide, like Windows' own .docx / .txt
    icons) centred inside a transparent square canvas of the requested
    size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Page geometry: portrait aspect ratio ~5:7 to match the shell's
    # built-in document icons (notepad, docx, etc., which are noticeably
    # taller than wide). Centre the rectangle inside the square canvas.
    page_w = int(size * 0.66)
    page_h = int(size * 0.92)
    left = (size - page_w) // 2
    top = (size - page_h) // 2
    right = left + page_w - 1
    bottom = top + page_h - 1

    # Folded corner: ~22% of the page width keeps the fold readable at
    # 16 px while staying subtle at 256 px.
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

    # Logo: scale to ~55% of the page width and centre it on the page.
    # The fold is small enough relative to the page that true geometric
    # centring still leaves the logo clear of it.
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

    white = (255, 255, 255)

    # MSIX/AppX tile logos (transparent; tile colour comes from the manifest).
    appx_assets = _make_appx_assets(logo)

    # Header banner (top of every wizard page) sits next to a white title
    # bar in MUI2 — a black background would clash visually, so we keep
    # the header on white. The sidebar is a standalone full-height panel
    # on the Welcome / Finish pages, where a black backdrop reads as a
    # branded splash rather than a clash.
    header = _make_banner((150, 57), white, logo, logo_height_ratio=0.62)
    header.save(RES_DIR / "installerHeader.bmp", "BMP")

    # Sidebar uses a vertical gradient from black at the top down to a
    # mid-grey at the bottom so the panel feels softer next to the white
    # wizard area. Logo sits centred on the gradient.
    sidebar_top = (0, 0, 0)
    sidebar_bottom = (96, 96, 96)
    sidebar = _make_gradient_banner(
        (164, 314), sidebar_top, sidebar_bottom, logo, logo_height_ratio=0.36
    )
    sidebar.save(RES_DIR / "installerSidebar.bmp", "BMP")
    sidebar.save(RES_DIR / "uninstallerSidebar.bmp", "BMP")

    # File-type icon: pack the standard Windows shell sizes so File Explorer
    # picks the right one for each view (16 = list, 32 = small icons, 48 =
    # medium, 256 = extra-large preview).
    file_sizes = [16, 24, 32, 48, 64, 128, 256]
    layers = [_make_file_icon(logo, s) for s in file_sizes]
    # Pillow's `save(... format='ICO', sizes=[...])` requires a single image
    # large enough to contain every requested size; it then downsamples for
    # the smaller slots. We've already rendered crisp per-size images, so
    # we hand them in via the `append_images` parameter for best quality.
    primary = layers[-1]
    primary.save(
        ICON_DIR / "silverdaw-file.ico",
        format="ICO",
        sizes=[(s, s) for s in file_sizes],
        append_images=layers[:-1],
    )

    print("wrote:")
    for p in [
        *appx_assets,
        RES_DIR / "installerHeader.bmp",
        RES_DIR / "installerSidebar.bmp",
        RES_DIR / "uninstallerSidebar.bmp",
        ICON_DIR / "silverdaw-file.ico",
    ]:
        print(f"  {p.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
