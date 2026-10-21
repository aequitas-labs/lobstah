import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { consumeHelmChatChange, ensureLayout, helmChat, heartbeatHelm, loadConfig, readHelm, readSessionWatcher, setHelmChat, takeHelm, enqueue } from '@lobstah/core';
import { charter, CHAT_BRIEF_RULE } from '../src/charter.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass, type GlassDom } from './glass-dom.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'chat-helm';
let home: string;
let server: Server | undefined;
let page: GlassDom | undefined;
const environment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CODEX|CLAUDE)/.test(k))), LOBSTAH_HOME: home });
const run = (args: string[], input?: Record<string, unknown>) => spawnSync(process.execPath, [cli, ...args], {
  cwd: home, env: environment(), encoding: 'utf8', timeout: 10_000,
  input: input ? JSON.stringify({ session_id: session, cwd: home, ...input }) : undefined,
});
const seat = (grounds = 'fleet', id = session) => takeHelm({ sessionId: id, grounds: { name: grounds, repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'codex' } });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-helm-chat-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.mkdirSync(path.join(home, 'web'));
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = ${JSON.stringify(path.join(home, 'web'))}\ntrunk = "main"\n`);
});
afterEach(async () => {
  await page?.close(); page = undefined;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

it('defaults to full, accepts brief config and rejects other values', () => {
  expect(loadConfig().helm.chat).toBe('full');
  expect(charter({ name: 'fleet', repos: ['web'] })).not.toContain(CHAT_BRIEF_RULE);
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[helm]\nchat = "brief"\n');
  expect(loadConfig().helm.chat).toBe('brief');
  seat();
  expect(helmChat(readHelm('fleet'))).toBe('brief');
  expect(charter({ name: 'fleet', repos: ['web'] })).toContain(CHAT_BRIEF_RULE);
  fs.appendFileSync(path.join(home, 'config.toml'), '\n');
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\nchat = "quiet"\n');
  expect(() => loadConfig()).toThrow('[helm].chat');
});

it('CLI toggles persist across processes, heartbeat, re-sign and takeover, scoped to the seat', () => {
  const signed = run(['man', 'helm', '--session', session]);
  expect(signed.status, signed.stderr).toBe(0);
  expect(signed.stdout).not.toContain(CHAT_BRIEF_RULE);
  seat('other', 'other-helm');
  const result = run(['man', 'chat', 'brief', '--session', session]);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('chat: brief');
  expect(readHelm('fleet')?.chat).toBe('brief');
  expect(helmChat(readHelm('other'))).toBe('full');
  heartbeatHelm(session);
  expect(run(['man', 'helm', '--session', session]).stdout).toContain(CHAT_BRIEF_RULE);
  expect(readHelm('fleet')?.chat).toBe('brief');
  takeHelm({ sessionId: 'replacement', grounds: { name: 'fleet', repos: ['web'] }, take: true, ttlMs: 60_000 });
  expect(readHelm('fleet')?.chat).toBe('brief');
  // A real terminal has no harness identity and may switch its grounds' seat.
  expect(run(['man', 'chat', 'full']).status).toBe(0);
  expect(readHelm('fleet')?.chat).toBe('full');
  expect(run(['man', 'chat', 'quiet']).status).toBe(2);
  expect(run(['man', 'chat', 'brief', 'extra']).status).toBe(2);
});

it('brief reaches charter, SessionStart, prompt, wait next hints and Stop; full has no brief rule', () => {
  seat();
  setHelmChat('fleet', 'brief');
  expect(charter({ name: 'fleet', repos: ['web'] })).toContain(CHAT_BRIEF_RULE);
  expect(run(['man', 'brief'], { hook_event_name: 'SessionStart' }).stdout).toContain(CHAT_BRIEF_RULE);
  expect(run(['hook', 'user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'What changed?' }).stdout).toContain(CHAT_BRIEF_RULE);
  expect(run(['man', 'wait', '--session', session, '--peek']).stdout).toContain(`next: ${CHAT_BRIEF_RULE}`);
  setHelmChat('fleet', 'full');
  const fullStop = run(['hook', 'stop'], { hook_event_name: 'Stop' });
  expect(JSON.parse(fullStop.stdout).reason).toContain('Helm chat: full');
  expect(fullStop.stdout).not.toContain(CHAT_BRIEF_RULE);
  expect(charter({ name: 'fleet', repos: ['web'] })).not.toContain(CHAT_BRIEF_RULE);
  expect(run(['man', 'brief'], { hook_event_name: 'SessionStart' }).stdout).not.toContain(CHAT_BRIEF_RULE);
  const fullPrompt = run(['hook', 'user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'Answer directly' });
  expect(fullPrompt.stdout).not.toMatch(/Chat brief|Helm chat:/);
  expect(run(['man', 'wait', '--session', session, '--peek']).stdout).not.toContain('Chat brief');
  setHelmChat('fleet', 'brief');
  expect(JSON.parse(run(['hook', 'stop'], { hook_event_name: 'Stop' }).stdout).reason).toContain(CHAT_BRIEF_RULE);
  setHelmChat('fleet', 'full');
  expect(run(['hook', 'user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'Direct question' }).stdout).toContain('Helm chat: full');
  expect(run(['hook', 'user-prompt-submit'], { hook_event_name: 'UserPromptSubmit', prompt: 'Next question' }).stdout).not.toMatch(/Chat brief|Helm chat:/);
});

it('a toggle wakes an already parked man wait and leaves fleet events untouched', async () => {
  seat();
  const child = spawn(process.execPath, [cli, 'man', 'wait', '--session', session, '--timeout', '10'], { cwd: home, env: environment() });
  let output = ''; let error = '';
  child.stdout.on('data', (b) => output += b); child.stderr.on('data', (b) => error += b);
  const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
  try {
    for (let i = 0; i < 100 && !readSessionWatcher(session); i++) await new Promise((r) => setTimeout(r, 30));
    expect(readSessionWatcher(session)).toBeDefined();
    setHelmChat('fleet', 'brief');
    expect(await exit, error).toBe(0);
    expect(output).toContain('event: helm-chat');
    expect(output).toContain(`next: ${CHAT_BRIEF_RULE}`);
    expect(consumeHelmChatChange('fleet')).toBeUndefined();
  } finally { if (child.exitCode === null) child.kill(); }
}, 15_000);

it('a toggle wakes an already blocking Stop hook, including the return to full', async () => {
  seat();
  // Queued work keeps the real Codex-style Stop hook parked even with no event standing.
  enqueue({ id: 'queued-chat-fixture', repo: 'web', brief: 'fixture' });
  for (const chat of ['brief', 'full'] as const) {
    const before = readHelm('fleet')?.parkedAt;
    const child = spawn(process.execPath, [cli, 'hook', 'stop'], { cwd: home, env: environment() });
    child.stdin.end(JSON.stringify({ session_id: session, cwd: home, hook_event_name: 'Stop' }));
    let output = '';
    child.stdout.on('data', (b) => output += b);
    const exit = new Promise<number | null>((resolve) => child.once('close', resolve));
    try {
      for (let i = 0; i < 150 && readHelm('fleet')?.parkedAt === before; i++) await new Promise((r) => setTimeout(r, 30));
      expect(readHelm('fleet')?.parkedAt).not.toBe(before);
      setHelmChat('fleet', chat);
      expect(await exit).toBe(0);
      expect(JSON.parse(output).reason).toContain(`Helm chat: ${chat}`);
      expect(output.includes(CHAT_BRIEF_RULE)).toBe(chat === 'brief');
    } finally { if (child.exitCode === null) child.kill(); }
  }
}, 15_000);

it('an agent cannot change another grounds while a terminal user can select one', () => {
  fs.writeFileSync(path.join(home, 'config.toml'), '[grounds.alpha]\nrepos = []\n[grounds.beta]\nrepos = []\n');
  seat('alpha'); seat('beta', 'beta-helm');
  const denied = run(['man', 'chat', 'brief', '--session', session, '--grounds', 'beta']);
  expect(denied.status).not.toBe(0);
  expect(readHelm('beta')?.chat).toBeUndefined();
  expect(run(['man', 'chat', 'brief', '--grounds', 'beta']).status).toBe(0);
  expect(readHelm('beta')?.chat).toBe('brief');
  expect(helmChat(readHelm('alpha'))).toBe('full');
});

it('tend and glass expose the effective mode for legacy seats', () => {
  seat();
  expect(buildTendReport().helms[0]?.chat).toBe('full');
  expect(buildGlassSnapshot().helms[0]?.chat).toBe('full');
  setHelmChat('fleet', 'brief');
  expect(renderTend(buildTendReport())).toContain('chat: brief');
  expect(buildGlassSnapshot().helms[0]?.chat).toBe('brief');
});

it('concurrent heartbeat and worker observations preserve the last toggle', async () => {
  seat();
  const core = new URL('../../../packages/core/dist/index.js', import.meta.url).href;
  const scripts = [
    'for (let i = 0; i < 120; i++) heartbeatHelm("chat-helm", { parked: true });',
    'for (let i = 0; i < 120; i++) updateHelmWorker("chat-helm", { model: "test-model", observedAt: new Date().toISOString() });',
    'for (let i = 0; i < 120; i++) setHelmChat("fleet", i % 2 === 0 ? "full" : "brief");',
  ];
  const children = scripts.map((script) => spawn(process.execPath, ['--input-type=module', '-e', `import { heartbeatHelm, updateHelmWorker, setHelmChat } from ${JSON.stringify(core)}; ${script}`], { env: environment() }));
  try {
    const outcomes = await Promise.all(children.map((child) => new Promise<{ code: number | null; error: string }>((resolve) => {
      let error = ''; child.stderr.on('data', (b) => error += b);
      child.once('close', (code) => resolve({ code, error }));
    })));
    for (const outcome of outcomes) expect(outcome.code, outcome.error).toBe(0);
    expect(readHelm('fleet')).toMatchObject({ chat: 'brief', chatPending: 'brief', model: 'test-model' });
    expect(readHelm('fleet')?.parkedAt).toBeDefined();
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
});

it('glass settings switch round-trips through the real authenticated API and refreshes the chip', async () => {
  seat();
  server = serveGlass(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const snapshot = async () => (await (await fetch(`${base}/data`)).json());
  const initial = await snapshot();
  page = await loadGlass(GLASS_PAGE, initial, { now: Date.now(), post: async (url, init) => {
    const response = await fetch(base + url, { method: 'POST', headers: { ...init.headers, Origin: base }, body: init.body });
    const body = await response.json();
    page!.serve(await snapshot());
    return { status: response.status, body };
  } });
  (page.$('#gearbtn') as HTMLElement).click(); await page.settle();
  for (const chat of ['brief', 'full']) {
    const button = page.$$('[data-helm-chat="home"] button').find((b) => b.textContent === chat)!;
    expect(button).toBeTruthy(); (button as HTMLElement).click(); await page.settle();
    expect(readHelm('fleet')?.chat).toBe(chat);
    expect(page.$('[data-helm-chat="home"] button.on')?.textContent).toBe(chat);
    expect(page.$('#chips')?.textContent).toContain(`chat ${chat}`);
  }
  expect(page.posts().filter((p) => p.url === '/requests').map((p) => JSON.parse(p.body))).toEqual([
    { kind: 'helm-chat', payload: { grounds: 'home', chat: 'brief' } },
    { kind: 'helm-chat', payload: { grounds: 'home', chat: 'full' } },
  ]);
  expect(page.window.localStorage.getItem('spyglass') ?? '').not.toContain('chat');
  const bad = await fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': initial.focusToken }, body: JSON.stringify({ kind: 'helm-chat', payload: { grounds: 'home', chat: 'quiet' } }) });
  expect(bad.status).toBe(400);
  const unauthorized = await fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'helm-chat', payload: { grounds: 'home', chat: 'brief' } }) });
  expect(unauthorized.status).toBe(403);
  expect(readHelm('fleet')?.chat).toBe('full');
});
