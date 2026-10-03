# Trap art

Every trap name is `<first>-<last>` (`packages/core/src/trap-names.ts`).
A trap's image is the trap illustration finished by its **first** word,
plus a prop chosen by its **last** word.

| File | What it is |
|---|---|
| `source.webp` | The original trap illustration |
| `base.png` | The trap cut out of its background and ground shadow (`scripts/trap-art/cutout.py`) |
| `palettes.json` | One palette per colour word |
| `textures/<word>.png` | One textured trap per texture word (to be generated) |
| `props/<word>.png` | One prop per last word (to be generated) |

The scripts need Python 3 with `numpy` and `pillow`.

## First words: 52 colours, 12 textures

**Colours (52).** `scripts/trap-art/recolor.py` recolours `base.png` with
the word's palette from `palettes.json`. A palette sets up to four
materials (`wood`, `rope` for rope and netting, `buoy`, `outline`) and an
optional `contrast`. Shading, grain and edges carry over from the original,
so no new art is needed.

```bash
python3 scripts/trap-art/recolor.py --sheet      # every palette -> build/trap-art/, plus _sheet.png
python3 scripts/trap-art/recolor.py blue coral   # just these
```

**Textures (12).** These change the surface, so Gemini edits the
original: attach `source.webp` and send the prompt below with `{texture}`
replaced from the table. Then cut the result out with
`python3 scripts/trap-art/cutout.py <gemini.png> docs/assets/traps/textures/<word>.png`.
Textured traps keep the original colours.

> Edit the attached lobster trap illustration. Keep the trap's shape,
> outline, colours, camera angle, size and position exactly the same, and
> keep the same illustration style. Change only its surface: {texture}.
> Plain pure white background, no ground shadow, no other objects, no text.

| Word | Texture |
|---|---|
| crisp | a light coating of white frost on the slat tops, rope and netting, as on a cold morning |
| hardy | old weathered wood: sun-bleached and cracked along the grain, with scuffs, a few dark iron nail heads and slightly frayed rope |
| leafy | a few small green and autumn-orange leaves caught in the netting and resting on the slats |
| misty | tiny dew droplets beaded on the wood, rope and netting, with a cool damp sheen |
| mossy | soft patches of green moss growing on the slat tops, the tops of the arches and the edges of the base |
| reedy | thin marsh reeds and grass stalks tangled through the netting and poking out at the base |
| sandy | a dusting of pale sand over the wood, with small drifts of sand on the base and caught in the netting corners |
| smooth | freshly sanded, varnished wood with a soft gloss and clean highlights, and neat tight rope |
| tidal | just hauled from the sea: the lower third darker and wet with a shine, white barnacles on the base and legs, and a few drips |
| wavy | wood with a strong, wavy, driftwood-like grain |
| willow | the slats and arches made of woven willow wicker instead of planks |
| wispy | fine strands of green seaweed draped over the slats and trailing from the netting |

## Last words: 64 props

Attach the trap image as a style reference and send the prompt below with
`{subject}` replaced from the table. Then cut it out with
`python3 scripts/trap-art/cutout.py <gemini.png> docs/assets/traps/props/<word>.png`.

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

The cut-out is cropped to the prop. When composed, a prop is scaled to fit
a 300×300 box and stands with its bottom centre at the trap's front-left
corner, so props don't need matching framing.

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
