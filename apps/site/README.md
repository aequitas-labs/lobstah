# The marketing page

One static page: "Nobody stares at the water." It is a plain HTML document
with its stylesheet and script inlined, plus the art it uses. It is not part
of any release and nothing here deploys it.

## See it

```bash
pnpm site:dev        # build, serve on http://127.0.0.1:4950, rebuild on change
pnpm site:build      # build once into apps/site/dist
```

`node scripts/build-site.mjs --wharf` includes the wharf section. It is held
out of the page until the wharf ships.

To look at both versions at once, give the second one its own folder and port:

```bash
node scripts/build-site.mjs --serve --wharf --port 4951 --out /tmp/lobstah-site-wharf
```

## How it is put together

| File          | Holds                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------- |
| `index.html`  | the page: the story (one pinned scene and its five captions), the cards under it, the lobster strip |
| `site.css`    | the page's own styles; the scene, read off one dial (`--p`), then the loops                         |
| `src/main.ts` | tells the scene which beat is on screen, pauses loops, the copy buttons, "still water"              |
| `assets/`     | the art layers, cut from the three drawings in `art/originals`                                      |
| `art/cut.py`  | the cutter that made `assets/` (a maintainer tool; the build never runs it)                         |

`scripts/build-site.mjs` reads the design tokens and the card, badge, button
and lobster rules from `apps/cli/glass/glass.css`, so the page wears the
glass's theme and cannot drift from it. The lobsters are the glass's own
sprite and star from `docs/assets`.

## The story

The story is one scene, pinned behind the copy: one sky and one sea from
sunrise to the haul, with the same wave lines drifting throughout. A single
number, `--p`, says how far through it we are:

| `--p` | Beat                                                                            |
| ----- | ------------------------------------------------------------------------------- |
| 0     | sunrise over calm water; the headline and the install command                   |
| 1     | the boat has crossed and dropped three traps, each under its own buoy           |
| 2     | the sun has set                                                                 |
| 3     | the camera is close on one buoy: it bobs, then its flag goes up with a question |
| 4     | the camera is back; every trap has a lobster in it                              |

Every moving thing takes its place from `--p`, so the scene is the same
picture however `--p` is driven:

- by the scroll itself (`animation-timeline: view()`), where the browser can;
- by a short transition from beat to beat, where it cannot;
- by a plain cut from beat to beat, when the visitor has asked for reduced
  motion or pressed "still water". The scene is then a few still frames.

Loops (the bob, the drifting wave lines, the lobsters' walk) run only under
`:root.motion`, and pause when they are off screen or the tab is hidden. Only
`transform`, `scale` and `opacity` change. There is no animation runtime.

The sunrise glow, the dusk, the stars and the sun are CSS gradients and a
circle; the water is one SVG wave path. The lobster in each hauled trap and the
lobsters in the strip at the foot of the page are the glass's sprite, each with
its star.

## The art

`art/originals` holds the three source drawings, untouched. To cut them again:

```bash
python3 apps/site/art/cut.py --sheet /tmp/sheet.png   # needs Pillow, numpy and cwebp
```

Each layer of a group shares one canvas, so the page stacks the boat's layers
(bunting, crane, hook, body) with no offsets. Every layer has a cream edge so
its brown outline reads on the dark page.

## Limits the tests hold

`apps/site/test/site.test.ts` builds the page and checks that its first load
stays under 300 KB, that it fetches nothing from another origin and no
animation runtime, that the wharf section is out unless asked for, that the
install call is in the hero and the star call only at the bottom, that the
lobster strip is at the foot of the page and not fixed to the screen, and that
every lobster keeps its star.
