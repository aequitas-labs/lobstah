# Trap art

Every trap name is `<first>-<last>` (`packages/core/src/trap-names.ts`).
Every trap uses the same illustration. Its **first** word paints the buoy
in a band pattern, the way lobstermen paint their buoys so others can tell
whose trap is whose. Its **last** word adds an item beside the trap.

| File | What it is |
|---|---|
| `source.webp` | The trap illustration |
| `base.png` | The trap cut out of its background and ground shadow |
| `bands.json` | The buoy colours, and the band pattern for each first word |
| `props/<word>.png` | One item per last word (to be generated) |

The scripts in `scripts/trap-art/` need Python 3 with `numpy` and `pillow`.

## First words: buoy bands

`scripts/trap-art/buoy.py` paints the buoy in `base.png` for each first
word. Bands keep the original's shading and outline.

```bash
python3 scripts/trap-art/buoy.py --sheet     # every word -> build/trap-art/, plus _sheet.png
python3 scripts/trap-art/buoy.py blue rapid  # just these
```

In `bands.json`, `colours` names the paints and `bands` lists each word's
bands from the rope end to the dowel end. A band is a colour name with an
optional width: `["B", "W", "B"]` is three equal bands, and
`["B2", "W.6", "B2"]` is blue with a thin white stripe. No two words share
a pattern.

### A bigger buoy

The buoy is small in the original, so its bands are hard to read at card
size. To enlarge it, attach `source.webp` and send:

> Edit the attached lobster trap illustration. Make the red buoy at the end
> of the rope about twice as large, still tied to the end of the rope and
> lying on the ground in the same direction, with its wooden dowel. Keep it
> plain red with no stripes. Keep everything else exactly the same: the
> trap, the rope, the colours, the style, the camera angle and the framing.

Save the result as `source.webp`, then run
`python3 scripts/trap-art/cutout.py` to rebuild `base.png`. `buoy.py` finds
the buoy by its red paint, so nothing else needs to change.

## Last words: 64 props

Attach the trap image as a style reference and send the prompt below with
`{subject}` replaced from the table. Then cut it out with
`python3 scripts/trap-art/cutout.py <gemini.png> docs/assets/traps/props/<word>.png`
(without `--net`, so white parts of the prop stay).

> Use the attached lobster trap illustration as the style reference. Draw a
> single {subject} as a standalone prop in exactly the same style: the same
> hand-drawn flat illustration, warm muted coastal palette, clean rounded
> shapes, a consistent reddish-brown outline (#8A3A1E) about 1% of the image
> width, and simple shading with one highlight tone and one shadow tone.
> Three-quarter view from slightly above, lit from the upper left, matching
> the trap. Draw it at small diorama scale, as if it sits on the ground
> beside the trap. Animals are friendly and simple, with dot eyes. Square
> 1024×1024 canvas with a plain pure white background, the object centred
> and filling about 70% of the width. No ground, no cast shadow, no text, no
> border and no other objects.

The cut-out is cropped to the prop, so props don't need matching framing.
The compose step (not written yet) will scale each prop to the same height
and stand it beside the trap's front-left corner.

### The 64 props

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
