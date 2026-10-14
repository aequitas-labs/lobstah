import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS } from '../../cli/src/usage.js';
// @ts-expect-error -- a plain .mjs build script, no types
import { buildSite, glassColor, pngDecode, pngEncode, siteBase } from '../../../scripts/build-site.mjs';
// @ts-expect-error -- a plain .js Worker, no types
import worker, { HOME } from '../worker.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(repo, ...parts), 'utf8').replace(/\r\n/g, '\n');
const json = (...parts: string[]) => JSON.parse(read(...parts));

/** The words a visitor reads in the page's body: tags, styles and scripts removed. */
function visibleText(html: string): string {
  return html
    .slice(html.indexOf('<body'))
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every `lobstah …` command a document shows, in its code blocks and its code spans. */
function lobstahCommands(doc: string): string[] {
  const found: string[] = [];
  for (const block of doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) if (/^lobstah(\s|$)/.test(line.trim())) found.push(line.trim());
  }
  const prose = doc.replace(/```[\s\S]*?```/g, '');
  for (const span of prose.matchAll(/`([^`]+)`/g)) {
    const text = span[1].replace(/\s+/g, ' ').trim();
    if (/^lobstah /.test(text)) found.push(text);
  }
  return found;
}

/** What is wrong with one command line, by the CLI's own table of commands, subverbs and flags; undefined when nothing is. */
function wrongWith(line: string): string | undefined {
  const words = line
    .replace(/\s+#.*$/, '')
    .split(/\s+/)
    .slice(1);
  let name = words.shift();
  if (name === undefined) return undefined;
  if (name === 'man') name = `man:${words.shift()}`;
  const spec = COMMANDS[name];
  if (!spec) return `no command "${name.replace(':', ' ')}"`;
  let positionals = 0;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.startsWith('--')) {
      const flag = spec.flags[word.split('=')[0]];
      if (!flag) return `"${name.replace(':', ' ')}" has no flag ${word}`;
      if (flag.value && !word.includes('=')) i++;
      continue;
    }
    // A plain word in first place is a subverb, where the command has any; a path or a <placeholder> is not.
    if (positionals++ === 0 && spec.subverbs && /^[a-z][a-z-]*$/.test(word) && !spec.subverbs.includes(word)) {
      return `"${name}" has no subverb ${word}`;
    }
  }
  return undefined;
}

describe('the checker for commands in the guides', () => {
  it('passes what the CLI has', () => {
    for (const ok of [
      'lobstah init --scan /full/path --pickup',
      'lobstah repos add /full/path/to/my.repo --key my-repo',
      'lobstah daemon install',
      'lobstah man helm --take',
      'lobstah glass --detach',
      'lobstah version',
    ]) {
      expect(wrongWith(ok), ok).toBeUndefined();
    }
  });

  it('names a command, a subverb or a flag the CLI does not have', () => {
    expect(wrongWith('lobstah setup')).toBe('no command "setup"');
    expect(wrongWith('lobstah man steer')).toBe('no command "man steer"');
    expect(wrongWith('lobstah daemon enable')).toBe('"daemon" has no subverb enable');
    expect(wrongWith('lobstah init --dry-run')).toBe('"init" has no flag --dry-run');
    expect(wrongWith('lobstah repos add /x --key k --trunk main')).toBe('"repos" has no flag --trunk');
  });

  it('finds commands in code blocks and in code spans, wrapped or not', () => {
    const doc = 'Run `lobstah\ndoctor` then:\n\n```bash\nnpm i -g lobstah\nlobstah version   # prints it\n```\n';
    expect(lobstahCommands(doc)).toEqual(['lobstah version   # prints it', 'lobstah doctor']);
  });
});

describe('what the site gives to agents and to search', () => {
  type Built = {
    html: string;
    beside: Array<{ name: string; text: string }>;
    card: { name: string; width: number; height: number; png: Buffer };
  };
  let plain: Built;
  let placed: Built;
  const file = (b: typeof plain, name: string) => b.beside.find((f) => f.name === name)?.text;
  beforeAll(async () => {
    plain = await buildSite({ write: false });
    placed = await buildSite({ write: false, siteUrl: 'https://lobstah.dev' });
  });

  it('leaves what a visitor reads exactly as it was', () => {
    // The page's words as they stood before the metadata was added. Change this file only when the page's copy is meant to change.
    const before = read('apps', 'site', 'test', 'visible-text.txt').trim();
    expect(visibleText(plain.html)).toBe(before);
    expect(visibleText(placed.html)).toBe(before);
  });

  it('names only commands, flags, skills, packages and files that exist', () => {
    const guides = `${read('apps', 'site', 'setup.md')}\n${read('apps', 'site', 'llms.txt')}`;

    const commands = lobstahCommands(guides);
    expect(commands.length).toBeGreaterThan(15);
    expect(commands.map((c) => [c, wrongWith(c)]).filter(([, wrong]) => wrong)).toEqual([]);

    // Skills: /lobstah:<skill> is Claude Code's, $lobstah:<skill> is Codex's.
    const skills = [...guides.matchAll(/([/$])lobstah:([a-z]+)/g)];
    expect(skills.length).toBeGreaterThan(3);
    for (const [, sigil, skill] of skills) {
      const plugin = sigil === '/' ? 'claude-code' : 'codex';
      expect(fs.existsSync(path.join(repo, 'plugins', plugin, 'skills', skill, 'SKILL.md')), `${sigil}lobstah:${skill}`).toBe(true);
    }

    // Packages: the CLI's npm name, and the OpenClaw plugin's.
    const cli = read('scripts', 'build-npm.mjs').match(/name: '([^']+)'/)?.[1];
    const claw = json('apps', 'node', 'package.json').name;
    expect([...guides.matchAll(/npm i -g (\S+)/g)].map((m) => m[1].replace(/`$/, ''))).toContain(cli);
    for (const [, pkg] of guides.matchAll(/npm i -g ([\w@/-]+)/g)) expect(pkg).toBe(cli);
    for (const [, pkg] of guides.matchAll(/openclaw plugins install ([\w@/-]+)/g)) expect(pkg).toBe(claw);
    for (const [, pkg] of guides.matchAll(/npmjs\.com\/package\/([\w@/-]+)/g)) expect([cli, claw]).toContain(pkg);

    // The marketplace and the plugin in it, for both harnesses.
    const markets = [json('.claude-plugin', 'marketplace.json'), json('.agents', 'plugins', 'marketplace.json')];
    const home = json('plugins', 'claude-code', '.claude-plugin', 'plugin.json').repository as string;
    const added = [...guides.matchAll(/plugin marketplace add ([\w/-]+)/g)];
    expect(added.length).toBeGreaterThan(1);
    for (const [, source] of added) expect(home.endsWith(`/${source}`), source).toBe(true);
    const installed = [...guides.matchAll(/plugin (?:install|add) ([\w-]+)@([\w-]+)/g)];
    expect(installed.length).toBeGreaterThan(1);
    for (const [, plugin, market] of installed) {
      for (const m of markets) {
        expect(m.name).toBe(market);
        expect(m.plugins.map((p: { name: string }) => p.name)).toContain(plugin);
      }
    }

    // OpenClaw: the tools and the plugin id are the manifest's.
    const manifest = json('apps', 'node', 'openclaw.plugin.json');
    const tools = [...new Set([...guides.matchAll(/\blobstah_[a-z]+\b/g)].map((m) => m[0]))].sort();
    expect(tools).toEqual([...manifest.contracts.tools].sort());
    expect(guides).toContain(`openclaw plugins inspect ${manifest.id} `);

    // Docs linked by their raw address are files in this repo.
    const raw = [...guides.matchAll(/raw\.githubusercontent\.com\/aequitas-labs\/lobstah\/main\/([\w./-]+\.md)/g)];
    expect(raw.length).toBeGreaterThan(8);
    for (const [, doc] of raw) expect(fs.existsSync(path.join(repo, ...doc.split('/'))), doc).toBe(true);
  });

  it('follows the llms.txt shape and points at the setup guide', () => {
    const llms = file(plain, 'llms.txt') ?? '';
    const lines = llms.split('\n');
    expect(lines[0]).toBe('# lobstah');
    expect(lines[2]).toMatch(/^> \S/);
    expect(llms.match(/^## .+$/gm)).toEqual(['## Setup', '## Docs', '## Packages and source', '## Optional']);
    // under each heading, nothing but links with a line about each
    const sections = llms.split(/^## .+$/m).slice(1);
    for (const section of sections) for (const line of section.trim().split('\n')) expect(line).toMatch(/^- \[[^\]]+\]\([^)]+\): \S/);
    expect(llms).toContain('- [Agent setup guide](setup.md): ');
    expect(file(plain, 'setup.md')).toBe(read('apps', 'site', 'setup.md'));
  });

  it('gives no address of its own until it is told one', () => {
    expect(plain.html).not.toMatch(/rel="canonical"|og:url|og:image|twitter:image/);
    expect(plain.html).toContain('<meta name="twitter:card" content="summary" />');
    expect(plain.beside.map((f) => f.name)).toEqual(['llms.txt', 'setup.md', 'robots.txt']);
    expect(file(plain, 'robots.txt')).toBe('User-agent: *\nAllow: /\n');
    expect(file(plain, 'llms.txt')).not.toContain('{{');
    // the pointers from the page head are relative, so they hold wherever the page is served
    expect(plain.html).toContain('<link rel="alternate" type="text/markdown" href="setup.md"');
    expect(plain.html).toContain('<link rel="alternate" type="text/plain" href="llms.txt"');
  });

  it('uses the given address for the canonical link, the card, the sitemap and llms.txt', () => {
    expect(placed.html).toContain('<link rel="canonical" href="https://lobstah.dev/" />');
    expect(placed.html).toContain('<meta property="og:url" content="https://lobstah.dev/" />');
    expect(placed.html).toContain('<meta property="og:image" content="https://lobstah.dev/assets/social-card.png" />');
    expect(placed.html).toContain('<meta property="og:image:width" content="1200" />');
    expect(placed.html).toContain('<meta property="og:image:height" content="630" />');
    expect(placed.html).toContain('<meta name="twitter:image" content="https://lobstah.dev/assets/social-card.png" />');
    expect(placed.html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(file(placed, 'robots.txt')).toBe('User-agent: *\nAllow: /\n\nSitemap: https://lobstah.dev/sitemap.xml\n');
    expect([...(file(placed, 'sitemap.xml') ?? '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
      'https://lobstah.dev/',
      'https://lobstah.dev/llms.txt',
      'https://lobstah.dev/setup.md',
    ]);
    expect(file(placed, 'llms.txt')).toContain('- [Agent setup guide](https://lobstah.dev/setup.md): ');
    // a trailing slash or a path is kept tidy; anything that is not a web address is refused
    expect(siteBase('https://lobstah.dev/')).toBe('https://lobstah.dev');
    expect(siteBase('https://example.org/lobstah/')).toBe('https://example.org/lobstah');
    expect(siteBase(undefined)).toBe('');
    expect(() => siteBase('lobstah.dev')).toThrow(/full address/);
    expect(() => siteBase('ftp://lobstah.dev')).toThrow(/http/);
  });

  it('says in its structured data only what the page and the repo already say', () => {
    const data = (html: string) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? 'null');
    const description = plain.html.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(50);
    expect(description.length).toBeLessThanOrEqual(160);
    const [app, ...rest] = data(plain.html)['@graph'];
    expect(rest).toEqual([]);
    expect(app['@type']).toEqual(['SoftwareApplication', 'SoftwareSourceCode']);
    expect(app.description).toBe(description);
    expect(app.url).toBeUndefined();
    // on the page: the platforms and the licence
    const page = visibleText(plain.html);
    expect(page).toContain(`Open source, MIT · ${app.operatingSystem}`);
    expect(app.license).toBe('https://opensource.org/licenses/MIT');
    expect(read('LICENSE')).toMatch(/^MIT License/);
    expect(read('LICENSE')).toContain(app.author.name);
    // in the repo: the Node it needs, where the code is, where it is installed from
    expect(app.softwareRequirements).toBe(`Node.js ${json('package.json').engines.node.replace('>=', '')} or later`);
    expect(app.codeRepository).toBe(json('plugins', 'claude-code', '.claude-plugin', 'plugin.json').repository);
    expect(app.installUrl).toBe(`https://www.npmjs.com/package/${read('scripts', 'build-npm.mjs').match(/name: '([^']+)'/)?.[1]}`);
    expect(app.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'USD' });
    // nothing rated, reviewed or asked-and-answered
    expect(JSON.stringify(data(placed.html))).not.toMatch(/Rating|Review|FAQPage|Question/);
    const [, website] = data(placed.html)['@graph'];
    expect(website).toEqual({ '@type': 'WebSite', name: 'lobstah', url: 'https://lobstah.dev/', description });
  });
});

describe('the social card', () => {
  type Image = { width: number; height: number; channels: number; data: Buffer };
  const at = (image: Image, x: number, y: number) => [
    ...image.data.subarray((y * image.width + x) * image.channels, (y * image.width + x) * image.channels + 3),
  ];
  const png = (...parts: string[]): Image => pngDecode(fs.readFileSync(path.join(repo, ...parts)));

  it('reads and writes PNG pixels without loss', () => {
    const rgb = Buffer.from(Array.from({ length: 5 * 3 * 3 }, (_, i) => (i * 37) % 256));
    const back = pngDecode(pngEncode(5, 3, rgb));
    expect([back.width, back.height, back.channels]).toEqual([5, 3, 3]);
    expect(back.data.equals(rgb)).toBe(true);
    // the repo's own files, which use every kind of row filter between them
    expect(png('docs', 'assets', 'lob-sprite.png')).toMatchObject({ width: 288, height: 56, channels: 4 });
    expect(png('apps', 'site', 'art', 'card', 'tagline.png').channels).toBe(1);
  });

  it("is 1200 by 630, light to load, and made of the glass's own lobster, star and colours", async () => {
    const built = await buildSite({ write: false, siteUrl: 'https://lobstah.dev' });
    expect(built.card.name).toBe('social-card.png');
    expect(built.card.png.length).toBeLessThan(300 * 1024);
    const card: Image = pngDecode(built.card.png);
    expect([card.width, card.height]).toEqual([1200, 630]);

    const css = read('apps', 'cli', 'glass', 'glass.css');
    const [bg, fg, dim] = ['bg', 'fg', 'dim'].map((token) => glassColor(css, token) as number[]);
    for (const [x, y] of [[0, 0], [1199, 0], [0, 629], [1199, 629], [600, 20]]) expect(at(card, x, y)).toEqual(bg); // prettier-ignore
    const colours = new Set<string>();
    for (let i = 0; i < card.data.length; i += 3) colours.add(card.data.subarray(i, i + 3).join(','));
    // the tagline in the glass's text colour, the name in its dim one
    expect(colours.has(fg.join(','))).toBe(true);
    expect(colours.has(dim.join(','))).toBe(true);

    // The lobster is the sprite's first frame, each pixel a six by six square, with nothing redrawn.
    const sprite = png('docs', 'assets', 'lob-sprite.png');
    let left = -1;
    let top = -1;
    const solid: Array<[number, number]> = [];
    for (let y = 0; y < sprite.height; y++)
      for (let x = 0; x < sprite.width / 4; x++) if (sprite.data[(y * sprite.width + x) * 4 + 3] === 255) solid.push([x, y]);
    expect(solid.length).toBeGreaterThan(500);
    // find where the frame's first solid pixel landed, then every other one must follow from it
    const [fx, fy] = solid[0];
    search: for (let y = 0; y < card.height; y++) {
      for (let x = 0; x < card.width; x++) {
        if (at(card, x, y).join() === at(sprite, fx, fy).join()) {
          [left, top] = [x - fx * 6, y - fy * 6];
          break search;
        }
      }
    }
    expect(left).toBeGreaterThan(0);
    for (const [x, y] of solid) {
      expect(at(card, left + x * 6, top + y * 6)).toEqual(at(sprite, x, y));
      expect(at(card, left + x * 6 + 5, top + y * 6 + 5)).toEqual(at(sprite, x, y));
    }
    // The star keeps its place by the lobster: 56 across and 9 up from the lobster's corner, as the glass has it.
    const star = png('docs', 'assets', 'star.png');
    const mid = Math.floor(star.width / 2);
    expect(star.data[(mid * star.width + mid) * 4 + 3]).toBe(255);
    expect(at(card, left + 56 * 6 + mid * 6 + 1, top - 9 * 6 + mid * 6 + 1)).toEqual(at(star, mid, mid));
  });
});

describe('the site on Cloudflare', () => {
  const assets = { fetch: (request: Request) => new Response(`files: ${new URL(request.url).pathname}`) };
  const ask = (url: string): Response => worker.fetch(new Request(url), { ASSETS: assets });

  it('sends www to the bare name, path and query kept, and serves everything else from the files', async () => {
    const moved = ask('https://www.lobstah.dev/setup.md?from=llms');
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('https://lobstah.dev/setup.md?from=llms');
    const served = ask('https://lobstah.dev/llms.txt');
    expect(served.status).toBe(200);
    expect(await served.text()).toBe('files: /llms.txt');
  });

  it('is configured for the same address the build is given, and for the built folder', () => {
    // wrangler.jsonc is JSON with // comments on lines of their own and a comma after a last item
    const config = JSON.parse(
      read('apps', 'site', 'wrangler.jsonc')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1'),
    );
    expect(config.routes).toEqual([
      { pattern: HOME, custom_domain: true },
      { pattern: `www.${HOME}`, custom_domain: true },
    ]);
    expect(config.build.command).toBe(`node ../../scripts/build-site.mjs --site-url https://${HOME}`);
    expect(config.assets).toEqual({ directory: './dist', binding: 'ASSETS', run_worker_first: true });
    expect(config.main).toBe('worker.js');
  });
});
