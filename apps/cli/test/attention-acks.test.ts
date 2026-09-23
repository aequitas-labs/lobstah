import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acknowledge,
  answeredAt,
  appendStatus,
  claimNext,
  complete,
  enqueue,
  ensureLayout,
  executorPath,
  laneDirs,
  mergeEvidence,
  sendMessage,
  unhandled,
} from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { attentionNow, freshWakeEvents } from '@lobstah/supervisor';
import { buildTendReport, renderTend } from '../src/tend.js';
import { acksDir, readAck } from '../src/acks.js';
import { applyCull, planCull } from '../src/cull.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-acks-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const lobstah = (...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, LOBSTAH_HOME: home }, timeout: 10_000 });
const tick = () => new Promise((r) => setTimeout(r, 5)); // sidecar and status timestamps are ms-resolution

const Q = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const PR_URL = 'https://github.com/acme/web/pull/9';

/** An active dispatch standing on needs-decision. */
function question(): void {
  enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(Q, 'work', 'needs-decision', 'which color?');
}
const questions = () => buildTendReport().attention.filter((a) => a.kind === 'question');

describe('part 1: the answer is the ack for questions', () => {
  it('a message newer than the question clears it from attention; the row says answered', async () => {
    question();
    expect(questions()).toHaveLength(1);
    await tick();
    sendMessage(Q, 'work', '[from helm]\nblue', 'helm');
    const r = buildTendReport();
    expect(r.attention).toEqual([]);
    expect(r.verdict).not.toBe('needs-attention');
    const row = r.stories.flatMap((s) => s.dispatches).find((d) => d.id === Q)!;
    expect(row.state).toBe('needs-decision');
    expect(row.answeredAt).toBeDefined();
    expect(renderTend(r)).toMatch(/11111111:needs-decision \(answered \d+m ago\)/);
  });

  it('a newer needs-decision after the answer stands again', async () => {
    question();
    await tick();
    sendMessage(Q, 'work', 'blue', 'helm');
    await tick();
    appendStatus(Q, 'work', 'needs-decision', 'and the shade?');
    expect(questions().map((a) => a.note)).toEqual(['and the shade?']);
  });

  it('any sender with provenance answers (tracker, node, terminal); a record without provenance does not', async () => {
    question();
    await tick();
    sendMessage(Q, 'work', 'legacy text that says [from helm]'); // no sidecar
    expect(questions()).toHaveLength(1);
    sendMessage(Q, 'work', 'from the tracker', 'tracker:github');
    expect(questions()).toHaveLength(0);
  });

  it('provenance travels with its message into handled/, and a message older than the question never answers it', async () => {
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    sendMessage(Q, 'work', 'early word', 'helm');
    await tick();
    appendStatus(Q, 'work', 'needs-decision', 'q');
    const at = '2000-01-01T00:00:00Z';
    expect(answeredAt(Q, 'work', new Date().toISOString())).toBeUndefined();
    expect(answeredAt(Q, 'work', at)).toBeDefined();
    const [m] = unhandled(Q, 'work');
    acknowledge(Q, 'work', m!.file);
    expect(fs.existsSync(path.join(laneDirs('work').inbox, Q, 'handled', '001.meta.json'))).toBe(true);
    expect(answeredAt(Q, 'work', at)).toBeDefined(); // handled records still count
  });

  it('the reminder loop (man wait, the park) skips an answered question; acks never matter to it', async () => {
    question();
    expect(attentionNow(true, 1).map((e) => e.id)).toEqual([Q]); // fresh
    const later = Date.now() + 60_000;
    expect(attentionNow(false, 1, later).map((e) => e.id)).toEqual([Q]); // a reminder would re-fire
    lobstah('attention', 'ack', `work:${Q}`, '--by', 'test');
    expect(attentionNow(false, 1, later).map((e) => e.id)).toEqual([Q]); // acked: still the helm's wake
    await tick();
    sendMessage(Q, 'work', 'blue', 'helm');
    expect(attentionNow(true, 1, later)).toEqual([]); // answered: no reminder
    const baseline = { [`work:${Q}`]: 0 };
    expect(freshWakeEvents(baseline).filter((e) => e.entry.verb === 'needs-decision')).toEqual([]);
  });
});

const pr = (over: Partial<PrEvidence> = {}): PrEvidence => ({
  url: PR_URL,
  number: 9,
  state: 'OPEN',
  draft: true,
  reviewDecision: '',
  mergeStateStatus: 'DRAFT',
  headSha: 'abc1234',
  checks: { total: 1, passed: 1, failed: 0, pending: 0 },
  review: { unresolvedThreads: 0, changesRequested: false },
  observedAt: new Date().toISOString(),
  ...over,
});
function draftPr(over: Partial<PrEvidence> = {}): void {
  enqueue({ id: P, repo: 'web', brief: 'b' }, 'work');
  claimNext('work');
  appendStatus(P, 'work', 'done', 'opened');
  complete(P, 'work');
  mergeEvidence(P, 'work', { prUrl: PR_URL, pr: pr(over) });
}
/** What the pet walks: tend's attention minus acked items (main.swift filters the same way). */
const petPayload = () => buildTendReport().attention.filter((a) => !a.acked);

describe('part 2: click-to-ack, display-only', () => {
  it('ack hides the item from the pet payload but it stays in --json attention, marked acked', () => {
    draftPr();
    expect(petPayload().map((a) => a.key)).toEqual(['pr:acme/web#9']);
    const res = lobstah('attention', 'ack', 'pr:acme/web#9', '--by', 'pet');
    expect(res.status).toBe(0);
    expect(petPayload()).toEqual([]);
    const json = JSON.parse(lobstah('man', 'tend', '--json').stdout) as { attention: Array<{ key: string; acked?: { by: string } }> };
    expect(json.attention).toEqual([expect.objectContaining({ key: 'pr:acme/web#9', acked: expect.objectContaining({ by: 'pet' }) })]);
    expect(readAck('pr:acme/web#9')).toMatchObject({ key: 'pr:acme/web#9', kind: 'pr:draft', by: 'pet' });
  });

  it('a changed stateHash re-stands the item and the stale ack is deleted', () => {
    draftPr();
    lobstah('attention', 'ack', 'pr:acme/web#9');
    expect(petPayload()).toEqual([]);
    mergeEvidence(P, 'work', { pr: pr({ headSha: 'def5678' }) }); // a new head
    expect(petPayload().map((a) => a.key)).toEqual(['pr:acme/web#9']);
    expect(readAck('pr:acme/web#9')).toBeDefined(); // tend's derivation is a pure read …
    lobstah('man', 'tend'); // … the CLI view prunes the stale record
    expect(readAck('pr:acme/web#9')).toBeUndefined();
  });

  it('re-observing an unchanged PR keeps the ack', () => {
    draftPr();
    lobstah('attention', 'ack', 'pr:acme/web#9');
    mergeEvidence(P, 'work', { pr: pr({ observedAt: new Date(Date.now() + 60_000).toISOString() }) });
    expect(petPayload()).toEqual([]);
  });

  it('unack restores it; a second unack and an unknown ack key exit 2', () => {
    question();
    expect(lobstah('attention', 'ack', `work:${Q}`).status).toBe(0);
    expect(questions()[0]?.acked).toBeDefined();
    expect(lobstah('attention', 'unack', `work:${Q}`).status).toBe(0);
    expect(questions()[0]?.acked).toBeUndefined();
    expect(lobstah('attention', 'unack', `work:${Q}`).status).toBe(2);
    const unknown = lobstah('attention', 'ack', 'work:nope');
    expect(unknown.status).toBe(2);
    expect(unknown.stdout + unknown.stderr).toContain('no standing attention item');
    expect(lobstah('attention', 'ack').status).toBe(2);
  });

  it('bare `attention` lists standing items with their ack state', () => {
    question();
    lobstah('attention', 'ack', `work:${Q}`, '--by', 'test');
    const out = lobstah('attention').stdout;
    expect(out).toContain(`work:${Q},question,test 0m ago,which color?`);
  });

  it('cull removes acks whose item is gone (dispatch culled, PR merged); never a live one', () => {
    draftPr();
    question();
    lobstah('attention', 'ack', 'pr:acme/web#9');
    lobstah('attention', 'ack', `work:${Q}`);
    expect(planCull(14).filter((i) => i.kind === 'ack')).toEqual([]);
    mergeEvidence(P, 'work', { pr: pr({ state: 'MERGED' }) });
    fs.rmSync(path.join(laneDirs('work').active, Q), { recursive: true, force: true });
    fs.rmSync(path.join(laneDirs('work').state, `${Q}.status`), { force: true });
    const acks = planCull(14).filter((i) => i.kind === 'ack');
    expect(acks.map((i) => i.id).sort()).toEqual(['pr:acme/web#9', `work:${Q}`]);
    applyCull(acks);
    expect(fs.readdirSync(acksDir())).toEqual([]);
  });
});
