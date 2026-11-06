import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { askDecision, decisionDir, ensureLayout, fileReport, listRequests, readDecisionAnswer, withdrawDecision } from '@lobstah/core';
import { readChecklist, setChecklistTick } from '../src/checklists.js';
import { markdownTasks, parseMarkdown } from '../../../packages/glass-ui/src/glass-markdown.js';
import { answerKey } from '../src/decision-answer.js';
import { serveGlass } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { emptyFleet, NOW } from './fixtures/glass-snapshots.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let server: Server | undefined;
const markdown = '- [ ] Open **review**\n  - [x] Check `build`\n    - [ ] Read the results\n- [ ] Send summary';
const tasks = (text: string) => markdownTasks(parseMarkdown(text));
const card = () => askDecision({ title: 'Review the work', detailText: markdown, options: ['Ship', 'Wait'], askedBy: 'helm', maxBytes: 10000 }).meta;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-checklists-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '');
});
afterEach(async () => {
  if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; }
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('parses nested tasks in document order, with visible accessible labels, excluding code blocks', () => {
  const tree = parseMarkdown(`${markdown}\n\n\`\`\`\n- [ ] not a task\n\`\`\``);
  expect(markdownTasks(tree).map(({ text, checked, id }) => ({ text, checked, index: id.split('-')[0] }))).toEqual([
    { text: 'Open review', checked: false, index: '0' }, { text: 'Check build', checked: true, index: '1' },
    { text: 'Read the results', checked: false, index: '2' }, { text: 'Send summary', checked: false, index: '3' },
  ]);
  expect(tree[0]).toMatchObject({ t: 'list', items: [[{ t: 'task' }, { t: 'list', items: [[{ t: 'task' }, { t: 'list' }]] }], [{ t: 'task' }]] });
});

it('keeps identity across tick changes but changes it when text or position changes', () => {
  expect(tasks('- [ ] Read results')[0]!.id).toBe(tasks('- [x] Read results')[0]!.id);
  expect(tasks('- [ ] Read results')[0]!.id).not.toBe(tasks('- [ ] Merge results')[0]!.id);
  expect(tasks('- [ ] Repeat\n- [ ] Repeat').map((item) => item.id)).toHaveLength(2);
  expect(new Set(tasks('- [ ] Repeat\n- [ ] Repeat').map((item) => item.id)).size).toBe(2);
});

it('saves true and false overrides on the card without answering or waking the helm', () => {
  const meta = card();
  const items = readChecklist(meta.key).items;
  setChecklistTick(meta.key, items[0]!.id, true);
  setChecklistTick(meta.key, items[1]!.id, false);
  expect(readChecklist(meta.key).items.map((item) => item.checked)).toEqual([true, false, false, false]);
  expect(fs.existsSync(path.join(decisionDir(meta.key)!, 'checklist.json'))).toBe(true);
  expect(readDecisionAnswer(meta.key)).toBeUndefined();
  expect(listRequests()).toEqual([]);
  fs.writeFileSync(path.join(decisionDir(meta.key)!, 'detail.md'), markdown.replace('Open **review**', 'Merge the PR'));
  expect(readChecklist(meta.key).items[0]!.checked).toBe(false);
  expect(() => setChecklistTick(meta.key, items[0]!.id, true)).toThrow('changed');
});

it('persists report ticks and prints their progress through man ask --show', () => {
  const file = path.join(home, 'report.md'); fs.writeFileSync(file, markdown);
  const report = fileReport({ key: 'report:helm:fleet:abcd1234', file, attach: [], fallbackTitle: 'Review', author: 'helm', maxBytes: 10000 });
  setChecklistTick(report.key, readChecklist(report.key).items[0]!.id, true);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CLAUDE') && !key.startsWith('CODEX')));
  const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'man', 'ask', '--show', report.key], { env, cwd: home, encoding: 'utf8', timeout: 20000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain('2/4 checked');
  expect(result.stdout).toContain('- [x] Open review\n- [x] Check build\n- [ ] Read the results');
  expect(readChecklist(report.key).items[0]!.checked).toBe(true);
});

it.each(['answer', 'withdraw'] as const)('retains %s card ticks read-only', (close) => {
  const meta = card(); const item = readChecklist(meta.key).items[0]!;
  setChecklistTick(meta.key, item.id, true);
  if (close === 'answer') answerKey(meta.key, { by: 'glass', option: 'Wait' });
  else withdrawDecision(meta.key);
  expect(readChecklist(meta.key).readOnly).toBe(true);
  expect(readChecklist(meta.key).items[0]!.checked).toBe(true);
  expect(() => setChecklistTick(meta.key, item.id, false)).toThrow('read-only');
});

it('round-trips the guarded glass API across two clients without a decision-answer event', async () => {
  const meta = card(); const item = readChecklist(meta.key).items[0]!;
  server = serveGlass(0); await new Promise<void>((resolve) => server!.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = (await (await fetch(`${base}/data`)).json()).focusToken;
  const post = (payload: unknown, pageToken = token) => fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': pageToken }, body: JSON.stringify({ kind: 'checklist-tick', payload }) });
  expect((await post({ key: meta.key, item: item.id, checked: true }, 'bad')).status).toBe(403);
  expect((await post({ key: meta.key, item: item.id, checked: true })).status).toBe(200);
  const otherClient = await (await fetch(`${base}/api/checklist?key=${encodeURIComponent(meta.key)}`)).json();
  expect(otherClient.items[0].checked).toBe(true);
  expect((await post({ key: meta.key, item: 'stale', checked: true })).status).toBe(409);
  expect(readDecisionAnswer(meta.key)).toBeUndefined(); expect(listRequests()).toEqual([]);
  withdrawDecision(meta.key);
  expect((await (await fetch(`${base}/data/decision/${encodeURIComponent(meta.key)}`)).json()).readOnly).toBe(true);
  expect((await post({ key: meta.key, item: item.id, checked: false })).status).toBe(409);
});

it('renders real labeled checkboxes and reverts an optimistic tick when saving fails', async () => {
  const meta = card(); const fleet = emptyFleet();
  fleet.decisions = [{ ...meta, detail: markdown, attachments: [] }];
  fleet.attention = [{ kind: 'decision', key: meta.key, stateHash: meta.stateHash, id: meta.key, lane: 'work', verb: 'decision', ageSecs: 0, note: meta.title }];
  let finish: ((value: { status: number; body: unknown }) => void) | undefined;
  const page = await loadGlass(GLASS_PAGE, fleet, {
    now: NOW, hash: `#decision/${encodeURIComponent(meta.key)}`,
    get: (url) => url.startsWith('/api/checklist?') ? { status: 200, body: readChecklist(meta.key) } : undefined,
    post: (_url, request) => JSON.parse(request.body).kind === 'checklist-tick' ? new Promise((resolve) => { finish = resolve; }) : { status: 200, body: { ok: true } },
  });
  try {
    const box = page.$('input[aria-label="Open review"]') as HTMLInputElement;
    expect(box.type).toBe('checkbox'); expect(box.disabled).toBe(false); expect(box.checked).toBe(false);
    box.click(); await Promise.resolve();
    expect(box.checked).toBe(true);
    finish!({ status: 500, body: { ok: false, reason: 'Disk unavailable' } });
    await page.settle();
    expect((page.$('input[aria-label="Open review"]') as HTMLInputElement).checked).toBe(false);
    expect(page.$('[role="alert"]')?.textContent).toContain('Disk unavailable');
    expect(page.posts().filter((request) => JSON.parse(request.body).kind === 'decision-answer')).toEqual([]);
  } finally { await page.close(); }
});

it('opens a withdrawn deep link with checked items disabled and no answer controls', async () => {
  const meta = card();
  setChecklistTick(meta.key, readChecklist(meta.key).items[0]!.id, true);
  withdrawDecision(meta.key);
  const fleet = emptyFleet();
  const page = await loadGlass(GLASS_PAGE, fleet, {
    now: NOW, hash: `#decision/${encodeURIComponent(meta.key)}`,
    get: (url) => url.startsWith('/api/checklist?') ? { status: 200, body: readChecklist(meta.key) }
      : url.startsWith('/data/decision/') ? { status: 200, body: { ...meta, detail: markdown, readOnly: true } } : undefined,
  });
  try {
    expect((page.$('input[aria-label="Open review"]') as HTMLInputElement).checked).toBe(true);
    expect((page.$('input[aria-label="Open review"]') as HTMLInputElement).disabled).toBe(true);
    expect(page.$('.dopt')).toBeNull();
    await page.poll();
    expect(page.$('.dtitle')?.textContent).toContain('Review the work');
  } finally { await page.close(); }
});

it('saves report-page ticks with its page token and refreshes another client’s changes', async () => {
  const file = path.join(home, 'report.md'); fs.writeFileSync(file, '- [ ] Inspect the report');
  const report = fileReport({ key: 'report:helm:fleet:1234abcd', file, attach: [], fallbackTitle: 'Inspection', author: 'helm', maxBytes: 10000 });
  const encoded = encodeURIComponent(report.key);
  const page = await loadGlass(GLASS_PAGE, emptyFleet(), {
    now: NOW, path: `/report/${encoded}`, reportToken: 'report-page-token',
    files: { [`/report/${encoded}/meta`]: JSON.stringify(report), [`/report/${encoded}/md`]: '- [ ] Inspect the report' },
    get: (url) => url.startsWith('/api/checklist?') ? { status: 200, body: readChecklist(report.key) } : undefined,
    post: (_url, request) => {
      const body = JSON.parse(request.body);
      if (body.kind === 'checklist-tick') {
        expect(request.headers['x-lobstah-token']).toBe('report-page-token');
        expect(body.payload.key).toBe(report.key);
        return { status: 200, body: { ok: true, ...setChecklistTick(report.key, body.payload.item, body.payload.checked) } };
      }
      return { status: 200, body: { ok: true } };
    },
  });
  try {
    (page.$('input[aria-label="Inspect the report"]') as HTMLInputElement).click();
    await page.settle();
    expect(readChecklist(report.key).items[0]!.checked).toBe(true);
    setChecklistTick(report.key, readChecklist(report.key).items[0]!.id, false);
    await page.poll();
    expect((page.$('input[aria-label="Inspect the report"]') as HTMLInputElement).checked).toBe(false);
  } finally { await page.close(); }
});

it('does not apply a late save response to a different card with the same task text', async () => {
  const first = card(); const second = card(); const fleet = emptyFleet();
  fleet.decisions = [first, second].map((meta) => ({ ...meta, detail: markdown, attachments: [] }));
  fleet.attention = [first, second].map((meta) => ({ kind: 'decision' as const, key: meta.key, stateHash: meta.stateHash, id: meta.key, lane: 'work' as const, verb: 'decision', ageSecs: 0, note: meta.title }));
  let finish: ((value: { status: number; body: unknown }) => void) | undefined;
  const page = await loadGlass(GLASS_PAGE, fleet, {
    now: NOW, hash: `#decision/${encodeURIComponent(first.key)}`,
    get: (url) => url.startsWith('/api/checklist?') ? { status: 200, body: readChecklist(new URL(url, 'http://localhost').searchParams.get('key')!) } : undefined,
    post: (_url, request) => JSON.parse(request.body).kind === 'checklist-tick' ? new Promise((resolve) => { finish = resolve; }) : { status: 200, body: { ok: true } },
  });
  try {
    (page.$('input[aria-label="Open review"]') as HTMLInputElement).click();
    await Promise.resolve();
    await page.go(`#decision/${encodeURIComponent(second.key)}`);
    const stored = setChecklistTick(first.key, readChecklist(first.key).items[0]!.id, true);
    finish!({ status: 200, body: { ok: true, ...stored } });
    await page.settle();
    expect((page.$('input[aria-label="Open review"]') as HTMLInputElement).checked).toBe(false);
  } finally { await page.close(); }
});


it('bundles the shared Markdown renderer before core build artifacts exist', async () => {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../../../packages/glass-ui/ui/components/markdown.ts', import.meta.url))],
    bundle: true, write: false, platform: 'browser', format: 'esm',
    plugins: [{ name: 'no-built-core', setup(bundler) {
      bundler.onResolve({ filter: /^@lobstah\/core(?:\/|$)/ }, () => ({ errors: [{ text: 'Shared Markdown must not depend on core build artifacts; wharf builds alongside core.' }] }));
    } }],
  });
  expect(result.outputFiles[0]!.text).toContain('MarkdownElements');
});


it('typechecks wharf glass without compiled core declarations', async () => {
  const ts = (await import('typescript')).default;
  const configPath = fileURLToPath(new URL('../../../services/wharf/glass/tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  const exists = host.fileExists.bind(host);
  const read = host.readFile.bind(host);
  const coreArtifact = (file: string): boolean => file.replaceAll('\\', '/').includes('/packages/core/dist/');
  host.fileExists = (file) => !coreArtifact(file) && exists(file);
  host.readFile = (file) => coreArtifact(file) ? undefined : read(file);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([]);
});
