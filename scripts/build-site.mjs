// Build the marketing page: apps/site/index.html with its stylesheet and
// script inlined, written to apps/site/dist with the art it uses. The page
// wears the glass's theme: the design tokens and the card, badge, button and
// lobster rules are read from apps/cli/glass/glass.css at build time, never
// copied by hand. Nothing here deploys or publishes anything.
//
//   node scripts/build-site.mjs            build once into apps/site/dist
//   node scripts/build-site.mjs --serve    build, serve on 127.0.0.1:4950, rebuild on change (pnpm site:dev)
//   node scripts/build-site.mjs --wharf    include the wharf section (held out until the wharf ships)
//   node scripts/build-site.mjs --out dir  write somewhere other than apps/site/dist (a second preview: --serve --wharf --port 4951 --out dir)
//   node scripts/build-site.mjs --dev      unminified, for reading the page source
//   node scripts/build-site.mjs --site-url https://example.org
//                                          the address the site will be served from: adds the canonical link,
//                                          the social card's address and image, sitemap.xml, and full addresses
//                                          in llms.txt. Without it the build leaves those out and keeps links relative.
import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'apps', 'site');
const glassCss = path.join(root, 'apps', 'cli', 'glass', 'glass.css');

const CSS_TAG = '<link rel="stylesheet" href="./site.css" />';
const META_TAG = '<!-- head:meta -->';
const REPO = 'https://github.com/aequitas-labs/lobstah';
const NPM = 'https://www.npmjs.com/package/lobstah';
const JS_TAG = '<script src="./src/main.ts"></script>';

/** The page may weigh this much on first load, for any one screen size. */
export const WEIGHT_BUDGET = 300 * 1024;

/** Each art layer, the widths it was cut at, and the layers that share its canvas. */
export const ART_WIDTHS = {
  'buoy-body': [160, 320],
  'buoy-flag': [160, 320],
  'boat-body': [420, 760],
  'boat-crane': [420, 760],
  'boat-hook': [420, 760],
  'boat-bunting-left': [420, 760],
  'boat-bunting-right': [420, 760],
  trap: [180, 320],
};

/** Files the page uses that live elsewhere in the repo: the glass's lobster, its star, its app icon and its favicon. */
const SHARED = {
  'lob-sprite.png': ['docs', 'assets', 'lob-sprite.png'],
  'star.png': ['docs', 'assets', 'star.png'],
  'icon-192.png': ['apps', 'cli', 'glass', 'assets', 'app-icon-192.png'],
  'favicon.png': ['docs', 'assets', 'favicon.png'],
};

/**
 * The card shown when a link to the page is shared. The build draws it: the
 * glass's own lobster and star on the glass's ground, with the page's tagline
 * beside them. The page itself never loads it.
 */
const CARD = { name: 'social-card.png', width: 1200, height: 630 };
const CARD_ALT = 'The lobstah lobster with its star, beside the words: lobstah. Nobody stares at the water.';

/** The glass rules the page reuses, by selector, in the glass's own order. */
export const GLASS_RULES = [
  ':root',
  '*',
  'body',
  'h2',
  '.card',
  '.card:hover',
  '.card .top',
  '.card .top > b, .card .top > .prname',
  '.card .top .badge',
  '.card .meta',
  '.btn',
  '.btn:hover',
  '.badge',
  '.badge.pr-open',
  '.dim',
  'a',
  'footer',
  '.lob',
  '.pet-art',
  '.pet-art .sprite',
  '.pet-art .star',
  '@keyframes crawl',
  '@keyframes step',
];

/** Every top-level rule of a stylesheet: [{ selector, text }]. Comments are dropped. */
export function topLevelRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  let depth = 0;
  let start = 0;
  let open = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) open = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const selector = src.slice(start, open).trim().replace(/\s+/g, ' ');
        rules.push({ selector, text: src.slice(start, i + 1).trim() });
        start = i + 1;
      }
    }
  }
  return rules;
}

/** The named rules of a stylesheet, joined. A selector the sheet no longer has fails the build. */
export function pickRules(css, selectors) {
  const rules = topLevelRules(css);
  return selectors
    .map((want) => {
      const found = rules.filter((r) => r.selector === want);
      if (!found.length) throw new Error(`glass.css has no rule for "${want}": update GLASS_RULES in scripts/build-site.mjs`);
      return found.map((r) => r.text).join('\n');
    })
    .join('\n');
}

/** Pixel size of a WebP file (lossy, lossless or extended), read from its header. */
export function webpSize(buf) {
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not a WebP file');
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (kind === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  throw new Error(`unknown WebP chunk ${kind}`);
}

/** Drop the wharf section, or keep it and drop only its markers. */
export function holdWharf(page, include) {
  const block = /[ \t]*<!-- wharf:start[^>]*-->\n([\s\S]*?)[ \t]*<!-- wharf:end -->\n/;
  if (!block.test(page)) throw new Error('index.html must mark the wharf section with wharf:start and wharf:end');
  return page.replace(block, include ? '$1' : '');
}

/**
 * Put a partial where the page asks for it: `<!-- include handoff.html id=hero -->`
 * becomes that file, with each `{{id}}` in it filled from the comment.
 */
export function includePartials(page, readPartial) {
  return page.replace(/[ \t]*<!-- include (\S+)((?: \w+=\S+)*) -->\n/g, (_, file, pairs) => {
    const values = Object.fromEntries([...pairs.matchAll(/(\w+)=(\S+)/g)].map((m) => [m[1], m[2]]));
    return (
      readPartial(file)
        // notes for the source reader go; an `icon` request stays for inlineIcons
        .replace(/<!--(?! icon )[\s\S]*?-->\n?/g, '')
        .replace(/\{\{(\w+)\}\}/g, (whole, key) => {
          if (!(key in values)) throw new Error(`${file} needs ${key}= on its include line`);
          return values[key];
        })
    );
  });
}

/**
 * Draw a mark where the page asks for it: `<!-- icon github -->` becomes that
 * file's drawing, inline. Only the wrapper is ours; the shapes are untouched.
 */
export function inlineIcons(page, readIcon) {
  return page.replace(/<!-- icon ([\w-]+) -->/g, (_, name) => {
    const svg = readIcon(name);
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1];
    const inner = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1];
    if (!viewBox || inner === undefined) throw new Error(`icons/${name}.svg is not a plain SVG with a viewBox`);
    const shapes = inner.replace(/<title>[\s\S]*?<\/title>/, '').trim();
    return `<svg class="ico" data-mark="${name}" viewBox="${viewBox}" aria-hidden="true" focusable="false">${shapes}</svg>`;
  });
}

/** Turn every `<img data-art="name" data-sizes="…">` into a sized image with one source per cut width. */
export function expandArt(page, sizeOf) {
  const used = new Set();
  const html = page.replace(/<img([^>]*?)\s+data-art="([^"]+)"\s+data-sizes="([^"]+)"\s*([^>]*?)\/>/g, (_, before, name, sizes, after) => {
    const widths = ART_WIDTHS[name];
    if (!widths) throw new Error(`unknown art layer "${name}"`);
    const files = widths.map((w) => `${name}-${w}.webp`);
    files.forEach((f) => used.add(f));
    const { width, height } = sizeOf(files[0]);
    const srcset = files.map((f, i) => `assets/${f} ${widths[i]}w`).join(', ');
    return `<img${before} src="assets/${files[0]}" srcset="${srcset}" sizes="${sizes}" width="${width}" height="${height}" decoding="async" ${after}/>`;
  });
  if (/data-art=/.test(html)) throw new Error('an <img data-art> is missing its data-sizes');
  return { html, used: [...used] };
}

/**
 * What one screen downloads on first load: the page itself (compressed, as a
 * server sends it), the shared files, and one width of each art layer.
 */
export function firstLoadWeight(html, files, pick) {
  const page = zlib.gzipSync(Buffer.from(html)).length;
  const widthOf = (name) => Number(name.match(/-(\d+)\.webp$/)?.[1]);
  let art = 0;
  for (const [layer, widths] of Object.entries(ART_WIDTHS)) {
    const want = pick === 'small' ? Math.min(...widths) : Math.max(...widths);
    const file = files.find((f) => f.name === `${layer}-${want}.webp` && widthOf(f.name) === want);
    if (file) art += file.bytes;
  }
  const shared = files.filter((f) => !f.name.endsWith('.webp')).reduce((n, f) => n + f.bytes, 0);
  return { page, art, shared, total: page + art + shared };
}

/**
 * The site's public address, without a trailing slash, or '' when none is
 * given. Only an http(s) address counts; anything else is an error, never a guess.
 */
export function siteBase(siteUrl) {
  if (!siteUrl) return '';
  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new Error(`--site-url must be a full address such as https://example.org, not ${JSON.stringify(siteUrl)}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`--site-url must start with http:// or https://, not ${url.protocol}//`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

/**
 * Read a PNG into its pixels. Enough for the files the card is made of:
 * 8 bits a channel, grey or RGBA, not interlaced.
 */
export function pngDecode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('latin1', 12, 16) !== 'IHDR') throw new Error('not a PNG file');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const channels = { 0: 1, 2: 3, 6: 4 }[buf[25]];
  if (buf[24] !== 8 || !channels || buf[28] !== 0) throw new Error('only 8-bit grey, RGB or RGBA PNGs that are not interlaced can be read');
  const parts = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(buf.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  // Each row was stored as its difference from the pixels to its left and above; undo that.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? data[(y - 1) * stride + x - channels] : 0;
      const nearest = () => {
        const [a, b, c] = [Math.abs(up - corner), Math.abs(left - corner), Math.abs(left + up - 2 * corner)];
        return a <= b && a <= c ? left : b <= c ? up : corner;
      };
      const guess = [0, left, up, (left + up) >> 1, filter === 4 ? nearest() : 0][filter];
      if (guess === undefined) throw new Error(`unknown PNG row filter ${filter}`);
      data[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + guess) & 255;
    }
  }
  return { width, height, channels, data };
}

/** Write RGB pixels as a PNG. */
export function pngEncode(width, height, rgb) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const chunk = (type, body) => {
    const out = Buffer.alloc(body.length + 12);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < body.length + 8; i++) crc = crcTable[(crc ^ out[i]) & 255] ^ (crc >>> 8);
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits a channel, RGB, not interlaced
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One of the glass's colours, by its token name, as [r, g, b]. */
export function glassColor(css, token) {
  const hex = css.match(new RegExp(`--${token}:\\s*#([0-9a-f]{6})\\b`, 'i'))?.[1];
  if (!hex) throw new Error(`glass.css has no six-digit colour --${token}`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * Draw the social card. Everything on it is the repo's own: the ground and
 * the text colours are the glass's tokens, the lobster is the first frame of
 * the glass's sprite with its star where the glass puts it, both enlarged
 * pixel for pixel, and the words are the masks in art/card (drawn in the
 * glass's type by art/card-text.py). Same inputs, same picture: no fonts, no
 * network and no drawing tool are needed at build time.
 */
export function socialCard({ css, sprite, star, tagline, name }) {
  const { width, height } = CARD;
  const [bg, fg, dim] = ['bg', 'fg', 'dim'].map((token) => glassColor(css, token));
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set(bg, i * 3);
  // Lay `share` (0 to 1) of a colour over the pixel at x, y.
  const mix = (x, y, color, share) => {
    if (x < 0 || y < 0 || x >= width || y >= height || share <= 0) return;
    const at = (y * width + x) * 3;
    for (let c = 0; c < 3; c++) rgb[at + c] = Math.round(rgb[at + c] * (1 - share) + color[c] * share);
  };
  // A piece of pixel art, each of its pixels drawn as a square `scale` wide.
  const pixels = (image, left, top, scale, frameWidth = image.width) => {
    for (let y = 0; y < image.height * scale; y++) {
      for (let x = 0; x < frameWidth * scale; x++) {
        const from = (Math.floor(y / scale) * image.width + Math.floor(x / scale)) * 4;
        mix(left + x, top + y, image.data.subarray(from, from + 3), image.data[from + 3] / 255);
      }
    }
  };
  // Words: a mask says how much ink each pixel has; the colour is the glass's.
  const words = (mask, left, top, color) => {
    for (let y = 0; y < mask.height; y++)
      for (let x = 0; x < mask.width; x++) mix(left + x, top + y, color, mask.data[y * mask.width + x] / 255);
  };

  // The glass draws the lobster 72 by 56 with its star 56 across and 9 up from its corner, 14 tall. Here, six times that.
  const scale = 6;
  const frame = { width: sprite.width / 4, height: sprite.height };
  const starScale = Math.round((14 * scale) / star.height);
  const text = { height: name.height + 34 + tagline.height, width: Math.max(name.width, tagline.width) };
  const gap = 72;
  const group = frame.width * scale + gap + text.width;
  const left = Math.round((width - group) / 2);
  const top = Math.round((height - frame.height * scale) / 2) + 9 * scale * 0.5;
  pixels(sprite, left, top, scale, frame.width);
  pixels(star, left + 56 * scale, top - 9 * scale, starScale);
  const textLeft = left + frame.width * scale + gap;
  const textTop = Math.round((height - text.height) / 2);
  words(name, textLeft, textTop, dim);
  words(tagline, textLeft, textTop + name.height + 34, fg);
  return pngEncode(width, height, rgb);
}

const attr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * What a search engine, an answer engine or a link preview reads, and a
 * visitor never sees: the social card, the structured data, and pointers to
 * the setup guide and llms.txt. Every statement here is already on the page
 * or in the repo. Addresses that need the site's own address are left out
 * until `base` is known, so the build never emits a wrong one.
 */
export function headMeta({ title, description, base, image = CARD }) {
  const card = Boolean(base);
  const tags = [
    ...(base ? [`<link rel="canonical" href="${attr(base)}/" />`] : []),
    `<link rel="alternate" type="text/markdown" href="setup.md" title="lobstah setup guide, for agents" />`,
    `<link rel="alternate" type="text/plain" href="llms.txt" title="llms.txt" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="lobstah" />`,
    `<meta property="og:title" content="${attr(title)}" />`,
    `<meta property="og:description" content="${attr(description)}" />`,
    ...(base ? [`<meta property="og:url" content="${attr(base)}/" />`] : []),
    ...(card
      ? [
          `<meta property="og:image" content="${attr(base)}/assets/${image.name}" />`,
          `<meta property="og:image:width" content="${image.width}" />`,
          `<meta property="og:image:height" content="${image.height}" />`,
          `<meta property="og:image:alt" content="${attr(CARD_ALT)}" />`,
        ]
      : []),
    `<meta name="twitter:card" content="${card ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${attr(title)}" />`,
    `<meta name="twitter:description" content="${attr(description)}" />`,
    ...(card
      ? [
          `<meta name="twitter:image" content="${attr(base)}/assets/${image.name}" />`,
          `<meta name="twitter:image:alt" content="${attr(CARD_ALT)}" />`,
        ]
      : []),
  ];
  const app = {
    '@type': ['SoftwareApplication', 'SoftwareSourceCode'],
    name: 'lobstah',
    description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    softwareRequirements: 'Node.js 20 or later',
    license: 'https://opensource.org/licenses/MIT',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    codeRepository: REPO,
    downloadUrl: NPM,
    installUrl: NPM,
    ...(base ? { url: `${base}/` } : {}),
    sameAs: [REPO, NPM],
    author: { '@type': 'Organization', name: 'aequitas labs LLC', url: 'https://github.com/aequitas-labs' },
  };
  const graph = [app, ...(base ? [{ '@type': 'WebSite', name: 'lobstah', url: `${base}/`, description }] : [])];
  const data = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  return [...tags, `<script type="application/ld+json">${data}</script>`].join('\n');
}

/** robots.txt: everything may be crawled; the sitemap is named once the site has an address. */
export function robotsTxt(base) {
  return `User-agent: *\nAllow: /\n${base ? `\nSitemap: ${base}/sitemap.xml\n` : ''}`;
}

/** sitemap.xml: the page, llms.txt and the setup guide. */
export function sitemapXml(base) {
  const urls = ['', 'llms.txt', 'setup.md'].map((p) => `  <url><loc>${attr(`${base}/${p}`)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function inline(page, tag, content) {
  const at = page.indexOf(tag);
  if (at < 0 || page.indexOf(tag, at + 1) >= 0) throw new Error(`index.html must contain ${tag} exactly once`);
  return page.slice(0, at) + content + page.slice(at + tag.length);
}

export async function buildSite({ wharf = false, minify = true, outDir = path.join(site, 'dist'), write = true, siteUrl } = {}) {
  const base = siteBase(siteUrl);
  // Line endings are the checkout's (CRLF on Windows); the page is the same bytes everywhere.
  const read = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  const js = await esbuild.build({
    entryPoints: [path.join(site, 'src', 'main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const sheet = `${pickRules(read(glassCss), GLASS_RULES)}\n${read(path.join(site, 'site.css'))}`;
  const css = await esbuild.transform(sheet, { loader: 'css', minify, legalComments: 'none' });
  const assets = path.join(site, 'assets');
  let page = holdWharf(read(path.join(site, 'index.html')), wharf);
  page = includePartials(page, (file) => read(path.join(site, file)));
  page = inlineIcons(page, (name) => read(path.join(site, 'icons', `${name}.svg`)));
  page = page.replace(/[ \t]*<!-- scripts\/build-site\.mjs[^>]*-->\n/g, '');
  const art = expandArt(page, (f) => webpSize(fs.readFileSync(path.join(assets, f))));
  page = inline(art.html, CSS_TAG, `<style>${css.code.trimEnd().replace(/<\/(style)/gi, '<\\/$1')}</style>`);
  page = inline(page, JS_TAG, `<script>${js.outputFiles[0].text.trimEnd().replace(/<\/(script)/gi, '<\\/$1')}</script>`);

  // What machines read. The title and the description are the page's own, so they are said once.
  const title = page.match(/<title>([^<]*)<\/title>/)?.[1];
  const description = page.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1];
  if (!title || !description) throw new Error('index.html must have a <title> and a meta description');
  if (description.length > 160) throw new Error(`the meta description is ${description.length} characters; keep it under 160`);
  const unescape = (text) =>
    text
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&');
  page = inline(page, META_TAG, headMeta({ title: unescape(title), description: unescape(description), base }));
  const png = (...parts) => pngDecode(fs.readFileSync(path.join(root, ...parts)));
  const card = socialCard({
    css: read(glassCss),
    sprite: png(...SHARED['lob-sprite.png']),
    star: png(...SHARED['star.png']),
    tagline: png('apps', 'site', 'art', 'card', 'tagline.png'),
    name: png('apps', 'site', 'art', 'card', 'name.png'),
  });
  // Files served beside the page. In llms.txt, {{site}} stands before each address on this site.
  const beside = [
    { name: 'llms.txt', text: read(path.join(site, 'llms.txt')).replaceAll('{{site}}', base ? `${base}/` : '') },
    { name: 'setup.md', text: read(path.join(site, 'setup.md')) },
    { name: 'robots.txt', text: robotsTxt(base) },
    ...(base ? [{ name: 'sitemap.xml', text: sitemapXml(base) }] : []),
  ];

  const sources = [
    ...art.used.map((name) => [name, path.join(assets, name)]),
    ...Object.entries(SHARED).map(([name, parts]) => [name, path.join(root, ...parts)]),
  ];
  const files = sources.map(([name, from]) => ({ name, from, bytes: fs.statSync(from).size }));
  if (write) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), page);
    for (const f of files) fs.copyFileSync(f.from, path.join(outDir, 'assets', f.name));
    for (const f of beside) fs.writeFileSync(path.join(outDir, f.name), f.text);
    fs.writeFileSync(path.join(outDir, 'assets', CARD.name), card);
  }
  return { html: page, files, beside, card: { ...CARD, png: card }, outDir, wharf, base };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/** Serve the built page on loopback for a local look. Not a production server. */
function serve(outDir, port) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(outDir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(outDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, '127.0.0.1', () => console.log(`site: http://127.0.0.1:${port}/  (ctrl-c to stop)`));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const serving = args.includes('--serve');
  const port = Number(args[args.indexOf('--port') + 1]) || 4950;
  const outDir = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : undefined;
  const siteUrl = args.includes('--site-url') ? args[args.indexOf('--site-url') + 1] : undefined;
  const once = async () => {
    const t = Date.now();
    try {
      const built = await buildSite({ wharf: args.includes('--wharf'), minify: !serving && !args.includes('--dev'), outDir, siteUrl });
      const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
      const small = firstLoadWeight(built.html, built.files, 'small');
      const large = firstLoadWeight(built.html, built.files, 'large');
      console.log(
        `site: ${kb(small.page)} page, first load ${kb(small.total)} on a phone and ${kb(large.total)} on a desktop` +
          `${built.wharf ? ', with the wharf section' : ''}${built.base ? `, for ${built.base}/` : ', no site address'}, in ${Date.now() - t}ms → ${path.relative(root, built.outDir)}`,
      );
      if (large.total > WEIGHT_BUDGET) throw new Error(`first load is over the ${kb(WEIGHT_BUDGET)} budget`);
      return built;
    } catch (err) {
      console.error(`site: build failed\n${err instanceof Error ? err.message : err}`);
      if (!serving) process.exit(1);
    }
  };
  const built = await once();
  if (serving) {
    let timer;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(once, 50);
    };
    // Watch the folder, not each file: an editor that saves by replacing a file would otherwise slip the watch.
    fs.watch(site, { recursive: true }, (_, file) => {
      if (file && !String(file).startsWith('dist')) rebuild();
    });
    fs.watch(glassCss, rebuild);
    serve(built?.outDir ?? outDir ?? path.join(site, 'dist'), port);
  }
}
