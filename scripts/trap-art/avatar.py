"""Build trap avatars: the flag buoy in the first word's bands, flying the
last word's item laid flat on its flag.

    python3 scripts/trap-art/avatar.py <first-last> ... [--props DIR] [--out DIR] [--sheet]

Reads docs/assets/traps/buoy.png (the cut-out flag buoy), bands.json and
props/<last>.png (or --props DIR/<last>.png), and writes DIR/<first-last>.png (default
build/trap-art/avatars/). --sheet also writes DIR/_sheet.png. The item is
bent to follow the flag's wave and takes on its folds. Needs numpy and
pillow.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

import buoy as paint
from lab import hex2lab, rgb2lab

ROOT = Path(__file__).resolve().parents[2]
TRAPS = ROOT / 'docs/assets/traps'
ITEM_HEIGHT = 0.7  # of the flag's height
ITEM_WIDTH = 0.66  # most of the flag's width the item may take


def find_flag(im):
    """The flag cloth: the largest light, unsaturated region of the image."""
    arr = np.asarray(im.convert('RGBA')).astype(float) / 255
    lab = rgb2lab(arr[..., :3])
    cloth = (arr[..., 3] > 0.5) & (lab[..., 0] > 70) & (np.hypot(lab[..., 1], lab[..., 2]) < 25)
    regions = [r for r in paint.blobs(cloth) if r.sum() > 500]
    if not regions:
        sys.exit('no flag found in buoy.png')
    flag = max(regions, key=lambda r: r.sum())
    return flag


def fly(base, item, flag):
    """Lay the item flat on the middle of the flag."""
    ys, xs = np.nonzero(flag)
    x0, x1 = xs.min(), xs.max() + 1
    top = np.array([ys[xs == x].min() for x in range(x0, x1)], float)
    bottom = np.array([ys[xs == x].max() for x in range(x0, x1)], float)
    height = np.median(bottom - top)

    item = item.crop(item.getbbox())
    scale = min((x1 - x0) * ITEM_WIDTH / item.width, height * ITEM_HEIGHT / item.height)
    item = item.resize((max(1, round(item.width * scale)), max(1, round(item.height * scale))), Image.LANCZOS)
    left = x0 + ((x1 - x0) - item.width) // 2
    span = slice(left - x0, left - x0 + item.width)
    middle = np.median((top[span] + bottom[span]) / 2)
    out = base.convert('RGBA').copy()
    out.alpha_composite(item.convert('RGBA'), (int(left), int(round(middle - item.height / 2))))
    return out


def sheet(images, path, cols=8, tw=180, th=230):
    rows = (len(images) + cols - 1) // cols
    out = Image.new('RGB', (cols * tw, rows * th), (250, 246, 236))
    draw = ImageDraw.Draw(out)
    for i, (name, im) in enumerate(images):
        thumb = im.copy()
        thumb.thumbnail((tw - 20, th - 40), Image.LANCZOS)
        x, y = (i % cols) * tw + (tw - thumb.width) // 2, (i // cols) * th + 6
        out.paste(thumb, (x, y), thumb)
        draw.text(((i % cols) * tw + 10, (i // cols) * th + th - 28), name, fill=(60, 40, 30))
    out.save(path)


def main(argv):
    out_dir = ROOT / 'build/trap-art/avatars'
    props = TRAPS / 'props'
    names, want_sheet = [], False
    it = iter(argv)
    for arg in it:
        if arg == '--props':
            props = Path(next(it))
        elif arg == '--out':
            out_dir = Path(next(it))
        elif arg == '--sheet':
            want_sheet = True
        else:
            names.append(arg)
    if not names:
        sys.exit(__doc__)
    spec = json.loads((TRAPS / 'bands.json').read_text())
    colours = {k: hex2lab(v) for k, v in spec['colours'].items()}
    base = Image.open(TRAPS / 'buoy.png')
    buoy = paint.Buoy(base)
    flag = find_flag(base)
    out_dir.mkdir(parents=True, exist_ok=True)
    images = []
    for name in names:
        first, _, last = name.partition('-')
        if first not in spec['bands']:
            sys.exit(f'no bands for "{first}"')
        prop = props / f'{last}.png'
        if not prop.exists():
            sys.exit(f'missing {prop}')
        im = fly(buoy.paint(paint.parse(spec['bands'][first]), colours), Image.open(prop), flag)
        im.save(out_dir / f'{name}.png')
        images.append((name, im))
    if want_sheet:
        sheet(images, out_dir / '_sheet.png')
    print(f'{len(images)} avatar(s) -> {out_dir}')


if __name__ == '__main__':
    main(sys.argv[1:])
