import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  backendScope, ensureLayout, listHelms, listReports, loadConfig,
  readHelm, resolveGrounds, takeHelm,
} from '@lobstah/core';
import { buildBriefContext } from '../src/brief.js';
import { buildGlassSnapshot, glassPoll } from '../src/glass.js';
import { buildTendReport, renderTend } from '../src/tend.js';
import { fileHelmReport, reportRows, viewReport } from '../src/report-file.js';
import { advanceCursor, readCursor } from '../src/reported.js';
import { readAck } from '../src/acks.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-home-name-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.web]\npath = ${JSON.stringify(home.replace(/\\/g, '/'))}\ntrunk = "main"\n`);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

function run(...args: string[]) {
  return invoke(args);
}

function invoke(args: string[], input?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX') && k !== 'LOBSTAH_GROUNDS'));
  return spawnSync(process.execPath, [cli, ...args], { cwd: home, env: { ...env, LOBSTAH_HOME: home }, input, encoding: 'utf8', timeout: 15_000 });
}

/** The pre-rename local layout: legacy embedded grounds, report key, cursor and ack. */
function legacyState() {
  takeHelm({ sessionId: 'old-session', grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000 });
  const source = path.join(home, 'notes.md');
  fs.writeFileSync(source, '# Notes\n\nReady.');
  const report = fileHelmReport('fleet', source, []);
  viewReport(report.key);
  advanceCursor('fleet', '2026-10-10T00:00:00.000Z');
  return report;
}

it('reads a pre-rename fixture as home without moving state or changing report/ack identities', async () => {
  const report = legacyState();
  const cfg = loadConfig();
  const before = fs.readFileSync(path.join(home, 'helm', 'fleet.json'), 'utf8');
  const snapshot = buildGlassSnapshot();
  expect(snapshot.helms.map((h) => h.grounds)).toEqual(['home']);
  expect(snapshot.backends?.map((b) => b.grounds)).toEqual(['home']);
  expect(snapshot.reports?.map((r) => r.grounds)).toEqual(['home']);
  // The glass crawler/preview consumes the same /data helm display identity.
  expect(JSON.parse(glassPoll(false).body).helms[0]?.grounds).toBe('home');
  const tend = buildTendReport();
  expect(tend.helms[0]?.grounds).toBe('home');
  expect(tend.backends?.[0]?.grounds).toBe('home');
  expect(renderTend(tend)).toContain('home=');
  expect(renderTend(tend)).not.toContain('fleet=');
  expect(reportRows()[0]?.from).toBe('helm home');
  expect(fs.readFileSync(path.join(home, 'helm', 'fleet.json'), 'utf8')).toBe(before);
  expect(readCursor('home')).toBe(readCursor('fleet'));
  expect(readAck(report.key)?.stateHash).toBe(report.stateHash);
  expect(listReports()[0]).toMatchObject({ key: report.key, grounds: 'fleet', stateHash: report.stateHash });
  expect(fs.existsSync(path.join(home, 'helm', 'home.json'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'reported', 'home.json'))).toBe(false);
  expect(fs.existsSync(path.join(home, 'reports', 'home'))).toBe(false);
  expect(backendScope(cfg, 'home').grounds).toBe('home');
  expect(backendScope(cfg, 'fleet').grounds).toBe('home');
  expect(backendScope(cfg).grounds).toBe('home');
  const brief = await buildBriefContext('old-session', home);
  expect(brief).toContain('you hold the helm for grounds "home"');
  expect(brief).toContain('the helm charter — grounds "home"');
  expect(brief).not.toContain('grounds "fleet"');
});

it('home and fleet address one old/new helm seat; only an explicit fleet flag prints the alias notice once', () => {
  legacyState();
  const resign = run('man', 'helm', '--session', 'old-session', '--grounds', 'home');
  expect(resign.status, resign.stdout + resign.stderr).toBe(0);
  expect(resign.stdout).toContain('helm: home');
  expect(resign.stderr).not.toContain('alias');
  const refused = run('man', 'helm', '--session', 'new-session', '--grounds', 'home');
  expect(refused.status).toBe(1);
  expect(refused.stdout + refused.stderr).toContain('grounds \\"home\\" is held');
  expect(listHelms()).toHaveLength(1);
  expect(readHelm('fleet')?.sessionId).toBe('old-session');
  // Simulate an unchanged older writer, still using the permanent fleet identity.
  expect('held' in takeHelm({ sessionId: 'old-cli', grounds: { name: 'fleet', repos: ['web'] }, ttlMs: 60_000 })).toBe(true);
  const alias = run('man', 'helm', '--session', 'old-session', '--grounds', 'fleet');
  expect(alias.status, alias.stdout + alias.stderr).toBe(0);
  expect(alias.stderr.trim().split('\n')).toEqual(['lobstah: the implicit grounds is now called home; --grounds fleet remains an alias.']);
  expect(alias.stdout).toContain('helm: home');
  expect(fs.existsSync(path.join(home, 'helm', 'home.json'))).toBe(false);
  const wait = run('man', 'wait', '--session', 'old-session', '--grounds', 'home', '--timeout', '1');
  expect(wait.status, wait.stdout + wait.stderr).toBe(3);
  expect(wait.stdout).toContain('--grounds home');
  expect(wait.stdout).not.toContain('--grounds fleet');
  const take = run('man', 'helm', '--session', 'new-session', '--grounds', 'home', '--take');
  expect(take.status, take.stdout + take.stderr).toBe(0);
  const stop = invoke(['hook', 'stop', '--timeout', '1'], JSON.stringify({ session_id: 'old-session', hook_event_name: 'Stop' }));
  expect(stop.stdout).toContain('grounds \\"home\\"');
  expect(stop.stdout).not.toContain('grounds \\"fleet\\"');
});

it('writes cards, reports and cursors under fleet while displaying home and keeping raw addresses copyable', () => {
  const source = path.join(home, 'notes.md'); fs.writeFileSync(source, 'Notes without a heading');
  const filed = run('man', 'file', source, '--grounds', 'home');
  expect(filed.status, filed.stdout + filed.stderr).toBe(0);
  const report = listReports()[0]!;
  expect(report.grounds).toBe('fleet');
  expect(report.key).toMatch(/^report:helm:fleet:/);
  expect(filed.stdout).toContain('grounds: home');
  expect(filed.stdout).toContain(`lobstah attention ack ${report.key}`);
  expect(filed.stdout).toContain(path.join(home, 'reports', 'fleet', report.key.split(':').at(-1)!, 'report.md'));
  expect(report.title).toBe('helm report · home');
  const asked = run('man', 'ask', '--grounds', 'home', '--title', 'Which option?', '--option', 'Yes');
  expect(asked.status, asked.stdout + asked.stderr).toBe(0);
  const ids = fs.readdirSync(path.join(home, 'decisions')).filter((x) => !x.startsWith('.'));
  const metadata = JSON.parse(fs.readFileSync(path.join(home, 'decisions', ids[0]!, 'decision.json'), 'utf8'));
  expect(metadata.grounds).toBe('fleet');
  advanceCursor('home', '2026-10-10T01:00:00.000Z');
  expect(readCursor('fleet')).toBe('2026-10-10T01:00:00.000Z');
  expect(fs.existsSync(path.join(home, 'reported', 'home.json'))).toBe(false);
  advanceCursor('all', '2026-10-10T02:00:00.000Z');
  expect(readCursor('all')).toBe('2026-10-10T02:00:00.000Z');
  expect(readCursor('fleet')).toBe('2026-10-10T01:00:00.000Z');
  expect(run('attention', 'ack', report.key).status).toBe(0);
  expect(readAck(report.key)?.key).toBe(report.key);
});

it.each(['fleet', 'home'])('leaves explicit %s grounds untouched and has no implicit grounds for unassigned repos', (name) => {
  fs.appendFileSync(path.join(home, 'config.toml'), `\n[repos.other]\npath = ${JSON.stringify(home.replace(/\\/g, '/'))}\ntrunk = "main"\n[grounds.${name}]\nrepos = ["web"]\n`);
  const cfg = loadConfig();
  expect(resolveGrounds(cfg)).toEqual({ name, repos: ['web'] });
  expect(() => resolveGrounds(cfg, name === 'fleet' ? 'home' : 'fleet')).toThrow('unknown grounds');
  const on = run('man', 'helm', '--session', 'explicit-session', '--grounds', name);
  expect(on.status, on.stdout + on.stderr).toBe(0);
  expect(on.stderr).not.toContain('alias');
  expect(on.stdout).toContain(`helm: ${name}`);
  expect(readHelm(name)?.grounds).toBe(name);
  expect(buildGlassSnapshot().helms[0]?.grounds).toBe(name);
  const source = path.join(home, 'explicit.md'); fs.writeFileSync(source, '# Explicit report');
  expect(run('man', 'file', source, '--session', 'explicit-session').status).toBe(0);
  expect(listReports()[0]?.grounds).toBe(name);
});

it('uses home directly on a configured wharf, without a local legacy identity', () => {
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[wharves.main]\nkind = "wharf"\nurl = "https://wharf.invalid"\naccount = "test"\ntokenEnv = "TEST_TOKEN"\n[grounds.home]\nrepos = ["web"]\nwharf = "main"\n');
  expect(backendScope(loadConfig(), 'home')).toMatchObject({ grounds: 'home', kind: 'wharf' });
  expect(() => backendScope(loadConfig(), 'fleet')).toThrow('unknown grounds');
});
