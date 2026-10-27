import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { askDecision, ensureLayout, listNotices, readDecision, readDecisionAnswer, standingDecisions, takeHelm, type PermissionRuleChange } from '@lobstah/core';
import { answerKey } from '../src/decision-answer.js';
import { buildGlassSnapshot, serveGlass } from '../src/glass.js';
import { answerPermissionsProposal, proposePermissions } from '../src/permission-proposals.js';
import { editPermissionConfig } from '../src/permission-proposal-config.js';
import { proposalTitle } from '../src/permission-proposal-rules.js';
import { RULES_HEADER } from '../src/codex-permissions.js';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let root: string, home: string, codex: string, claude: string, config: string, original: string, server: Server | undefined, base: string, token: string;
const input = (allow: string[] = ['gh pr edit']) => ({ reason: 'Routine review updates', codexAllow: allow, codexRemove: [], claudeAllow: [], claudeRemove: [] });
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, LOBSTAH_HOME: home, CODEX_HOME: codex, CLAUDE_CONFIG_DIR: claude } });
const post = (kind: string, payload: unknown, authorized = true) => fetch(`${base}/requests`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { Origin: base, 'x-lobstah-token': token } : {}) }, body: JSON.stringify({ kind, payload }),
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-proposals-'));
  home = path.join(root, 'lobstah'); codex = path.join(root, 'codex'); claude = path.join(root, 'claude');
  process.env.LOBSTAH_HOME = home; process.env.CODEX_HOME = codex; process.env.CLAUDE_CONFIG_DIR = claude;
  ensureLayout(); fs.mkdirSync(path.join(codex, 'rules'), { recursive: true }); fs.mkdirSync(claude);
  original = '# Keep the config comment\n[permissions] # Claude rules\nallow = [\n  "Bash(git status *)", # Keep this comment too\n]\n[permissions.codex]\nallow = [["git", "status"]] # Keep Codex formatting\n[unrelated]\nvalue = "keep"\n';
  config = path.join(home, 'config.toml'); fs.writeFileSync(config, original);
  fs.writeFileSync(path.join(claude, 'settings.json'), '{"model":"keep"}\n');
  fs.writeFileSync(path.join(codex, 'config.toml'), '# Keep Codex settings\nmodel = "keep"\n');
  fs.writeFileSync(path.join(codex, 'rules/lobstah.rules'), `${RULES_HEADER} old fixture\n`);
  takeHelm({ sessionId: 'helm', grounds: { name: 'fleet', repos: [] }, ttlMs: 60_000 });
  server = serveGlass(0); await new Promise<void>((resolve) => server!.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  token = (await (await fetch(`${base}/data`)).json()).focusToken;
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  delete process.env.LOBSTAH_HOME; delete process.env.CODEX_HOME; delete process.env.CLAUDE_CONFIG_DIR;
  removeTempDir(root);
});

it('CLI proposes, then the dedicated glass approval applies both profiles and backs up all existing files', async () => {
  const result = run('permissions', 'propose', '--session', 'helm', '--reason', 'Routine review updates', '--codex-allow', 'gh pr edit', '--claude-allow', 'Bash(pnpm exec eslint *)');
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toMatch(/\[card\]\(http:\/\/127\.0\.0\.1:\d+\/#decision\//);
  const decision = standingDecisions()[0]!;
  expect(fs.readFileSync(config, 'utf8')).toBe(original);
  const proposal = decision.permissionsProposal!;
  expect(proposal.diff).toContain('+ permissions.codex.allow:');
  expect(proposal.targets).toContain(path.join(codex, 'rules/lobstah.rules'));
  const response = await post('permissions-proposal-answer', { key: decision.key, option: 'Approve', selected: proposal.rules.map((rule) => rule.id), diffHash: proposal.diffHash });
  expect(response.status, await response.text()).toBe(201);
  const changed = fs.readFileSync(config, 'utf8');
  expect(changed).toContain('# Keep this comment too'); expect(changed).toContain('# Keep Codex formatting');
  expect((parse(changed).permissions as { codex: { allow: string[][] } }).codex.allow).toContainEqual(['gh', 'pr', 'edit']);
  expect(fs.readFileSync(path.join(codex, 'rules/lobstah.rules'), 'utf8')).toContain('pattern = ["gh", "pr", "edit"]');
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  expect(settings.model).toBe('keep'); expect(settings.permissions.allow).toContain('Bash(pnpm exec eslint *)');
  const backups = fs.readdirSync(path.join(home, 'backups')).map((file) => fs.readFileSync(path.join(home, 'backups', file), 'utf8'));
  expect(backups).toContain(original); expect(backups).toContain('{"model":"keep"}\n');
  expect(backups).toContain('# Keep Codex settings\nmodel = "keep"\n'); expect(backups).toContain(`${RULES_HEADER} old fixture\n`);
  expect(readDecisionAnswer(decision.key)?.text).toContain('Applied permission changes');
  expect(listNotices(20).some((notice) => notice.kind === 'decision-answer')).toBe(true);
});

it('rejects forbidden and broad additions before filing a card', () => {
  for (const prefix of ['lobstah grant', 'lobstah trap grant', 'lobstah trap bypass', 'lobstah permissions apply', 'lobstah permissions remove', 'lobstah --session helm', 'lobstah permissions --yes', 'lobstah trap --session helm', 'lobstah', 'python', 'python3', 'python3.11', 'node', 'nodejs', 'node -e', 'bash -lc', 'sh', 'zsh', 'npx', 'pnpm', 'pnpm run', 'pnpm exec', 'sudo', 'rm', 'curl', 'kill', 'env gh pr edit', 'TOKEN=x gh pr edit', 'pnpm exec lobstah grant']) {
    expect(() => proposePermissions(input([prefix]), 'helm'), prefix).toThrow();
    expect(standingDecisions()).toEqual([]);
  }
  const cfg = fs.readFileSync(config, 'utf8').replace('allow = [["git", "status"]]', 'forbidden = [["gh", "pr", "edit"]]\nallow = [["git", "status"]]'); fs.writeFileSync(config, cfg);
  expect(() => proposePermissions(input(), 'helm')).toThrow('forbidden');
  expect(() => proposePermissions({ ...input([]), claudeAllow: ['Bash(lobstah permissions apply *)'] }, 'helm')).toThrow('forbidden');
  expect(standingDecisions()).toEqual([]);
});

it('only the helm may propose and duplicates are skipped with a note, or refused when nothing remains', () => {
  expect(() => proposePermissions(input(), 'trap')).toThrow('ask the helm');
  expect(() => proposePermissions(input(), undefined)).toThrow('ask the helm');
  expect(() => proposePermissions({ ...input(), reason: '' }, 'helm')).toThrow('--reason');
  expect(() => proposePermissions(input(['git status']), 'helm')).toThrow('No permission changes');
  const result = proposePermissions(input(['git status', 'gh pr edit']), 'helm');
  expect(result.notes).toHaveLength(1); expect(result.meta.permissionsProposal?.rules).toHaveLength(1);
  expect(run('permissions', 'propose', '--session', 'trap', '--reason', 'x', '--codex-allow', 'pnpm exec eslint').status).not.toBe(0);
});

it('refuses CLI/man answer, send and generic decision-answer routes, while an ordinary ask cannot become a proposal', async () => {
  const { meta } = proposePermissions(input(), 'helm');
  expect(() => answerKey(meta.key, { option: 'Approve', by: 'cli' })).toThrow('dedicated glass action');
  expect(run('man', 'answer', meta.key, '--option', 'Approve').status).not.toBe(0);
  expect(run('send', meta.key, 'Approve', '--session', 'helm').status).not.toBe(0);
  expect((await post('decision-answer', { key: meta.key, option: 'Approve' })).status).toBe(403);
  expect((await post('permissions-proposal-answer', { key: meta.key, option: 'Approve' }, false)).status).toBe(403);
  const ordinary = askDecision({ title: 'Permissions proposal', options: ['Approve'], askedBy: 'helm', maxBytes: 1024 }).meta;
  expect((await post('permissions-proposal-answer', { key: ordinary.key, option: 'Approve' })).status).toBe(404);
  expect(fs.readFileSync(config, 'utf8')).toBe(original); expect(readDecisionAnswer(meta.key)).toBeUndefined();
});

it('Reject records the result without changing config or either profile', async () => {
  const { meta } = proposePermissions(input(), 'helm');
  const response = await post('permissions-proposal-answer', { key: meta.key, option: 'Reject' });
  expect(response.status).toBe(201);
  expect(fs.readFileSync(config, 'utf8')).toBe(original);
  expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe('{"model":"keep"}\n');
  expect(fs.readFileSync(path.join(codex, 'rules/lobstah.rules'), 'utf8')).toBe(`${RULES_HEADER} old fixture\n`);
  expect(readDecisionAnswer(meta.key)?.option).toBe('Reject');
});

it('Edit can untick rules, requires a matching preview, and refuses settings changed since review', async () => {
  const { meta } = proposePermissions(input(['gh pr edit', 'pnpm exec eslint']), 'helm');
  const selected = [meta.permissionsProposal!.rules[1]!.id];
  const preview = await (await post('permissions-proposal-preview', { key: meta.key, selected })).json();
  expect(preview.ok).toBe(true);
  expect((await post('permissions-proposal-answer', { key: meta.key, option: 'Approve', selected, diffHash: 'wrong' })).status).toBe(409);
  const response = await post('permissions-proposal-answer', { key: meta.key, option: 'Approve', selected, diffHash: preview.diffHash });
  expect(response.status, await response.text()).toBe(201);
  const allow = ((parse(fs.readFileSync(config, 'utf8')).permissions as { codex: { allow: string[][] } }).codex.allow);
  expect(allow).toContainEqual(['pnpm', 'exec', 'eslint']); expect(allow).not.toContainEqual(['gh', 'pr', 'edit']);
  const next = proposePermissions(input(['gh pr edit']), 'helm').meta;
  fs.appendFileSync(config, '\n# Someone edited the config\n');
  expect((await post('permissions-proposal-answer', { key: next.key, option: 'Approve', selected: next.permissionsProposal!.rules.map((rule) => rule.id), diffHash: next.permissionsProposal!.diffHash })).status).toBe(409);
  expect(readDecisionAnswer(next.key)).toBeUndefined();
});

it('titles a proposal by what it changes', () => {
  const add = (id: string, rule: PermissionRuleChange['rule'], harness: 'codex' | 'claude' = 'codex'): PermissionRuleChange => ({ id, harness, action: 'add', rule } as PermissionRuleChange);
  expect(proposalTitle([add('a', ['gh', 'pr', 'edit']), add('b', 'Bash(gh pr edit *)', 'claude')])).toBe('Allow gh pr edit for traps');
  expect(proposalTitle([add('a', ['gh', 'pr', 'edit']), add('b', ['pnpm', 'exec', 'eslint'])])).toBe('Allow 2 commands for traps');
  expect(proposalTitle([{ id: 'r', harness: 'claude', action: 'remove', rule: 'Bash(git status:*)' }])).toBe('Remove git status from traps');
  expect(proposalTitle([add('a', ['gh', 'pr', 'edit']), { id: 'r', harness: 'codex', action: 'remove', rule: ['git', 'status'] }])).toBe('Change trap permissions');
  expect(proposePermissions(input(), 'helm').meta.title).toBe('Allow gh pr edit for traps');
});

it('surgical array edits preserve comments, multiline strings, unrelated settings and removal formatting', () => {
  const before = '# Top\nmessage = """\n[permissions.codex]\nnot a table here\n"""\n[permissions.codex]\nallow = [\n ["git", "status"], # retained comment\n ["pnpm", "exec", "eslint"], # other\n]\nother = 3\n';
  const changes: PermissionRuleChange[] = [
    { id: 'remove', harness: 'codex', action: 'remove', rule: ['git', 'status'] },
    { id: 'add', harness: 'codex', action: 'add', rule: ['gh', 'pr', 'edit'] },
  ];
  const after = editPermissionConfig(before, changes);
  expect(after).toContain('# retained comment'); expect(after).toContain('# other'); expect(after).toContain('other = 3');
  expect(parse(after).message).toBe(parse(before).message);
  expect((parse(after).permissions as { codex: { allow: string[][] } }).codex.allow).toEqual([['pnpm', 'exec', 'eslint'], ['gh', 'pr', 'edit']]);
});

it('the glass Edit and Approve buttons preview and apply only checked rules through dedicated actions', async () => {
  const { meta } = proposePermissions(input(['gh pr edit', 'pnpm exec eslint']), 'helm');
  const snapshot = buildGlassSnapshot(); snapshot.focusToken = token;
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now(), hash: `#decision/${encodeURIComponent(meta.key)}`, post: async (_url, request) => {
    const response = await fetch(`${base}/requests`, { method: 'POST', headers: { ...request.headers, Origin: base }, body: request.body });
    return { status: response.status, body: await response.json() };
  } });
  try {
    expect(page.$('.permissions-proposal')).not.toBeNull();
    expect(page.$('.dmodal textarea')).toBeNull();
    (page.$('.proposal-edit') as HTMLElement).click(); await page.settle();
    const checkbox = page.$('.permissions-proposal input') as HTMLInputElement;
    checkbox.click(); await page.settle();
    expect(page.posts().map((request) => JSON.parse(request.body).kind)).toContain('permissions-proposal-preview');
    expect((page.$('.proposal-approve') as HTMLButtonElement).disabled).toBe(false);
    (page.$('.proposal-approve') as HTMLElement).click(); await page.settle();
    const kinds = page.posts().map((request) => JSON.parse(request.body).kind);
    expect(kinds).toContain('permissions-proposal-answer'); expect(kinds).not.toContain('decision-answer');
    const allow = (parse(fs.readFileSync(config, 'utf8')).permissions as { codex: { allow: string[][] } }).codex.allow;
    expect(allow).toContainEqual(['pnpm', 'exec', 'eslint']); expect(allow).not.toContainEqual(['gh', 'pr', 'edit']);
  } finally { await page.close(); }
});

it('an apply check failure restores config and profiles and leaves the proposal unanswered', () => {
  const { meta } = proposePermissions(input(), 'helm');
  const proposal = meta.permissionsProposal!;
  expect(() => answerPermissionsProposal(meta.key, 'Approve', proposal.rules.map((rule) => rule.id), proposal.diffHash, process.env,
    () => ({ status: 1, stdout: '', stderr: 'fixture rejects rules' }))).toThrow('execpolicy check');
  expect(fs.readFileSync(config, 'utf8')).toBe(original);
  expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe('{"model":"keep"}\n');
  expect(fs.readFileSync(path.join(codex, 'rules/lobstah.rules'), 'utf8')).toBe(`${RULES_HEADER} old fixture\n`);
  expect(readDecisionAnswer(meta.key)).toBeUndefined();
});

it('approved removals narrow existing allow arrays while keeping their comments', async () => {
  const { meta } = proposePermissions({ ...input(), codexRemove: ['git status'], claudeRemove: ['Bash(git status *)'] }, 'helm');
  const proposal = meta.permissionsProposal!;
  const response = await post('permissions-proposal-answer', { key: meta.key, option: 'Approve', selected: proposal.rules.map((rule) => rule.id), diffHash: proposal.diffHash });
  expect(response.status, await response.text()).toBe(201);
  const changed = fs.readFileSync(config, 'utf8');
  expect(changed).toContain('# Keep this comment too');
  const permissions = parse(changed).permissions as { allow: string[]; codex: { allow: string[][] } };
  expect(permissions.allow).toEqual([]); expect(permissions.codex.allow).toEqual([['gh', 'pr', 'edit']]);
});

it('Approve is one glass click when every proposed rule stays selected', async () => {
  const { meta } = proposePermissions(input(), 'helm');
  const snapshot = buildGlassSnapshot(); snapshot.focusToken = token;
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now(), hash: `#decision/${encodeURIComponent(meta.key)}`, post: async (_url, request) => {
    const response = await fetch(`${base}/requests`, { method: 'POST', headers: { ...request.headers, Origin: base }, body: request.body });
    return { status: response.status, body: await response.json() };
  } });
  try {
    (page.$('.proposal-approve') as HTMLElement).click(); await page.settle();
    expect(readDecisionAnswer(meta.key)?.option).toBe('Approve');
    expect(page.posts().filter((request) => JSON.parse(request.body).kind === 'permissions-proposal-answer')).toHaveLength(1);
    expect(fs.readFileSync(path.join(codex, 'rules/lobstah.rules'), 'utf8')).toContain('# rule: forbidden lobstah grant');
    expect(fs.readFileSync(path.join(codex, 'rules/lobstah.rules'), 'utf8')).toContain('# rule: forbidden lobstah permissions apply|remove');
  } finally { await page.close(); }
});

it.each([
  { position: 1, count: 4, next: 2 },
  { position: 3, count: 4, next: 2 },
  { position: 0, count: 1, next: undefined },
])('keeps the queue slot after answering a proposal at $position of $count', async ({ position, count, next }) => {
  const { meta } = proposePermissions(input(), 'helm');
  const keys: string[] = [];
  const askedAt = Date.parse(meta.askedAt);
  for (let index = 0; index < count; index++) {
    if (index === position) continue;
    const card = askDecision({ title: `Other decision ${index}`, options: ['Done'], askedBy: 'helm', maxBytes: 1024,
      now: new Date(askedAt + (index < position ? -10_000 : 10_000) + index * 1000) }).meta;
    keys[index] = card.key;
  }
  keys[position] = meta.key;
  const snapshot = buildGlassSnapshot(); snapshot.focusToken = token;
  const page = await loadGlass(GLASS_PAGE, snapshot, { now: Date.now(), hash: `#decision/${encodeURIComponent(meta.key)}`, post: async (_url, request) => {
    const response = await fetch(`${base}/requests`, { method: 'POST', headers: { ...request.headers, Origin: base }, body: request.body });
    return { status: response.status, body: await response.json() };
  } });
  try {
    (page.$('.proposal-reject') as HTMLElement).click(); await page.settle();
    expect(readDecisionAnswer(meta.key)?.option).toBe('Reject');
    if (next === undefined) expect(page.$('.dmodal .ddone')?.textContent).toContain('All decisions answered');
    else expect(page.$('.dmodal')?.getAttribute('data-decision')).toBe(keys[next]);
  } finally { await page.close(); }
});
