import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, dispatchReportKey, enqueue, ensureLayout, executorPath, laneDirs, listReports, readReport, readStatusLog, signOnTrap } from '@lobstah/core';
import type { TendAttention } from '@lobstah/core';
import { readAck } from '../src/acks.js';
import { applyCull, planCull } from '../src/cull.js';
import { buildTendReport } from '../src/tend.js';
import { removeTempDir } from '../../../test/temp-dir.js';

// End to end against the built CLI (`pnpm build` runs before `pnpm test`).
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
let src: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-reports-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
  src = path.join(home, 'src');
  fs.mkdirSync(src);
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function lobstah(...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 10_000 });
}
const write = (name: string, body: string) => {
  const file = path.join(src, name);
  fs.writeFileSync(file, body);
  return file;
};
const withKinds = (kinds: string[]) => fs.writeFileSync(path.join(home, 'config.toml'), `attentionKinds = ${JSON.stringify(kinds)}\n`);
const reportItems = (items: TendAttention[]) => items.filter((a) => a.kind === 'report');

const A = 'aaaaaaaa-1111-4000-8000-000000000001';
const B = 'bbbbbbbb-2222-4000-8000-000000000002';

describe('report done --report', () => {
  it('files the page and its images; status and catch print the path; reports lists it', () => {
    enqueue({ id: A, repo: 'web', brief: '# Research trays\n\nfind them' });
    const res = lobstah('report', A, 'done', 'found the tray', '--report', write('r.md', '# Tray findings\n\n![tray](tray.png)\n'), '--attach', write('tray.png', 'PNG'));
    expect(res.status, res.stderr).toBe(0);
    const file = path.join(laneDirs('work').state, A, 'report.md');
    expect(res.stdout).toContain(`report: ${file}`);
    expect(fs.existsSync(path.join(laneDirs('work').state, A, 'attachments', 'tray.png'))).toBe(true);
    expect(readReport(dispatchReportKey(A, 'work'))).toMatchObject({ title: 'Tray findings', author: 'headless', dispatch: A, repo: 'web' });
    expect(readStatusLog(A, 'work').at(-1)).toMatchObject({ verb: 'done', note: 'found the tray' });
    expect(lobstah('status', A).stdout).toContain(`report: ${file}`);
    expect(lobstah('catch', A).stdout).toContain(`report: ${file}`);
    const list = lobstah('reports').stdout;
    expect(list).toContain(`report:work:${A},Tray findings,headless,${A},`);
    expect(list).toMatch(/,no\n/);
  });

  it("names the trap that filed it; the title falls back to the brief's", () => {
    const worktree = path.join(home, 'wt');
    fs.mkdirSync(worktree);
    const signed = signOnTrap({ sessionId: 's', harness: 'claude', repo: 'web', worktree, cwd: worktree, ttlMs: 60_000, name: 'quiet-reef' });
    if (!('ok' in signed)) throw new Error('unexpected hold');
    enqueue({ id: A, repo: 'web', brief: '# Research trays\n\nfind them' });
    expect(claimBait(signed.ok)?.id).toBe(A);
    expect(lobstah('report', A, 'failed', 'no tray', '--report', write('r.md', 'nothing found')).status).toBe(0);
    expect(readReport(dispatchReportKey(A, 'work'))).toMatchObject({ title: 'Research trays', author: 'quiet-reef', trap: 'quiet-reef' });
  });

  it('refuses an oversized page, a page on another verb, and --attach alone, and records no status', () => {
    enqueue({ id: A, repo: 'web', brief: 'b' });
    fs.writeFileSync(path.join(home, 'config.toml'), '[limits]\nattachmentMaxBytes = 16\n');
    const big = lobstah('report', A, 'done', '--report', write('big.md', 'x'.repeat(64)));
    expect(big.status).toBe(2);
    expect(big.stdout).toContain('exceeds 16 bytes');
    expect(lobstah('report', A, 'working', '--report', write('r.md', '# r')).status).toBe(2);
    expect(lobstah('report', A, 'done', '--attach', write('p.png', 'P')).status).toBe(2);
    expect(readStatusLog(A, 'work')).toEqual([]);
    expect(listReports()).toEqual([]);
  });
});

describe('man file', () => {
  it("stores a helm report under the grounds, author helm, --title over the page's heading", () => {
    const res = lobstah('man', 'file', write('h.md', '# Heading\n\nnotes'), '--title', 'Fleet notes', '--attach', write('chart.png', 'PNG'));
    expect(res.status, res.stderr).toBe(0);
    const [r] = listReports();
    expect(r).toMatchObject({ title: 'Fleet notes', author: 'helm', grounds: 'fleet', attachments: [{ name: 'chart.png' }] });
    expect(r!.key).toMatch(/^report:helm:fleet:[a-f0-9]{8}$/);
    expect(fs.existsSync(path.join(home, 'reports', 'fleet', r!.key.split(':').at(-1)!, 'report.md'))).toBe(true);
    expect(res.stdout).toContain(`lobstah attention ack ${r!.key}`);
  });
});

describe('the report attention kind', () => {
  it('is not walked by default; with report enabled, a filed report is an item; an ack leaves man tend but not the pet', () => {
    enqueue({ id: A, repo: 'web', brief: 'b' });
    lobstah('report', A, 'done', '--report', write('r.md', '# Tray findings'), '--pr', 'https://github.com/acme/web/pull/7', '--no-watch');
    expect(reportItems(buildTendReport().attention)).toEqual([]);
    withKinds(['question', 'report', 'pr:ready']);
    const [item] = reportItems(buildTendReport().attention);
    expect(item).toMatchObject({ kind: 'report', key: `report:work:${A}`, note: 'Tray findings', id: A, lane: 'work' });
    expect(item!.acked).toBeUndefined();

    const ack = lobstah('attention', 'ack', `report:work:${A}`);
    expect(ack.status, ack.stderr).toBe(0);
    // The pet reads `attention --json` and walks only unacked items.
    const pet = JSON.parse(lobstah('attention', '--json').stdout) as { attention: TendAttention[] };
    expect(reportItems(pet.attention).filter((a) => !a.acked)).toEqual([]);
    const tend = JSON.parse(lobstah('man', 'tend', '--json').stdout) as { attention: TendAttention[] };
    expect(reportItems(tend.attention)).toHaveLength(1);
    expect(reportItems(tend.attention)[0]!.acked).toMatchObject({ by: 'terminal' });
  });

  it('attention ack acks a report even when the kind is not walked', () => {
    lobstah('man', 'file', write('h.md', '# notes'));
    const [r] = listReports();
    expect(lobstah('attention', 'ack', r!.key).status).toBe(0);
    expect(readAck(r!.key)?.stateHash).toBe(r!.stateHash);
  });

  it("a newer report in the same chain acks the older one; the chain's other reports stand", () => {
    withKinds(['report']);
    enqueue({ id: A, repo: 'web', brief: 'b' });
    lobstah('report', A, 'done', '--report', write('a.md', '# first'));
    enqueue({ id: B, repo: 'web', brief: 'b', followUp: A });
    lobstah('report', B, 'done', '--report', write('b.md', '# second'));
    const items = reportItems(buildTendReport().attention);
    expect(items.find((a) => a.id === A)!.acked?.by).toBe(`newer report report:work:${B}`);
    expect(items.find((a) => a.id === B)!.acked).toBeUndefined();
  });
});

describe('cull', () => {
  it("removes a dispatch's report with its state and an aged helm report, and their acks", () => {
    enqueue({ id: A, repo: 'web', brief: 'b' });
    lobstah('report', A, 'done', '--report', write('r.md', '# r'), '--attach', write('p.png', 'P'));
    // A done dispatch: move it to done/.
    const done = path.join(laneDirs('work').done, A);
    fs.mkdirSync(done, { recursive: true });
    fs.renameSync(path.join(laneDirs('work').queue, `${A}.json`), path.join(done, 'descriptor.json'));
    lobstah('man', 'file', write('h.md', '# h'));
    const helm = listReports().find((r) => r.author === 'helm')!;
    lobstah('attention', 'ack', helm.key);
    lobstah('attention', 'ack', `report:work:${A}`);

    // Nothing is old yet.
    expect(planCull(14).filter((i) => i.kind === 'report' || i.kind === 'state')).toEqual([]);
    const later = Date.now() + 30 * 86_400_000;
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(done, old, old);
    const plan = planCull(14, later);
    expect(plan.map((i) => `${i.kind} ${i.id}`)).toEqual(
      expect.arrayContaining([`done ${A}`, `state ${A}`, `report ${helm.key}`, `ack ${helm.key}`, `ack report:work:${A}`]),
    );
    applyCull(plan);
    expect(listReports()).toEqual([]);
    expect(fs.existsSync(path.join(laneDirs('work').state, A))).toBe(false);
    expect(readAck(helm.key)).toBeUndefined();
  });
});
