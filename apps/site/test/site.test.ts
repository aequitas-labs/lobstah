import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain .mjs build script, no types
import {
  ART_WIDTHS,
  GLASS_RULES,
  WEIGHT_BUDGET,
  buildSite,
  expandArt,
  firstLoadWeight,
  holdWharf,
  includePartials,
  pickRules,
  topLevelRules,
  webpSize,
} from '../../../scripts/build-site.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, '..', 'assets');

/** The words a visitor reads: tags, styles and scripts removed. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

describe('the site build helpers', () => {
  it('reads top-level rules and keeps nested blocks whole', () => {
    const rules = topLevelRules('/* c */ .a { x: 1; }\n.b,\n.c { y: 2 }\n@keyframes k { from { z: 0 } to { z: 1 } }');
    expect(rules.map((r: { selector: string }) => r.selector)).toEqual(['.a', '.b, .c', '@keyframes k']);
    expect(rules[2].text).toBe('@keyframes k { from { z: 0 } to { z: 1 } }');
  });

  it('picks named rules and fails on a selector the sheet lost', () => {
    const css = ':root { --a: 1 }\n.card { color: red }\n.card:hover { color: blue }';
    expect(pickRules(css, [':root', '.card'])).toBe(':root { --a: 1 }\n.card { color: red }');
    expect(() => pickRules(css, ['.gone'])).toThrow(/no rule for "\.gone"/);
  });

  it('finds every glass rule the page reuses', () => {
    const glass = fs.readFileSync(path.join(here, '..', '..', 'cli', 'glass', 'glass.css'), 'utf8');
    expect(() => pickRules(glass, GLASS_RULES)).not.toThrow();
  });

  it('reads the size of each cut WebP', () => {
    for (const [name, widths] of Object.entries(ART_WIDTHS) as [string, number[]][]) {
      for (const w of widths) expect(webpSize(fs.readFileSync(path.join(assets, `${name}-${w}.webp`))).width).toBe(w);
    }
    expect(() => webpSize(Buffer.from('not an image at all'))).toThrow(/not a WebP/);
  });

  it('gives every art image one source per cut width, and its size', () => {
    const { html, used } = expandArt('<img class="x" data-art="trap" data-sizes="60px" alt="" />', () => ({ width: 180, height: 139 }));
    expect(html).toBe(
      '<img class="x" src="assets/trap-180.webp" srcset="assets/trap-180.webp 180w, assets/trap-320.webp 320w" sizes="60px" width="180" height="139" decoding="async" alt="" />',
    );
    expect(used).toEqual(['trap-180.webp', 'trap-320.webp']);
    expect(() => expandArt('<img data-art="kraken" data-sizes="1px" alt="" />', () => ({ width: 1, height: 1 }))).toThrow(
      /unknown art layer/,
    );
  });

  it('puts a partial where the page asks for it, filled from the include line', () => {
    const partial = '<!-- a note for the source reader -->\n<div id="box-{{id}}"></div>\n';
    expect(includePartials('<a>\n  <!-- include box.html id=hero -->\n<b>\n', () => partial)).toBe('<a>\n<div id="box-hero"></div>\n<b>\n');
    expect(() => includePartials('<!-- include box.html -->\n', () => partial)).toThrow(/needs id=/);
  });

  it('holds the wharf section out unless asked for it', () => {
    const page = '<a>\n  <!-- wharf:start (held) -->\n  <b>wharf</b>\n  <!-- wharf:end -->\n<c>\n';
    expect(holdWharf(page, false)).toBe('<a>\n<c>\n');
    expect(holdWharf(page, true)).toBe('<a>\n  <b>wharf</b>\n<c>\n');
    expect(() => holdWharf('<a>', false)).toThrow(/wharf:start/);
  });
});

describe('the built page', () => {
  let built: { html: string; files: { name: string; bytes: number }[] };
  let withWharf: { html: string };
  beforeAll(async () => {
    built = await buildSite({ write: false });
    withWharf = await buildSite({ write: false, wharf: true });
  });

  it('stays within the weight budget on a phone and on a desktop', () => {
    const small = firstLoadWeight(built.html, built.files, 'small');
    const large = firstLoadWeight(built.html, built.files, 'large');
    expect(small.total).toBeLessThanOrEqual(large.total);
    expect(large.total).toBeLessThanOrEqual(WEIGHT_BUDGET);
  });

  it('loads nothing from another origin and no animation runtime', () => {
    // Links may leave the page; anything fetched to draw it may not.
    const fetched = [...built.html.matchAll(/(?:\ssrc|srcset)="([^"]+)"|url\(([^)]+)\)/g)].map((m) => m[1] ?? m[2]);
    expect(fetched.length).toBeGreaterThan(10);
    for (const ref of fetched) expect(ref).not.toMatch(/^\s*(https?:)?\/\//);
    expect(built.html).not.toMatch(/lottie|rive\.app|@rive|gsap|<canvas|<video/i);
  });

  it('says nothing about merges', () => {
    expect(visibleText(built.html)).not.toMatch(/merg/i);
    expect(visibleText(withWharf.html)).not.toMatch(/merg/i);
  });

  it('keeps the wharf out of the published page', () => {
    expect(built.html).not.toMatch(/wharf/i);
    expect(visibleText(withWharf.html)).toContain('The glass, hosted. Check the water from your phone.');
  });

  it('hands the install to an agent in the hero and again at the end, with the command by hand', () => {
    const hero = built.html.slice(built.html.indexOf('id="hero"'), built.html.indexOf('id="set"'));
    expect(hero).toContain('Give this to your agent');
    expect(built.html.match(/class="handoff" id="handoff-\w+"/g)).toEqual([
      'class="handoff" id="handoff-hero"',
      'class="handoff" id="handoff-start"',
    ]);
    // Every tab carries the real install command; the harness tabs name their real plugin steps.
    const panels = built.html.match(/<pre\s+class="panel[^>]*>[\s\S]*?<\/pre>/g) ?? [];
    expect(panels).toHaveLength(6);
    for (const panel of panels) expect(panel).toContain('npm i -g lobstah');
    expect(built.html).toContain('/plugin marketplace add aequitas-labs/lobstah');
    expect(built.html).toContain('codex plugin marketplace add aequitas-labs/lobstah');
    expect(built.html).not.toMatch(/\{\{\w+\}\}|<!-- include/);
  });

  it("puts the star call at the bottom only, with the lobster's own star", () => {
    const star = [...built.html.matchAll(/class="starcall" href="https:\/\/github\.com\/aequitas-labs\/lobstah"/g)];
    expect(star).toHaveLength(1);
    const at = star[0].index ?? 0;
    expect(at).toBeGreaterThan(built.html.indexOf('id="start"'));
    expect(built.html.slice(at, at + 200)).toContain('src="assets/star.png"');
    expect(visibleText(built.html)).not.toContain('★');
  });

  it('keeps the lobster strip at the very bottom of the page, not fixed to the screen', () => {
    expect(built.html.indexOf('class="strip"')).toBeGreaterThan(built.html.indexOf('</footer>'));
    const css = built.html.slice(built.html.indexOf('<style>'), built.html.indexOf('</style>'));
    // The glass fixes its lobsters to the window; here they belong to the strip.
    expect(css).toMatch(/\.lob\{[^}]*position:absolute/);
    expect(css).toMatch(/\.strip\{[^}]*position:relative/);
  });

  it('keeps the star with every lobster', () => {
    const lobsters = built.html.match(/class="sprite"/g) ?? [];
    expect(lobsters.length).toBeGreaterThan(0);
    expect(built.html.match(/class="pet-art[^"]*">\s*<span class="sprite"><\/span>\s*<img class="star"/g)).toHaveLength(lobsters.length);
  });

  it('tells the story as one scene with five beats', () => {
    expect(built.html.match(/class="pin"/g)).toHaveLength(1);
    const beats = [...built.html.matchAll(/class="beat[^"]*" id="([a-z]+)"/g)].map((m) => m[1]);
    expect(beats).toEqual(['hero', 'set', 'away', 'buoy', 'haul']);
    const css = built.html.slice(built.html.indexOf('<style>'), built.html.indexOf('</style>'));
    // Each later beat has a place on the story's dial, for browsers the scroll cannot drive.
    for (const beat of [1, 2, 3, 4]) expect(css).toMatch(new RegExp(`\\.story\\[data-beat="?'?${beat}'?"?\\]\\{--p:`));
  });

  it('stands still unless motion is switched on', () => {
    const css = built.html.slice(built.html.indexOf('<style>'), built.html.indexOf('</style>'));
    // Every loop the page starts sits under `.motion`; the glass's own lobster rules are switched off outside it.
    const rules = topLevelRules(css).filter(
      (r: { selector: string; text: string }) => !r.selector.startsWith('@') && /animation(-name)?:/.test(r.text),
    );
    const always = rules.filter(
      (r: { selector: string; text: string }) => !r.selector.includes('.motion') && !/animation:\s*none/.test(r.text),
    );
    expect(always.map((r: { selector: string }) => r.selector).sort()).toEqual(['.lob', '.pet-art .sprite']);
    expect(css).toMatch(/\.lob\{[^}]*animation:none/);
    expect(css).toMatch(/\.pet-art \.sprite\{[^}]*animation:none/);
    // The scroll drives the scene only where the browser supports it, and only with motion on.
    const scroll = topLevelRules(css).filter((r: { text: string }) => r.text.includes('animation-timeline'));
    expect(scroll).toHaveLength(1);
    expect(scroll[0].selector).toMatch(/^@supports/);
    expect(scroll[0].text).toContain('.motion .story');
  });
});
