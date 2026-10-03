"""Cut a trap illustration out of its paper background and ground shadow.

    python3 scripts/trap-art/cutout.py [in.webp] [out.png]

Defaults: docs/assets/traps/source.webp -> docs/assets/traps/base.png.
Works on any flat light background (the cream source paper, or the plain
white Gemini is asked for). Needs numpy and pillow.
"""
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from lab import rgb2lab

ROOT = Path(__file__).resolve().parents[2]
src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs/assets/traps/source.webp'
out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / 'docs/assets/traps/base.png'

src = np.asarray(Image.open(src_path).convert('RGB')).astype(float) / 255
h, w = src.shape[:2]
lab = rgb2lab(src)
light, chroma = lab[..., 0], np.hypot(lab[..., 1], lab[..., 2])
border = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
paper = np.median(border, 0)

# Paper and ground shadow: light and nearly neutral. Flood it in from the border.
paperish = (light > 82) & (chroma < 22)
gone = np.zeros((h, w), bool)
q = deque()
for y, x in [(y, x) for x in range(w) for y in (0, h - 1)] + [(y, x) for y in range(h) for x in (0, w - 1)]:
    if paperish[y, x] and not gone[y, x]:
        gone[y, x] = True
        q.append((y, x))
while q:
    y, x = q.popleft()
    for ny, nx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
        if 0 <= ny < h and 0 <= nx < w and paperish[ny, nx] and not gone[ny, nx]:
            gone[ny, nx] = True
            q.append((ny, nx))
# Paper seen through the netting is enclosed, so the flood misses it.
gone |= np.sqrt(((lab - paper) ** 2).sum(-1)) < 8

# Soften a 2px edge band: unblend each pixel from the paper colour around it.
mask = Image.fromarray((gone * 255).astype(np.uint8))
band = (np.asarray(mask.filter(ImageFilter.MaxFilter(5))) > 0) & ~gone
def blur(a, r=4):
    p = np.pad(a, r, mode='edge').cumsum(0).cumsum(1)
    p = np.pad(p, ((1, 0), (1, 0)))
    k = 2 * r + 1
    return (p[k:, k:] - p[:-k, k:] - p[k:, :-k] + p[:-k, :-k]) / (k * k)
weight = blur(gone.astype(float))
local = np.dstack([blur(src[..., c] * gone) for c in range(3)]) / np.maximum(weight, 1e-6)[..., None]
alpha = np.where(gone, 0.0, 1.0)
edge = np.clip(((local - src) / np.maximum(local, 1e-3)).max(-1) / 0.55, 0, 1)
alpha[band] = edge[band]
rgb = src.copy()
m = band & (alpha > 0.02)
rgb[m] = np.clip((src[m] - local[m] * (1 - alpha[m, None])) / alpha[m, None], 0, 1)

ys, xs = np.where(alpha > 0.05)
pad = 8
box = (max(xs.min() - pad, 0), max(ys.min() - pad, 0), min(xs.max() + pad + 1, w), min(ys.max() + pad + 1, h))
Image.fromarray((np.dstack([rgb, alpha]) * 255).astype(np.uint8), 'RGBA').crop(box).save(out_path)
print(f'{out_path.relative_to(ROOT) if out_path.is_relative_to(ROOT) else out_path}: {box[2] - box[0]}x{box[3] - box[1]}')
