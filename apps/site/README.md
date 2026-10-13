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

| File          | Holds                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `index.html`  | the page: the five scenes, the sections under them, the lobster strip       |
| `site.css`    | the page's own styles; the scenes as still pictures first, motion after     |
| `src/main.ts` | starts and stops motion, the copy buttons, the "still water" switch         |
| `assets/`     | the art layers, cut from the three drawings in `art/originals`              |
| `art/cut.py`  | the cutter that made `assets/` (a maintainer tool; the build never runs it) |

`scripts/build-site.mjs` reads the design tokens and the card, badge, button
and lobster rules from `apps/cli/glass/glass.css`, so the page wears the
glass's theme and cannot drift from it. The lobster in the strip is the
glass's own sprite and star from `docs/assets`.

## Motion

The base styles draw every scene as a finished still picture. Motion is added
only under `:root.motion`, which the page sets when the visitor has not asked
for reduced motion and has not pressed "still water". So the still page is
also the page without JavaScript.

- Scenes 2, 3 and 5 follow the scroll (`animation-timeline: view()`). Where a
  browser lacks that, each plays once at a fixed length when it comes into view.
- The hero's buoy dips once, after three seconds in view.
- Loops (the bob, the drifting wave lines, the lobsters) pause when their
  scene is off screen and when the tab is hidden.
- Only `transform` and `opacity` are animated. There is no animation runtime.

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
install call is in the hero and the star call only at the bottom, and that
every lobster keeps its star.
