#!/usr/bin/env python3
"""Cut the three source illustrations into the page's art layers.

    python3 apps/site/art/cut.py            write apps/site/assets/*.webp
    python3 apps/site/art/cut.py --sheet f  also write a contact sheet PNG to f

Needs Pillow, numpy and the `cwebp` binary. It is a maintainer tool: the build
and CI read the committed files in apps/site/assets and never run this.

Each source is a flat drawing on an off-white ground with closed outlines. A
fill from the image edges finds the ground; ground-coloured gaps the fill
cannot reach (net holes, the sky between the rigging) are cleared by colour.
Every layer gets a cream edge so its brown outline reads on the dark page.
Layers of one group share a canvas, so the page stacks them with no offsets.
"""
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'originals')
OUT = os.path.normpath(os.path.join(HERE, '..', 'assets'))
CREAM = (243, 234, 214)
MARK = (255, 0, 255)
EDGE = 5  # cream edge, in source pixels


def load(name):
    return Image.open(os.path.join(SRC, name)).convert('RGB')


def flood(im, seeds, thresh):
    """True where a fill from the seeds reaches."""
    m = im.copy()
    for pt in seeds:
        if m.getpixel(pt) != MARK:
            ImageDraw.floodfill(m, pt, MARK, thresh=thresh)
    a = np.array(m)
    return (a[:, :, 0] == 255) & (a[:, :, 1] == 0) & (a[:, :, 2] == 255)


def component(mask, seed):
    """The connected part of mask that holds seed (x, y)."""
    v = (mask * 255).astype('uint8')
    L = Image.fromarray(np.dstack([v, v, v]))
    x, y = seed
    if not mask[y, x]:
        ys, xs = np.nonzero(mask)
        i = int(((ys - y) ** 2 + (xs - x) ** 2).argmin())
        x, y = int(xs[i]), int(ys[i])
    ImageDraw.floodfill(L, (x, y), MARK)
    a = np.array(L)
    return (a[:, :, 0] == 255) & (a[:, :, 1] == 0)


def centre(mask):
    ys, xs = np.nonzero(mask)
    return int(xs.mean()), int(ys.mean())


def edges(w, h):
    return [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]


def near(im, colour, dist):
    a = np.array(im).astype(int)
    return np.abs(a - np.array(colour)).sum(axis=2) < dist


def poly(size, points):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).polygon(points, fill=255)
    return np.array(m) > 0


def disc(size, c, r):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=255)
    return np.array(m) > 0


def layer(im, mask, edge=EDGE):
    """The masked drawing over a cream edge, full canvas, RGBA."""
    alpha = Image.fromarray((mask * 255).astype('uint8')).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.7))
    art = im.copy()
    art.putalpha(alpha)
    rim = alpha.filter(ImageFilter.MaxFilter(2 * edge + 1)).filter(ImageFilter.GaussianBlur(0.8))
    under = Image.new('RGBA', im.size, CREAM + (0,))
    under.putalpha(rim)
    return Image.alpha_composite(under, art)


def bbox(layers, pad=2):
    box = None
    for img in layers:
        b = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    w, h = layers[0].size
    return (max(0, box[0] - pad), max(0, box[1] - pad), min(w, box[2] + pad), min(h, box[3] + pad))


def export(group, layers, widths, quality=80):
    """Crop every layer of a group to the group's box and write each width."""
    box = bbox(list(layers.values()))
    report = {}
    for name, img in layers.items():
        img = img.crop(box)
        for w in widths:
            h = round(img.height * w / img.width)
            tmp = os.path.join(OUT, f'.{name}-{w}.png')
            img.resize((w, h), Image.LANCZOS).save(tmp)
            out = os.path.join(OUT, f'{name}-{w}.webp')
            subprocess.run(['cwebp', '-quiet', '-q', str(quality), '-alpha_q', '90', '-m', '6', tmp, '-o', out], check=True)
            os.remove(tmp)
            report[f'{name}-{w}.webp'] = (w, h, os.path.getsize(out))
    return box, report, {n: i.crop(box) for n, i in layers.items()}


def cut_buoy():
    im = load('lobstah-asset-buoy.png')
    w, h = im.size
    whole = ~flood(im, edges(w, h), 22)
    whole = component(whole, centre(whole))
    # The flag hangs right of the pole (x >= 524) and above the body (y < 405).
    flag = whole.copy()
    flag[:, :524] = False
    flag[405:, :] = False
    flag = component(flag, centre(flag))
    body = whole & ~flag
    body = component(body, centre(body))
    return {'buoy-body': layer(im, body), 'buoy-flag': layer(im, flag)}


def cut_trap():
    im = load('lobstah-asset-trap.webp')
    w, h = im.size
    ground = im.getpixel((6, 6))
    solid = ~flood(im, edges(w, h), 22) & ~near(im, ground, 22)
    return {'trap': layer(im, component(solid, centre(solid)), edge=4)}


def cut_boat():
    im = load('lobstah-asset-boat.webp')
    w, h = im.size
    size = (w, h)
    ground = im.getpixel((6, 6))
    bg = flood(im, edges(w, h), 22)
    shadow = flood(im, [(512, 870), (840, 820), (200, 880), (700, 860), (350, 880)], 20)
    # Ground-coloured gaps inside the rigging. The cabin wall and the life ring
    # are close to the ground colour too, so only look above and left of them.
    gaps = near(im, ground, 16)
    gaps[430:, 520:] = False
    gaps[560:, :] = False
    whole = ~(bg | shadow | gaps)
    whole = component(whole, centre(whole))

    # The crane: its pulley and the boom down to where it goes behind the crate.
    pulley = disc(size, (272, 335), 25)
    boom = poly(size, [(254, 353), (290, 317), (518, 542), (482, 578)])
    crane = whole & (pulley | boom)
    crane = component(crane, (385, 448))
    # The short rope and its hook hang free under the pulley.
    hang = whole & ~crane
    hang[:, :240] = False
    hang[:, 296:] = False
    hang[:352, :] = False
    hang[535:, :] = False
    hook = component(hang, (268, 500))
    # The two strings of bunting, each side of the mast. Cut them free of the
    # pulley and the mast, then keep the part that holds a pennant.
    rest = whole & ~crane & ~hook
    left = rest.copy()
    left[:, :296] = False
    left[:, 520:] = False
    left[:228, :] = False
    left[400:, :] = False
    left = component(left, (446, 331))
    right = rest.copy()
    right &= ~disc(size, (549, 238), 24)
    right[:, :552] = False
    right[:225, :] = False
    right[418:, :] = False
    right = component(right, (608, 344))
    body = whole & ~crane & ~hook & ~left & ~right
    body = component(body, centre(body))
    return {
        'boat-body': layer(im, body),
        'boat-crane': layer(im, crane),
        'boat-hook': layer(im, hook),
        'boat-bunting-left': layer(im, left),
        'boat-bunting-right': layer(im, right),
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    groups = [('buoy', cut_buoy(), [160, 320]), ('boat', cut_boat(), [420, 760]), ('trap', cut_trap(), [180, 320])]
    cropped = {}
    total = 0
    for group, layers, widths in groups:
        box, report, crops = export(group, layers, widths)
        cropped.update(crops)
        print(f'{group}: source box {box}, canvas {box[2] - box[0]} x {box[3] - box[1]}')
        for name, (w, h, size) in report.items():
            total += size
            print(f'  {name:28s} {w:4d} x {h:<4d} {size / 1024:6.1f} KB')
    print(f'total {total / 1024:.1f} KB')
    if '--sheet' in sys.argv:
        path = sys.argv[sys.argv.index('--sheet') + 1]
        sheet = Image.new('RGB', (1800, 1400), (14, 17, 22))
        x, y, row = 20, 20, 0
        for name, img in cropped.items():
            s = min(420 / img.height, 1.0)
            r = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
            if x + r.width > 1780:
                x, y, row = 20, y + row + 20, 0
            sheet.paste(r, (x, y), r)
            x += r.width + 20
            row = max(row, r.height)
        sheet.crop((0, 0, 1800, y + row + 20)).save(path)

if __name__ == '__main__':
    main()
