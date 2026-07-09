#!/usr/bin/env python3
"""Regenerate every WebBrain logo derivative from assets/logo-github.png.

The canonical artwork has generous padding that works well for social cards.
Toolbar and favicon sizes use a tighter square crop so the brain remains
recognizable at 16–128 px. Requires Pillow.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
CANONICAL = ROOT / "assets" / "logo-github.png"
ASSETS = ROOT / "assets"
WEB = ROOT / "web"


def full_logo(source: Image.Image, size: int) -> Image.Image:
    return source.resize((size, size), Image.Resampling.LANCZOS)


def tight_logo(source: Image.Image, size: int) -> Image.Image:
    # Proportional form of the reviewed 900×900 crop at (177, 177) in the
    # 1254×1254 canonical file. Keep this centralized so every small icon uses
    # precisely the same framing.
    width, height = source.size
    side = round(min(width, height) * (900 / 1254))
    left = round((width - side) * (177 / (1254 - 900)))
    top = round((height - side) * (177 / (1254 - 900)))
    cropped = source.crop((left, top, left + side, top + side))
    return cropped.resize((size, size), Image.Resampling.LANCZOS)


def wide_social_logo(source: Image.Image, width: int, height: int) -> Image.Image:
    """Center the full logo on a row-matched background for seamless sides."""
    square = full_logo(source, height).convert("RGB")
    canvas = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        left = square.getpixel((0, y))
        right = square.getpixel((height - 1, y))
        color = tuple((left[i] + right[i]) // 2 for i in range(3))
        draw.line((0, y, width, y), fill=color)
    canvas.paste(square, ((width - height) // 2, 0))
    return canvas


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)


def main() -> None:
    source = Image.open(CANONICAL).convert("RGB")
    if source.size != (1254, 1254):
        raise SystemExit(f"Unexpected canonical logo size: {source.size}; expected 1254×1254")

    save_png(full_logo(source, 512), ASSETS / "logo-github-512.png")
    full_logo(source, 512).save(
        ASSETS / "logo-github-512.jpg",
        format="JPEG",
        quality=94,
        optimize=True,
        progressive=True,
    )

    for size in (64, 128):
        save_png(tight_logo(source, size), ASSETS / f"store-icon-{size}.png")

    for browser in ("chrome", "firefox"):
        icon_dir = ROOT / "src" / browser / "icons"
        for size in (16, 48, 128):
            save_png(tight_logo(source, size), icon_dir / f"icon{size}.png")

    shutil.copyfile(CANONICAL, WEB / "logo-github.png")
    save_png(tight_logo(source, 64), WEB / "favicon.png")
    save_png(full_logo(source, 512), WEB / "twitter-image.png")
    save_png(wide_social_logo(source, 1200, 630), WEB / "og-image.png")

    print("Synchronized WebBrain logo assets from assets/logo-github.png")


if __name__ == "__main__":
    main()
