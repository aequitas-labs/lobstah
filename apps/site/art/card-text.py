#!/usr/bin/env python3
"""Draw the words on the social card as two masks, in the glass's own type.

The glass sets its text in `ui-monospace, SFMono-Regular, Menlo, monospace`:
whatever monospace the reader's system has. A build cannot do that the same
way on every machine, so the words are drawn once, here, on a Mac, and kept
as masks: grey images where white is ink. The build tints them with the
glass's colours and sets them beside the lobster (scripts/build-site.mjs).

    python3 apps/site/art/card-text.py

Needs Pillow, and macOS for the fonts. Run it only when the words or their
size change; the build and CI read the masks and never run this.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "card"

# The glass's stack, in order, as files on a Mac: ui-monospace is SF Mono there.
FONTS = [("/System/Library/Fonts/SFNSMono.ttf", "Bold"), ("/System/Library/Fonts/Menlo.ttc", None)]

# name: (lines, size in pixels, space between lines as a share of the size)
WORDS = {
    "tagline": (["Nobody stares", "at the water."], 68, 1.2),
    "name": (["lobstah"], 34, 1.2),
}


def font(size):
    for path, weight in FONTS:
        if Path(path).exists():
            face = ImageFont.truetype(path, size)
            if weight:
                face.set_variation_by_name(weight)
            return face
    raise SystemExit("none of the glass's fonts is on this machine: run this on a Mac")


def mask(lines, size, leading):
    face = font(size)
    step = round(size * leading)
    width = max(round(face.getlength(line)) for line in lines) + size
    sheet = Image.new("L", (width, step * len(lines) + size), 0)
    draw = ImageDraw.Draw(sheet)
    for i, line in enumerate(lines):
        draw.text((size // 2, size // 2 + i * step), line, fill=255, font=face)
    return sheet.crop(sheet.getbbox())


for name, (lines, size, leading) in WORDS.items():
    image = mask(lines, size, leading)
    image.save(OUT / f"{name}.png", optimize=True)
    print(f"{name}.png {image.width}x{image.height}")
