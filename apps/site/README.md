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

The build needs to know the site's address to write addresses that only make
sense on the site. Pass it when building for the real site:

```bash
node scripts/build-site.mjs --site-url https://lobstah.dev
```

With it, the page gets its canonical link and the address and image of its
social card, `sitemap.xml` is written, and `llms.txt` links to the setup guide
by its full address. Without it, all of those are left out and the links stay
relative, so a local build never carries a wrong address.

To look at both versions at once, give the second one its own folder and port:

```bash
node scripts/build-site.mjs --serve --wharf --port 4951 --out /tmp/lobstah-site-wharf
```

## How it is put together

| File           | Holds                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `index.html`   | the page: the story (one pinned scene and its five captions), the cards under it, the lobster strip |
| `handoff.html` | the "Set it up in one paste" control, included in the hero and at the end                           |
| `site.css`     | the page's own styles; the scene, read off one dial (`--p`), then the loops                         |
| `src/main.ts`  | tells the scene which beat is on screen, pauses loops, the copy buttons, "still water"              |
| `icons/`       | the product marks, inlined by the build; `icons/SOURCES.md` says where each came from               |
| `assets/`      | the art layers, cut from the three drawings in `art/originals`                                      |
| `art/cut.py`   | the cutter that made `assets/` (a maintainer tool; the build never runs it)                         |

`scripts/build-site.mjs` reads the design tokens and the card, badge, button
and lobster rules from `apps/cli/glass/glass.css`, so the page wears the
glass's theme and cannot drift from it. The lobsters are the glass's own
sprite and star from `docs/assets`.
| `llms.txt` | the page for agents, in the llms.txt shape: what lobstah is and where its guides are; `{{site}}` stands before each address on this site |
| `setup.md` | the setup guide an agent follows after a person pastes it the install sentence: steps, exact commands, what to leave to the person |
| `wrangler.jsonc` | where the built site goes on Cloudflare: `lobstah.dev`, with `www.lobstah.dev` sent to it |
| `worker.js` | the Worker in front of the files; its one job is that redirect |

## The story

The story is one scene, pinned behind the copy: one sky and one sea from
sunrise to the haul, with the same wave lines drifting throughout. A single
number, `--p`, says how far through it we are:

| `--p` | Beat                                                                                                                     |
| ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | sunrise over calm water; the headline and the install command                                                            |
| 1     | the boat has crossed and dropped three traps, each under its own buoy                                                    |
| 2     | the sun has set                                                                                                          |
| 3     | the camera is close on one buoy: it works, then its flag goes up with a question, an answer is picked, and the card goes |
| 4     | the camera is back; every buoy has its flag up, each says something different, and every trap has a lobster in it        |

Every moving thing takes its place from `--p`, so the scene is the same
picture however `--p` is driven:

- by the scroll itself (`animation-timeline: view()`), where the browser can;
- by a short transition from beat to beat, where it cannot;
- by a plain cut from beat to beat, when the visitor has asked for reduced
  motion or pressed "still water". The scene is then a few still frames.

Loops (the bob, the drifting wave lines, the lobsters' walk) run only under
`:root.motion`, and pause when they are off screen or the tab is hidden. Only
`transform`, `scale` and `opacity` change. There is no animation runtime.

The captions sit in the sky, fixed, one at a time, so none ever crosses a
buoy. The sunrise glow, the dusk, the stars and the sun are CSS gradients and
a circle; the water's surface is one SVG wave, a fill and one moving line. The
lobster in each hauled trap and the lobsters in the strip at the foot of the
page are the glass's sprite, each with its star. Each lobster in the strip
walks at a pace picked afresh on every visit.

Without JavaScript the scene still plays where the browser ties animation to
the scroll; elsewhere it stays at sunrise.

## The art

`art/originals` holds the three source drawings, untouched. To cut them again:

```bash
python3 apps/site/art/cut.py --sheet /tmp/sheet.png   # needs Pillow, numpy and cwebp
```

Each layer of a group shares one canvas, so the page stacks the boat's layers
(bunting, crane, hook, body) with no offsets. Every layer's edge is pulled in
onto its own brown outline, so nothing pale is left around it and it sits
flush on the dark page and on the water.

## The fleet

The wharf section (built only with `--wharf`) leads with open water seen from
a little above. The view never moves. Three lanes of water lie one behind
another, the far one small and high, the near one large and low. Each has a
row of buoys and one boat that crosses it, all made from the same art layers
as the story. Each lane's water is painted solid in front of what floats on
it, so the foot of a hull or a buoy is under the surface. On each round three
buoys get a note in the story's own colours: one working, one with a catch
and one that needs you, the last two with their flags up. It plays by itself,
on a loop, while it is in view, not from the scroll. With motion off it is one
still frame with all three notes showing.

## What machines read

None of this shows on the page. The build adds it to the page's head and
writes four files beside the page.

- **In the head:** the canonical link, Open Graph and Twitter card tags, and
  structured data (a `SoftwareApplication`, and a `WebSite` once the address
  is known). The title and the description are the page's own and are said
  once. Every statement in the structured data is already on the page or in
  the repo: there are no ratings and no questions and answers.
- **`llms.txt`** and **`setup.md`**, from the files of the same names here.
  The head points to both.
- **`robots.txt`**, which lets everything be crawled, and **`sitemap.xml`**,
  which lists the page, `llms.txt` and the setup guide.
- **The social card image** is `docs/assets/social-preview.png`, copied
  unchanged. The page itself never loads it.

`setup.md` names real commands. When the CLI changes, change the guide: a test
reads every `lobstah` command, flag, skill, package and tool name out of
`setup.md` and `llms.txt` and fails if the code does not have it.

## Deploying

Nothing in this repo deploys the site: no script, no CI job. A maintainer with
access to the `aequitas labs` Cloudflare account runs it by hand.

The site is a Cloudflare Worker that serves the built folder as static files
at `lobstah.dev`. `wrangler.jsonc` holds all of it. A deploy builds the site
first, with `--site-url https://lobstah.dev`, so the address is never typed
twice. The Worker (`worker.js`) answers both names and sends
`www.lobstah.dev` to `lobstah.dev`; Cloudflare makes the DNS records for both
when the Worker is first deployed.

On a machine where wrangler is signed in to more than one Cloudflare account,
name the sign-in to use. Without `XDG_CONFIG_HOME`, wrangler uses its default
sign-in, which may be another account:

```bash
cd apps/site
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" npx wrangler@4 whoami    # check the account first
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" npx wrangler@4 deploy --dry-run   # build and check, upload nothing
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" npx wrangler@4 deploy
```

## Limits the tests hold

`apps/site/test/site.test.ts` builds the page and checks that its first load
stays under 300 KB, that it loads no image, style or animation runtime from
another origin (the script makes one request of its own, to GitHub's API for
the star count), that the wharf section is out unless asked for, that the
install control is in the hero and at the end with a prompt for each harness
and the real commands by hand, that every mark has a source note, that the one star call is at the
bottom with the lobster's star, that the lobster strip is at the foot of the
page and not fixed to the screen, and that every lobster keeps its star.

`apps/site/test/meta.test.ts` checks what machines read: that the words a
visitor reads are the ones in `test/visible-text.txt`, that the guides name
nothing the code lacks, that `llms.txt` keeps its shape, that no address is
written until one is given, that the structured data says only what the
page and the repo say, and that the Worker sends `www` to the bare name and is
set up for the same address the build is given.
