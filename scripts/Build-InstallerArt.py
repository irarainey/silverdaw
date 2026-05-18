"""Generate NSIS installer banners and the .silverdaw file-type icon.

Outputs (relative to repo root):
  frontend/resources/installerHeader.bmp     150x57   logo on black
  frontend/resources/installerSidebar.bmp    164x314  logo on black
  frontend/resources/uninstallerSidebar.bmp  164x314  logo on black
  frontend/resources/icons/silverdaw-file.ico  multi-resolution

Run from any working directory:
  python scripts/Build-InstallerArt.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parents[1]
RES_DIR = REPO_ROOT / "frontend" / "resources"
ICON_DIR = RES_DIR / "icons"
SOURCE_LOGO = ICON_DIR / "256x256.png"


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
    return img


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
    jackdaw logo centred in the lower portion. Returns an RGBA image of the
    requested square size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Document outline: occupies most of the canvas with a small margin so the
    # folded corner has room to breathe.
    margin = max(1, size // 20)
    fold = max(2, size // 4)
    left, top = margin, margin
    right, bottom = size - margin - 1, size - margin - 1

    # Polygon for the page with a folded top-right corner.
    page = [
        (left, top),
        (right - fold, top),
        (right, top + fold),
        (right, bottom),
        (left, bottom),
    ]
    # Light grey border, white fill.
    border = (180, 184, 190, 255)
    draw.polygon(page, fill=(255, 255, 255, 255), outline=border)

    # The triangular fold itself, drawn with a slight shadow so it reads as
    # a real piece of paper rather than a printed corner.
    fold_tri = [
        (right - fold, top),
        (right - fold, top + fold),
        (right, top + fold),
    ]
    draw.polygon(fold_tri, fill=(232, 235, 240, 255), outline=border)

    # Logo: scale to fit the lower ~62% of the page width, centred.
    logo_target_w = int((right - left) * 0.78)
    logo_target_h = int(logo.height * (logo_target_w / logo.width))
    resized = logo.resize((logo_target_w, logo_target_h), Image.LANCZOS)
    lx = (size - logo_target_w) // 2
    # Bias the logo downward so it sits below the folded corner instead of
    # colliding with it.
    ly = top + fold // 2 + int((bottom - top - fold // 2 - logo_target_h) * 0.55)
    img.paste(resized, (lx, ly), resized)
    return img


def main() -> None:
    if not SOURCE_LOGO.exists():
        raise SystemExit(f"missing source logo: {SOURCE_LOGO}")
    logo = _load_logo_rgba()

    black = (0, 0, 0)

    header = _make_banner((150, 57), black, logo, logo_height_ratio=0.85)
    header.save(RES_DIR / "installerHeader.bmp", "BMP")

    sidebar = _make_banner((164, 314), black, logo, logo_height_ratio=0.55)
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
        RES_DIR / "installerHeader.bmp",
        RES_DIR / "installerSidebar.bmp",
        RES_DIR / "uninstallerSidebar.bmp",
        ICON_DIR / "silverdaw-file.ico",
    ]:
        print(f"  {p.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
