// Draws docs/assets/trap.svg, the base art for trap images, from a tiny 3D
// model: u runs along the trap's length, v across its depth (0 = back,
// 1 = front), h up (1 = arch top). Colours are CSS custom properties
// (--trap-wood, --trap-rope, --trap-buoy, ...) so an inlined copy can be
// re-tinted; docs/assets/props/README.md describes the prop slot.
//
//   node scripts/trap-svg.mjs [out.svg]
import { writeFileSync } from 'node:fs';

const O = [252, 728];      // back-left-bottom corner on screen
const L = [385, -122];     // u: 0 → 1
const D = [222, 122];      // v: 0 → 1
const H = 272;             // h: 0 → 1
const H0 = 0.62;           // where the arch legs start to curve

const P = (u, v, h) => [O[0] + u * L[0] + v * D[0], O[1] + u * L[1] + v * D[1] - h * H];
const f = (n) => Math.round(n * 10) / 10;
const pts = (a) => a.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
const pathOf = (a, close = false) => 'M' + a.map(([x, y]) => `${f(x)} ${f(y)}`).join(' L') + (close ? ' Z' : '');

/** Arch profile in (v, h): back leg, round top, front leg; k > 1 sits outside the frame. */
const prof = (t, k = 1) => [0.5 + 0.5 * k * Math.cos(t), H0 + (1 - H0) * k * Math.sin(t)];
function archPts(u, from = Math.PI, to = 0, legs = 'both', n = 40) {
  const out = [];
  if (legs === 'both' || legs === 'back') out.push(P(u, 0, 0));
  for (let i = 0; i <= n; i++) {
    const t = from + (to - from) * (i / n);
    const [v, h] = prof(t);
    out.push(P(u, v, h));
  }
  if (legs === 'both' || legs === 'front') out.push(P(u, 1, 0));
  return out;
}

/** Diamond mesh for a planar face given as map(a, b) over a ∈ [0,1], b ∈ [0,1]. */
function mesh(map, cellsA, cellsB) {
  // lines a*cellsA ± b*cellsB = k, extended past the face and clipped later
  const lines = [];
  for (let k = -2 * (cellsA + cellsB); k <= 2 * (cellsA + cellsB); k++) {
    lines.push([map(-0.5, (k + 0.5 * cellsA) / cellsB), map(1.5, (k - 1.5 * cellsA) / cellsB)]);
    lines.push([map(-0.5, (-0.5 * cellsA - k) / cellsB), map(1.5, (1.5 * cellsA - k) / cellsB)]);
  }
  return lines.map(([a, b]) => `M${f(a[0])} ${f(a[1])} L${f(b[0])} ${f(b[1])}`).join(' ');
}

const strands = (d) => `<path class="n-out" d="${d}"/><path class="n" d="${d}"/>`;
const parts = [];
const add = (s) => parts.push(s);
const clips = [];

// Ground shadow.

// Base slab.
const bu0 = -0.045, bu1 = 1.045, bv0 = -0.06, bv1 = 1.07, T = 22;
const top = [P(bu0, bv0, 0), P(bu1, bv0, 0), P(bu1, bv1, 0), P(bu0, bv1, 0)];
const down = ([x, y]) => [x, y + T];
add(`<polygon class="wood-dark line" points="${pts([P(bu0, bv0, 0), P(bu0, bv1, 0), down(P(bu0, bv1, 0)), down(P(bu0, bv0, 0))])}"/>`);
add(`<polygon class="wood-side line" points="${pts([P(bu0, bv1, 0), P(bu1, bv1, 0), down(P(bu1, bv1, 0)), down(P(bu0, bv1, 0))])}"/>`);
add(`<polygon class="wood line" points="${pts(top)}"/>`);
for (const v of [0.18, 0.4, 0.62, 0.84]) add(`<path class="seam" d="${pathOf([P(bu0 + 0.01, v, 0), P(bu1 - 0.01, v, 0)])}"/>`);
for (const u of [0.25, 0.75]) add(`<path class="seam thin" d="${pathOf([down(P(u, bv1, 0)), P(u, bv1, 0)])}"/>`);

// Faces: back wall, far end, near end, front wall.
const backFace = [P(0, 0, 0), P(1, 0, 0), P(1, 0, H0), P(0, 0, H0)];
const frontFace = [P(0, 1, 0), P(1, 1, 0), P(1, 1, H0), P(0, 1, H0)];
const endFace = (u) => archPts(u);

const hoopC = [0.265, 0.33], hoopR = [0.125, 0.2];
const hoop = (k = 1, v = 1) => Array.from({ length: 64 }, (_, i) => {
  const t = (i / 64) * Math.PI * 2;
  return P(hoopC[0] + hoopR[0] * k * Math.cos(t), v, hoopC[1] + hoopR[1] * k * Math.sin(t));
});

clips.push(`<clipPath id="c-back"><polygon points="${pts(backFace)}"/></clipPath>`);
clips.push(`<clipPath id="c-far"><polygon points="${pts(endFace(1))}"/></clipPath>`);
clips.push(`<clipPath id="c-near"><polygon points="${pts(endFace(0))}"/></clipPath>`);
clips.push(`<clipPath id="c-front"><path clip-rule="evenodd" d="${pathOf(frontFace, true)} ${pathOf(hoop(), true)}"/></clipPath>`);
clips.push(`<clipPath id="c-hoop"><polygon points="${pts(hoop())}"/></clipPath>`);

const meshU = (v) => (a, b) => P(a, v, b * H0);
const meshV = (u) => (a, b) => P(u, a, b);

add(`<g class="net far" clip-path="url(#c-back)">${strands(mesh(meshU(0), 7, 3))}</g>`);
add(`<g class="net far" clip-path="url(#c-far)">${strands(mesh(meshV(1), 3.2, 4))}</g>`);

/** A timber: outline stroke under a wood stroke under a highlight. */
const timber = (d, w = 20, cls = '') => `<g class="timber ${cls}"><path class="t-out" stroke-width="${w + 6}" d="${d}"/><path class="t-wood" stroke-width="${w}" d="${d}"/><path class="t-hi" stroke-width="${Math.max(2, w / 6)}" d="${d}" transform="translate(-${w / 5} -${w / 6})"/></g>`;

add(timber(pathOf(archPts(1)), 22));
add(timber(pathOf(archPts(0.5, Math.PI, Math.PI / 2, 'back')), 22));

// Front wall net with the hoop entrance and its funnel.
add(`<g class="net" clip-path="url(#c-front)">${strands(mesh(meshU(1), 7, 3))}</g>`);
const inner = hoop(0.45, 0.62);
const outer = hoop();
let spokes = '';
for (let i = 0; i < 64; i += 4) spokes += `M${f(outer[i][0])} ${f(outer[i][1])} L${f(inner[i][0])} ${f(inner[i][1])} `;
add(`<g class="net" clip-path="url(#c-hoop)">${strands(spokes)}<polygon class="ring-in" points="${pts(hoop(0.75, 0.82))}"/><polygon class="ring-in" points="${pts(inner)}"/></g>`);

add(timber(pathOf(archPts(0.5, Math.PI / 2, 0, 'front')), 22));

// Near end net and frame.
add(`<g class="net" clip-path="url(#c-near)">${strands(mesh(meshV(0), 3.2, 4))}</g>`);
add(timber(pathOf(archPts(0)), 22));

// Roof slats along the length, back to front.
const slatAngles = [150, 121, 92, 63, 34];
for (const deg of slatAngles) {
  const t = (deg * Math.PI) / 180, w = 0.15;
  const [va, ha] = prof(t + w, 1.08), [vb, hb] = prof(t - w, 1.08);
  const [vc, hc] = prof(t - w, 1.0);
  const u0 = -0.05, u1 = 1.05;
  const face = [P(u0, va, ha), P(u1, va, ha), P(u1, vb, hb), P(u0, vb, hb)];
  const lip = [P(u0, vb, hb), P(u1, vb, hb), P(u1, vc, hc), P(u0, vc, hc)];
  const end = [P(u0, va, ha), P(u0, vb, hb), P(u0, vc, hc), P(u0, ...prof(t + w, 1.0))];
  add(`<g class="slat"><polygon class="wood-side line" points="${pts(lip)}"/><polygon class="wood-dark line" points="${pts(end)}"/><polygon class="wood-light line" points="${pts(face)}"/>`
    + `<path class="grain" d="${pathOf([P(u0 + 0.06, ...prof(t + w * 0.2, 1.08)), P(u1 - 0.2, ...prof(t + w * 0.2, 1.08))])}"/>`
    + [0, 0.5, 1].map((u) => { const [x, y] = P(u, ...prof(t, 1.08)); return `<circle class="nail" cx="${f(x)}" cy="${f(y)}" r="3.6"/>`; }).join('')
    + `</g>`);
}

// Hoop ring on the front wall.
add(`<polygon class="rope-out" points="${pts(hoop())}"/><polygon class="rope" points="${pts(hoop())}"/><polygon class="rope-twist" points="${pts(hoop())}"/>`);

// Carrying handle on the roof ridge.
const ha = P(0.4, 0.5, 1.08), hb = P(0.62, 0.5, 1.08);
const handle = `M${f(ha[0])} ${f(ha[1] + 6)} C${f(ha[0] - 8)} ${f(ha[1] - 95)} ${f(hb[0] + 6)} ${f(hb[1] - 100)} ${f(hb[0])} ${f(hb[1] + 6)}`;
add(`<g class="handle"><path class="rope-out" d="${handle}"/><path class="rope" d="${handle}"/><path class="rope-twist" d="${handle}"/></g>`);

// Line out of the hoop to the buoy.
const ls = P(hoopC[0] + 0.02, 1, hoopC[1] - hoopR[1] + 0.02);
const buoyAt = [700, 912];
const tail = [buoyAt[0] - 73, buoyAt[1] + 16];
const line = `M${f(ls[0])} ${f(ls[1])} C${f(ls[0] + 4)} ${f(ls[1] + 90)} ${f(ls[0] - 40)} ${f(tail[1] - 10)} ${f((ls[0] + tail[0]) / 2)} ${f(tail[1] + 8)} S ${f(tail[0] - 30)} ${f(tail[1] - 6)} ${f(tail[0])} ${f(tail[1])}`;
add(`<g class="line"><path class="rope-out" d="${line}"/><path class="rope" d="${line}"/><path class="rope-twist" d="${line}"/></g>`);

// Buoy: a stubby bullet on a dowel, tipped toward the viewer.
add(`<g class="buoy" transform="translate(${buoyAt[0]} ${buoyAt[1]}) rotate(-12) scale(1.25)">`
  + `<rect class="dowel line" x="24" y="-5" width="62" height="10" rx="4"/>`
  + `<path class="buoy-body line" d="M-40 -14 C-40 -28 -28 -30 -14 -30 C4 -30 22 -14 30 -4 C33 -1 33 1 30 4 C22 14 4 30 -14 30 C-28 30 -40 28 -40 14 Z"/>`
  + `<path class="buoy-hi" d="M-30 -18 C-22 -23 -8 -23 4 -18"/>`
  + `<rect class="dowel line" x="-60" y="-5" width="20" height="10" rx="4"/>`
  + `</g>`);

const style = `
  .shadow{fill:var(--trap-shadow,#ECE2CC)}
  .line{stroke:var(--trap-outline,#8A3A1E);stroke-width:3.5;stroke-linejoin:round}
  .wood{fill:var(--trap-wood,#C97A3D)}
  .wood-light{fill:var(--trap-wood-light,#D8914F)}
  .wood-side{fill:var(--trap-wood-side,#B4652F)}
  .wood-dark{fill:var(--trap-wood-dark,#9B5226)}
  .seam{fill:none;stroke:var(--trap-outline,#8A3A1E);stroke-width:3;stroke-linecap:round;opacity:.85}
  .seam.thin{stroke-width:2.5}
  .grain{fill:none;stroke:var(--trap-wood-hi,#E8AE6E);stroke-width:2.5;stroke-linecap:round;opacity:.9}
  .nail{fill:var(--trap-outline,#8A3A1E)}
  .timber path{fill:none;stroke-linejoin:round;stroke-linecap:butt}
  .t-out{stroke:var(--trap-outline,#8A3A1E)}
  .t-wood{stroke:var(--trap-wood,#C97A3D)}
  .t-hi{stroke:var(--trap-wood-hi,#E8AE6E);opacity:.8}
  .net path,.net polygon{fill:none;stroke-linecap:round}
  .n-out{stroke:var(--trap-net-dark,#B58A55);stroke-width:6.4}
  .n{stroke:var(--trap-net,#E4C997);stroke-width:3.4}
  .net.far{opacity:.45}
  .net .ring-in{stroke:var(--trap-net-dark,#B58A55);stroke-width:3}
  .funnel{fill:var(--trap-funnel,#F1E6CF)}
  .rope-out,.rope,.rope-twist{fill:none;stroke-linecap:round;stroke-linejoin:round}
  .rope-out{stroke:var(--trap-rope-dark,#9C7340);stroke-width:15}
  .rope{stroke:var(--trap-rope,#D9B884);stroke-width:9.5}
  .rope-twist{stroke:var(--trap-rope-dark,#9C7340);stroke-width:2.2;stroke-dasharray:3 6;opacity:.75}
  .dowel{fill:var(--trap-dowel,#E2B57A)}
  .buoy-body{fill:var(--trap-buoy,#C9533A)}
  .buoy-band{fill:var(--trap-buoy-band,#F4E9D6)}
  .buoy-hi{fill:none;stroke:var(--trap-buoy-hi,#E6876B);stroke-width:4;stroke-linecap:round}
`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="A wooden lobster trap with a rope handle and a buoy">
<title>lobster trap</title>
<style>${style}</style>
<defs>${clips.join('')}</defs>
<ellipse class="shadow" cx="500" cy="828" rx="470" ry="128"/>
<g id="trap" transform="translate(110 30) scale(0.9)">
${parts.join('\n')}
</g>
<!-- prop slot: place a prop image at x=30 y=600 width=300 height=300 (see docs/assets/props/README.md) -->
<g id="prop"></g>
</svg>
`;
writeFileSync(process.argv[2] ?? new URL('../docs/assets/trap.svg', import.meta.url), svg);
