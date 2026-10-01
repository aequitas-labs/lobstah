import sprite from '../../../../../docs/assets/lob-sprite.png';
import star from '../../../../../docs/assets/star.png';
import { html } from '../html.js';

/** Embed the existing pet art: even a standalone page keeps the lobster and star together. */
export const PetArt = () =>
  html`<span class="pet-art" aria-hidden="true"><div class="sprite" style=${{ backgroundImage: `url(${sprite})` }}></div><img class="star" src=${star} alt="" /></span>`;

export const BrandPet = () => html`<span class="brand-pet">${html`<${PetArt} />`}</span>`;
