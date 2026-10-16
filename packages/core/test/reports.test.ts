import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  briefTitle,
  dispatchReportKey,
  ensureLayout,
  fileReport,
  helmReportsRoot,
  laneDirs,
  listReports,
  markdownTitle,
  newHelmReportKey,
  readReport,
  readReportMarkdown,
  removeHelmReport,
  ReportError,
  reportDir,
  resolveReportFile,
  rewriteImageLinks,
  unattachedImages,
} from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let src: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-reports-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  src = path.join(home, 'src');
  fs.mkdirSync(src);
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

const ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const write = (name: string, body: string | Buffer) => {
  const file = path.join(src, name);
  fs.writeFileSync(file, body);
  return file;
};
const base = { fallbackTitle: 'brief title', author: 'headless', maxBytes: 1024 };

describe('a dispatch report', () => {
  it('copies the file into the state directory beside attachments, with the first # heading as its title', () => {
    const key = dispatchReportKey(ID, 'work');
    const meta = fileReport({ ...base, key, file: write('r.md', '```\n# not this\n```\n## sub\n# Tray findings\n\nbody\n'), dispatch: ID, lane: 'work' });
    const dir = path.join(laneDirs('work').state, ID);
    expect(reportDir(key)).toBe(dir);
    expect(fs.readFileSync(path.join(dir, 'report.md'), 'utf8')).toContain('# Tray findings');
    expect(meta).toMatchObject({ key, title: 'Tray findings', author: 'headless', dispatch: ID, lane: 'work' });
    expect(readReport(key)).toEqual(meta);
    expect(readReportMarkdown(key)).toContain('body');
  });

  it("without a # heading, the title is the dispatch's brief title", () => {
    const meta = fileReport({ ...base, key: dispatchReportKey(ID, 'work'), file: write('r.md', 'just text\n') });
    expect(meta.title).toBe('brief title');
    expect(briefTitle('# Research trays\n\nDo it.')).toBe('Research trays');
    expect(briefTitle('\n  Fix the build  \nmore')).toBe('Fix the build');
    expect(markdownTitle('no heading')).toBeUndefined();
  });

  it('refuses an oversized file and leaves nothing behind', () => {
    const key = dispatchReportKey(ID, 'work');
    expect(() => fileReport({ ...base, key, file: write('big.md', 'x'.repeat(2048)) })).toThrow(ReportError);
    expect(() => fileReport({ ...base, key, file: write('r.md', '# ok'), attach: [write('big.png', Buffer.alloc(2048))] })).toThrow(/exceeds 1024 bytes/);
    expect(() => fileReport({ ...base, key, file: path.join(src, 'missing.md') })).toThrow(/does not exist/);
    expect(readReport(key)).toBeUndefined();
    expect(fs.existsSync(path.join(laneDirs('work').state, ID, 'report.md'))).toBe(false);
    expect(fs.existsSync(path.join(laneDirs('work').state, ID, 'attachments', 'big.png'))).toBe(false);
  });

  it("an image named by bare filename resolves to the report's attachments directory, and nothing else does", () => {
    const key = dispatchReportKey(ID, 'work');
    // A brief attachment already holds tray.png: the report's copy is renamed.
    const attachments = path.join(laneDirs('work').state, ID, 'attachments');
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(attachments, 'tray.png'), 'BRIEF');
    fs.writeFileSync(path.join(home, 'secret.png'), 'SECRET');
    fileReport({ ...base, key, file: write('r.md', '![tray](tray.png)'), attach: [write('tray.png', 'REPORT')] });
    const resolved = resolveReportFile(key, 'tray.png')!;
    expect(path.dirname(resolved)).toBe(attachments);
    expect(fs.readFileSync(resolved, 'utf8')).toBe('REPORT');
    for (const name of ['../secret.png', '..', path.join(home, 'secret.png'), 'secret.png', 'sub/tray.png', 'sub\\tray.png', '']) {
      expect(resolveReportFile(key, name), name).toBeUndefined();
    }
  });
});

describe('a helm report', () => {
  it('is stored under the grounds with the same layout, author helm', () => {
    const key = newHelmReportKey('fleet');
    expect(key).toMatch(/^report:helm:fleet:[a-f0-9]{8}$/);
    const meta = fileReport({ ...base, key, file: write('h.md', 'notes'), title: 'Fleet notes', author: 'helm', grounds: 'fleet', attach: [write('chart.png', 'PNG')] });
    const dir = reportDir(key)!;
    expect(path.dirname(path.dirname(dir))).toBe(helmReportsRoot());
    expect(path.basename(path.dirname(dir))).toBe('fleet');
    expect(fs.existsSync(path.join(dir, 'report.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'attachments', 'chart.png'))).toBe(true);
    expect(meta).toMatchObject({ title: 'Fleet notes', author: 'helm', grounds: 'fleet' });
    expect(() => newHelmReportKey('../x')).toThrow(ReportError);
    expect(reportDir('report:helm:..:00000000')).toBeUndefined();
    expect(reportDir('report:work:../x')).toBeUndefined();
  });

  it('lists every report newest first; removeHelmReport deletes a helm report', () => {
    const older = fileReport({ ...base, key: dispatchReportKey(ID, 'work'), file: write('a.md', '# A'), now: new Date('2026-09-01T00:00:00Z') });
    const key = newHelmReportKey('fleet');
    fileReport({ ...base, key, file: write('b.md', '# B'), author: 'helm', grounds: 'fleet', now: new Date('2026-09-02T00:00:00Z') });
    expect(listReports().map((r) => r.title)).toEqual(['B', 'A']);
    removeHelmReport(key);
    removeHelmReport(older.key); // a dispatch report goes with its state, not here
    expect(listReports().map((r) => r.key)).toEqual([older.key]);
  });
});

describe('images in folders under the page', () => {
  const shot = (rel: string, body = 'IMG') => {
    const file = path.join(src, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  };
  const key = () => dispatchReportKey(ID, 'work');

  it('attaches an image the page links by a path under its directory, and links it by its stored name', () => {
    const page = write('r.md', '# Walk\n\n![one](walkthrough-shots/01.jpg)\n![tray](tray.png)\n');
    const meta = fileReport({ ...base, key: key(), file: page, attach: [shot('walkthrough-shots/01.jpg'), write('tray.png', 'PNG')] });
    expect(meta.attachments.map((a) => a.name)).toEqual(['01.jpg', 'tray.png']);
    expect(readReportMarkdown(key())).toBe('# Walk\n\n![one](01.jpg)\n![tray](tray.png)\n');
    expect(resolveReportFile(key(), '01.jpg')).toBe(path.join(laneDirs('work').state, ID, 'attachments', '01.jpg'));
    expect(unattachedImages(readReportMarkdown(key())!, meta)).toEqual([]);
  });

  it('takes an --attach path from the page directory when the working directory has none', () => {
    shot('shots/a b.png');
    const page = write('r.md', '![a](shots/a%20b.png)\n');
    expect(fs.existsSync('shots')).toBe(false);
    const meta = fileReport({ ...base, key: key(), file: page, attach: ['shots/a b.png'] });
    expect(meta.attachments.map((a) => a.name)).toEqual(['a b.png']);
    expect(readReportMarkdown(key())).toBe('![a](<a b.png>)\n');
  });

  it('gives two folders\' images of one name distinct stored names, each link reaching its own', () => {
    const page = write('r.md', '![a](a/01.png) ![b](b/01.png)\n');
    shot('a/01.png', 'IMG0');
    shot('b/01.png', 'IMG1');
    const meta = fileReport({ ...base, key: key(), file: page, attachDirs: [path.join(src, 'a'), path.join(src, 'b')] });
    expect(meta.attachments.map((a) => a.name)).toEqual(['01.png', '01-2.png']);
    expect(readReportMarkdown(key())).toBe('![a](01.png) ![b](01-2.png)\n');
    expect(meta.renamed?.['01.png']).toBeUndefined();
    expect(fs.readFileSync(resolveReportFile(key(), '01-2.png')!, 'utf8')).toBe('IMG1');
  });

  it('--attach-dir takes every image directly in the folder, and nothing else', () => {
    shot('shots/02.png');
    shot('shots/01.jpg');
    shot('shots/notes.txt');
    shot('shots/deeper/03.png');
    const meta = fileReport({ ...base, key: key(), file: write('r.md', '![](shots/01.jpg)'), attachDirs: [path.join(src, 'shots')] });
    expect(meta.attachments.map((a) => a.name)).toEqual(['01.jpg', '02.png']);
  });

  it('refuses paths out of the page directory, and files nothing', () => {
    const page = shot('pages/r.md', '![x](../out.png)');
    shot('out.png');
    shot('pages/empty/.keep');
    const refused = (opts: { attach?: string[]; attachDirs?: string[] }, pattern: RegExp) => {
      expect(() => fileReport({ ...base, key: key(), file: page, ...opts })).toThrow(ReportError);
      expect(() => fileReport({ ...base, key: key(), file: page, ...opts })).toThrow(pattern);
    };
    expect(fs.existsSync('../out.png')).toBe(false);
    refused({ attach: ['../out.png'] }, /--attach \.\.\/out\.png: not under the page's directory/);
    refused({ attachDirs: [src] }, /not under the page's directory/);
    refused({ attachDirs: [path.join(src, 'pages', 'empty')] }, /no images/);
    refused({ attachDirs: [path.join(src, 'pages', 'nowhere')] }, /no such directory/);
    expect(readReport(key())).toBeUndefined();
  });

  it('keeps a link out of the tree as written, and reports it with unattached ones', () => {
    const page = shot('pages/r.md', '![x](../out.png) ![y](missing.png) ![z](https://example.com/z.png) ![w](sub/w.png)\n');
    const meta = fileReport({ ...base, key: key(), file: page, attach: [shot('out.png')] });
    const filed = readReportMarkdown(key())!;
    expect(filed).toContain('![x](../out.png)');
    expect(unattachedImages(filed, meta)).toEqual(['../out.png', 'missing.png', 'sub/w.png']);
  });
});

describe('rewriteImageLinks', () => {
  it('rewrites image targets outside code, keeps titles and plain links', () => {
    const md = '![a](s/1.png "one") [link](s/1.png)\n`![c](s/1.png)`\n```\n![d](s/1.png)\n```\n![e](<s/2 x.png>)\n';
    const out = rewriteImageLinks(md, (t) => ({ 's/1.png': '1.png', 's/2 x.png': '2 x.png' })[t]);
    expect(out).toBe('![a](1.png "one") [link](s/1.png)\n`![c](s/1.png)`\n```\n![d](s/1.png)\n```\n![e](<2 x.png>)\n');
  });
});
