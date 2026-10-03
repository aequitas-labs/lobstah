# Trap props

Every trap name is `<first>-<last>` (`packages/core/src/trap-names.ts`). The
trap image is `docs/assets/trap.svg` plus one prop chosen by the **last**
word. This file lists the 64 props and the prompt used to generate them.

## Generating a prop

Attach the trap reference image, then send the shared prompt with
`{subject}` replaced by the subject from the table.

> Use the attached lobster trap illustration as the style reference. Draw a
> single {subject} as a standalone prop in exactly the same style: flat
> vector illustration, warm muted coastal palette, clean rounded shapes, a
> consistent reddish-brown outline (#8A3A1E) about 1% of the image width,
> simple cel shading with one highlight tone and one shadow tone, no
> gradients, no texture noise. Three-quarter view from slightly above, lit
> from the upper left, matching the trap. Draw it at small diorama scale, as
> if it sits on the ground beside the trap. Animals are friendly and simple,
> with dot eyes. Square 1024×1024 canvas with a plain pure white background.
> Centre the object horizontally and rest it on an invisible floor line 88%
> of the way down, filling about 70% of the width. No ground, no cast
> shadow, no text, no border and no other objects.

## Delivering a prop

- Remove the white background and save a transparent PNG at 512×512 as
  `docs/assets/props/<word>.png`, for example `crab.png`.
- Keep the canvas framing: don't crop to the object. The trap places every
  prop in the same box (`x=30 y=600 width=300 height=300` in `trap.svg`), so
  the floor line and centring line them up.

## The 64 props

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
