# Trap art

Every trap name is `<first>-<last>` (`packages/core/src/trap-names.ts`).
A trap's avatar is a highflyer, the flagged buoy lobstermen use to mark
their gear. The **first** word paints the buoy in a band pattern, the way
lobstermen paint buoys so others can tell whose trap is whose. The **last**
word is the item on the flag. The trap illustration is the general trap
icon, and the starting point for animation.

| File | What it is |
|---|---|
| `buoy-source.png` | The flag buoy, drawn by Gemini |
| `buoy.png` | The flag buoy cut out of its background |
| `bands.json` | The buoy paints, and the band pattern for each first word |
| `props/<word>.png` | One item per last word (to be made) |
| `source.webp` | The trap illustration |
| `base.png` | The trap cut out of its background and ground shadow |

The scripts in `scripts/trap-art/` need Python 3 with `numpy` and `pillow`.

```bash
python3 scripts/trap-art/buoy.py --sheet                        # every band pattern -> build/trap-art/buoys/
python3 scripts/trap-art/avatar.py coral-crab blue-gull --sheet  # buoy + item -> build/trap-art/avatars/
python3 scripts/trap-art/buoy.py --trap blue                    # paint the buoy beside the trap instead
```

`cutout.py` rebuilds a cut-out after a redraw: with no arguments it
rebuilds the trap (`--net` also clears the paper seen through the
netting), and `cutout.py docs/assets/traps/buoy-source.png
docs/assets/traps/buoy.png` rebuilds the buoy.

## First words: buoy bands

`buoy.py` finds the buoy by its red paint and paints it in the word's
bands, keeping the drawing's shading and outline. In `bands.json`,
`colours` names the paints and `bands` lists each word's bands from the top
of the buoy down. A band is a colour name with an optional width:
`["B", "W", "B"]` is three equal bands, and `["B2", "W.6", "B2"]` is blue
with a thin white stripe. No two words share a pattern.

To redraw the buoy, attach `source.webp` and send:

> Using the attached lobster trap illustration as the style reference, draw
> a single wooden lobster buoy standing upright with a short flagpole, in
> exactly the same style: the same hand-drawn flat illustration,
> reddish-brown outline and soft shading. The body is flat across the top
> and rounded at the bottom, with a wooden spindle running through it; the
> spindle continues up out of the top as a short wooden pole ending in a
> small round cap, and out of the bottom as a short stub. A plain, blank,
> off-white cloth flag hangs from the pole, flying to the right. The body is
> plain red with no stripes. Seen from the front, lit from the upper left.
> Square 1024×1024 canvas, plain pure white background, the whole thing
> centred. No rope, no ground, no shadow, no text.

Keep the body plain red and the flag blank and light: `buoy.py` finds the
buoy by its red, and `avatar.py` finds the flag as the largest light
region.

## Last words: items on the flag

`avatar.py` scales each item to fit the middle of the flag and lays it
flat. Any PNG with a transparent background works; `--props DIR` reads
items from another folder. To cut an item out of a white background, run
`python3 scripts/trap-art/cutout.py <in.png> docs/assets/traps/props/<word>.png`
(without `--net`, so white parts of the item stay).

To have Gemini draw an item, attach `source.webp` and send the prompt below
with `{subject}` replaced from the table.

> Use the attached lobster trap illustration as the style reference. Draw a
> single {subject} as a simple, bold icon in exactly the same style: the
> same hand-drawn flat illustration, warm muted coastal palette, clean
> rounded shapes, a consistent reddish-brown outline (#8A3A1E) about 1% of
> the image width, and simple shading with one highlight tone and one
> shadow tone. Seen from the front or side, with a clear silhouette that
> reads at small size. Animals are friendly and simple, with dot eyes.
> Square 1024×1024 canvas with a plain pure white background, the object
> centred and filling about 80% of the canvas. No ground, no shadow, no
> text, no border and no other objects.

### The 64 items

| Word | Subject |
|---|---|
| anchor | small iron ship's anchor in dark slate grey, standing upright, a loop of tan rope through its ring |
| aspen | young aspen sapling with a slim white trunk marked with dark flecks and round golden-yellow leaves |
| bay | brass spyglass telescope on a small wooden tripod, pointing out to sea |
| beach | red tin sand bucket with a small wooden spade leaning in it |
| boat | small wooden rowboat painted teal with a cream stripe, two oars resting inside |
| brook | glass jar of clear water holding a tiny silver minnow and a pebble |
| buoy | tall red-and-white striped navigation bell buoy with a little bell on top |
| cedar | small conical cedar tree in deep green with a reddish-brown trunk |
| cliff | small chunk of layered sandstone cliff with a tuft of grass on top |
| coast | brass hurricane lantern with a glass chimney and a warm glowing flame |
| cove | small wooden treasure chest with brass bands, lid ajar, a few gold coins inside |
| crab | red-orange shore crab with raised claws |
| creek | green frog sitting on a lily pad with a small white flower |
| dune | mound of pale sand with tufts of tall dune grass |
| egret | white egret standing on one leg, yellow beak |
| ferry | red-and-white life ring with a short coil of rope |
| field | round golden hay bale tied with twine |
| finch | small goldfinch, yellow with black wings, perched on a twig stub |
| foam | cluster of glossy sea-foam bubbles in pale aqua and white |
| grove | small lemon tree in a terracotta pot with three yellow lemons |
| gull | white-and-grey herring gull standing, yellow beak with a red spot |
| harbor | short white lighthouse with a red cap and a glowing lamp |
| heron | grey-blue heron standing tall with its long neck curved |
| inlet | green glass bottle lying on its side, corked, a rolled paper message inside |
| island | tiny sandy island mound with one leaning palm tree |
| isle | rolled parchment treasure map tied with red string, one corner open showing a dotted line and an X |
| jetty | short wooden mooring post with a rope tied around it |
| kelp | tall ribbon of olive-green kelp with round air bladders, standing upright |
| kite | diamond kite in coral and cream with a ribbon tail, propped upright |
| lagoon | small green sea turtle walking |
| lake | carved wooden duck decoy painted in mallard colours |
| lark | brown streaked skylark with a small crest |
| marsh | clump of cattails with brown seed heads |
| meadow | clump of white daisies and a few blue cornflowers |
| otter | brown sea otter sitting up, holding a small clam |
| oyster | open oyster shell with a shiny pearl |
| path | pair of yellow rubber rain boots |
| pebble | small heap of smooth round pebbles in grey, cream and rust |
| pier | fishing rod and reel standing in a small tin bucket |
| pine | large brown pinecone with a short sprig of pine needles |
| puffin | Atlantic puffin standing, black and white with an orange beak and feet |
| reef | branch of coral-pink coral beside a small purple sea fan |
| ripple | red-and-white fishing bobber floating with a single thin ripple ring around it |
| river | speckled brown trout curved as if mid-flop |
| rock | round grey boulder dotted with white barnacles and a strand of seaweed |
| rook | glossy black rook (the bird, not the chess piece) standing, pale grey beak |
| sail | toy wooden sailboat with a white triangular sail and a small pennant |
| sand | sandcastle with two towers and a little flag |
| seal | grey harbor seal lying on its belly with its head raised |
| shell | scallop shell in peach and cream, standing on its edge |
| shore | folded wooden deck chair with teal-and-cream striped canvas |
| skiff | two wooden oars crossed in an X |
| spray | small grey dolphin leaping out of a splash of white spray |
| star | orange five-armed starfish propped up on one arm |
| stone | cairn of four flat stacked stones, smallest on top |
| sunset | half-set orange sun sinking behind a curl of blue wave |
| swift | dark brown swift in flight with long swept-back wings |
| tern | white tern with a black cap and an orange beak, standing |
| tide | small rock-pool basin holding water, a pink anemone and a tiny snail |
| valley | wicker picnic basket with a red gingham cloth |
| vessel | wooden ship's steering wheel with a brass hub, standing upright |
| wave | cream surfboard with a coral stripe, standing upright |
| wharf | wooden barrel with iron hoops, a fish tail poking out of the top |
| wren | small round brown wren with an upturned tail |
