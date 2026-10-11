"""Paint a trap's buoy with the bands for each first word.

    python3 scripts/trap-art/buoy.py [word ...] [--out DIR] [--sheet]

Reads docs/assets/traps/base.png and docs/assets/traps/bands.json and
writes DIR/<word>.png (default build/trap-art/). With no words it paints
every word; --sheet also writes DIR/_sheet.png with a close-up of each buoy.

The buoy is found by its red paint, so a redrawn base still works as long as
its buoy stays red. Bands run across the buoy's long axis from the rope end
to the dowel end; each band keeps the original's shading and outline.
Needs numpy and pillow.
"""
import json
import re
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from lab import hex2lab, lab2rgb, rgb2lab

ROOT = Path(__file__).resolve().parents[2]
TRAPS = ROOT / 'docs/assets/traps'

# The buoy's red paint in the original art (Lab).
BUOY_RED = [[43.5, 35.0, 32.8], [49.9, 37.0, 32.9], [60.0, 32.0, 30.0]]
SHADE = 0.9  # how much of the original's light and shade each band keeps
SEAM = 0.8  # lightness kept on the thin seam between two bands
WRAP = 0.0006  # bends the bands so they follow the round body


def blobs(mask):
    """Connected regions of a mask, as boolean arrays."""
    seen = np.zeros_like(mask)
    h, w = mask.shape
    out = []
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        blob = np.zeros_like(mask)
        q = deque([(y, x)])
        seen[y, x] = blob[y, x] = True
        while q:
            cy, cx = q.popleft()
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = blob[ny, nx] = True
                    q.append((ny, nx))
        out.append(blob)
    return out


def morph(mask, f):
    return np.asarray(Image.fromarray((mask * 255).astype(np.uint8)).filter(f)) > 0


class Buoy:
    def __init__(self, base):
        arr = np.asarray(base.convert('RGBA')).astype(float) / 255
        self.lab, self.alpha = rgb2lab(arr[..., :3]), arr[..., 3]
        lab = self.lab
        dist = np.min([np.sqrt(((lab[..., 1:] - b[1:]) ** 2).sum(-1) + (0.3 * (lab[..., 0] - b[0])) ** 2)
                       for b in np.array(BUOY_RED)], 0)
        weight = np.clip((18 - dist) / 8, 0, 1) * (self.alpha > 0.5)
        red = weight > 0.5
        # An opening drops thin red-brown lines (outlines, the dowel); the buoy is the reddest blob left.
        red &= morph(morph(red, ImageFilter.MinFilter(9)), ImageFilter.MaxFilter(11))
        candidates = [b for b in blobs(red) if b.sum() > 200]
        if not candidates:
            sys.exit('no red buoy found in base.png')
        self.body = max(candidates, key=lambda b: lab[..., 1][b].mean())
        self.weight = weight * morph(self.body, ImageFilter.MaxFilter(3))
        self.ref_light = np.median(lab[..., 0][self.body])

        h, w = self.alpha.shape
        ys, xs = np.nonzero(self.body)
        pts = np.stack([xs, ys], 1).astype(float)
        centre = pts.mean(0)
        axis = np.linalg.svd(pts - centre, full_matrices=False)[2][0]
        # The rope ties on at the end nearer the trap; bands are numbered from there.
        rope_end = pts[np.argmin((pts - centre) @ axis)]
        if rope_end[0] > centre[0]:
            axis = -axis
        grid = np.stack(np.meshgrid(np.arange(w), np.arange(h)), -1) - centre
        along, across = grid @ axis, grid @ np.array([-axis[1], axis[0]])
        lo, hi = np.percentile(along[self.body], [1, 99])
        self.t = np.clip((along - lo) / (hi - lo) + WRAP * across ** 2 / (hi - lo), 0, 1)
        self.box = (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)

    def paint(self, bands, colours):
        weights = np.array([wt for _, wt in bands])
        edges = np.concatenate([[0], np.cumsum(weights / weights.sum())])
        index = np.clip(np.searchsorted(edges, self.t, side='right') - 1, 0, len(bands) - 1)
        new = self.lab.copy()
        light = new[..., 0]
        for i, (name, _) in enumerate(bands):
            m = self.body & (index == i)
            colour = colours[name]
            light[m] = np.clip(colour[0] + (self.lab[..., 0][m] - self.ref_light) * SHADE, 0, 100)
            new[..., 1][m], new[..., 2][m] = colour[1], colour[2]
        for e in edges[1:-1]:
            light[self.body & (np.abs(self.t - e) < 0.012)] *= SEAM
        w = self.weight[..., None]
        rgb = lab2rgb(self.lab * (1 - w) + new * w)
        return Image.fromarray((np.dstack([rgb, self.alpha]) * 255).astype(np.uint8), 'RGBA')


def parse(bands):
    """["B2", "W.6", "B2"] -> [("B", 2.0), ("W", 0.6), ("B", 2.0)]; a bare colour weighs 1."""
    out = []
    for token in bands:
        m = re.fullmatch(r'([A-Z][a-z]?)([\d.]*)', token)
        if not m:
            sys.exit(f'bad band "{token}"')
        out.append((m.group(1), float(m.group(2) or 1)))
    return out


def sheet(images, box, path, cols=8, tw=230, th=250):
    rows = (len(images) + cols - 1) // cols
    out = Image.new('RGB', (cols * tw, rows * th), (250, 246, 236))
    draw = ImageDraw.Draw(out)
    x0, y0, x1, y1 = box
    pad = 12
    for i, (word, im) in enumerate(images):
        x, y = (i % cols) * tw + 10, (i // cols) * th + 6
        thumb = im.copy()
        thumb.thumbnail((tw - 20, 130))
        out.paste(thumb, (x, y), thumb)
        close = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
        close.thumbnail((tw - 60, 80))
        out.paste(close, (x + 20, y + 136), close)
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
    spec = json.loads((TRAPS / 'bands.json').read_text())
    colours = {k: hex2lab(v) for k, v in spec['colours'].items()}
    table = spec['bands']
    unknown = [w for w in words if w not in table]
    if unknown:
        sys.exit(f'no bands for: {", ".join(unknown)}')
    for word, bands in table.items():
        missing = [name for name, _ in parse(bands) if name not in colours]
        if missing:
            sys.exit(f'{word}: unknown colour {", ".join(missing)}')
    buoy = Buoy(Image.open(TRAPS / 'base.png'))
    out_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for word in words or list(table):
        im = buoy.paint(parse(table[word]), colours)
        im.save(out_dir / f'{word}.png')
        images.append((word, im))
    if want_sheet:
        sheet(images, buoy.box, out_dir / '_sheet.png')
    print(f'{len(images)} trap(s) -> {out_dir}')


if __name__ == '__main__':
    main(sys.argv[1:])
