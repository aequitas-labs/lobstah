"""Recolour the cut-out trap with each first-word palette.

    python3 scripts/trap-art/recolor.py [word ...] [--out DIR] [--sheet]

Reads docs/assets/traps/base.png and docs/assets/traps/palettes.json and
writes DIR/<word>.png (default build/trap-art/). With no words it renders
every palette; --sheet also writes DIR/_sheet.png, a labelled contact sheet.

Each material (outline, wood, rope and net, buoy) is a set of anchor colours
sampled from the original art. A palette moves a material's base anchor to
its colour and moves the others with it, keeping their lightness offsets;
every pixel then shifts by a smooth blend of its nearby anchors' moves, so
shading, grain and anti-aliased edges survive. Needs numpy and pillow.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from lab import hex2lab, lab2rgb, rgb2lab

ROOT = Path(__file__).resolve().parents[2]
TRAPS = ROOT / 'docs/assets/traps'

# Anchor colours in Lab; the index is the material's base anchor.
GROUPS = {
    'outline': ([[30.5, 29.0, 29.3]], 0),
    'wood': ([[44.1, 28.7, 30.9], [53.9, 22.4, 32.2], [64.2, 20.7, 39.6], [70.5, 21.7, 32.7]], 2),
    'rope': ([[61.5, 13.3, 29.5], [67.3, 6.0, 19.4], [71.2, 11.4, 30.6], [87.9, 1.4, 15.3]], 2),
    'buoy': ([[43.5, 35.0, 32.8], [49.9, 37.0, 32.9], [60.0, 32.0, 30.0]], 1),
}
# The buoy's red sits close to the dark wood, so buoy anchors only apply here (base.png pixels).
BUOY_BOX = (548, 405, 680, 510)
SIGMA = 7.0


def load_base():
    base = np.asarray(Image.open(TRAPS / 'base.png').convert('RGBA')).astype(float) / 255
    return rgb2lab(base[..., :3]), base[..., 3]


def moves(palette):
    """(group, anchor, target) for every anchor under this palette."""
    out = []
    for group, (anchors, base_index) in GROUPS.items():
        anchors = np.array(anchors)
        targets = anchors.copy()
        if group in palette:
            base, colour = anchors[base_index], hex2lab(palette[group])
            contrast = palette.get('contrast', 1.0)
            targets[:, 0] = colour[0] + (anchors[:, 0] - base[0]) * contrast
            chroma_ratio = np.hypot(anchors[:, 1], anchors[:, 2]) / max(np.hypot(*base[1:]), 1e-3)
            targets[:, 1:] = colour[None, 1:] * chroma_ratio[:, None]
        out += [(group, a, t) for a, t in zip(anchors, targets)]
    return out


def recolor(lab, alpha, palette):
    h, w = alpha.shape
    ys, xs = np.mgrid[0:h, 0:w]
    x0, y0, x1, y1 = BUOY_BOX
    in_buoy = (xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)
    total = np.zeros((h, w))
    shift = np.zeros((h, w, 3))
    for group, anchor, target in moves(palette):
        d = lab - anchor
        d[..., 0] *= 0.5  # material is told apart by hue and chroma more than lightness
        weight = np.exp(-(d ** 2).sum(-1) / (2 * SIGMA ** 2))
        if group == 'buoy':
            weight = np.where(in_buoy, weight, 0)
        total += weight
        shift += weight[..., None] * (target - anchor)
    rgb = lab2rgb(lab + shift / np.maximum(total, 1e-12)[..., None])
    return Image.fromarray((np.dstack([rgb, alpha]) * 255).astype(np.uint8), 'RGBA')


def sheet(images, path, cols=8, tw=230, th=200):
    rows = (len(images) + cols - 1) // cols
    out = Image.new('RGB', (cols * tw, rows * th), (250, 246, 236))
    draw = ImageDraw.Draw(out)
    for i, (word, im) in enumerate(images):
        thumb = im.copy()
        thumb.thumbnail((tw - 20, th - 36))
        x, y = (i % cols) * tw + 10, (i // cols) * th + 6
        out.paste(thumb, (x, y), thumb)
        draw.text((x + 4, y + th - 30), word, fill=(60, 40, 30))
    out.save(path)


def main(argv):
    out_dir = ROOT / 'build/trap-art'
    words, want_sheet = [], False
    it = iter(argv)
    for arg in it:
        if arg == '--out':
            out_dir = Path(next(it))
        elif arg == '--sheet':
            want_sheet = True
        else:
            words.append(arg)
    palettes = json.loads((TRAPS / 'palettes.json').read_text())
    unknown = [w for w in words if w not in palettes]
    if unknown:
        sys.exit(f'no palette for: {", ".join(unknown)}')
    out_dir.mkdir(parents=True, exist_ok=True)
    lab, alpha = load_base()
    images = []
    for word in words or list(palettes):
        im = recolor(lab, alpha, palettes[word])
        im.save(out_dir / f'{word}.png')
        images.append((word, im))
    if want_sheet:
        sheet(images, out_dir / '_sheet.png')
    print(f'{len(images)} trap(s) -> {out_dir}')


if __name__ == '__main__':
    main(sys.argv[1:])
