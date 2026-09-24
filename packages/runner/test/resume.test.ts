import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendStatus,
  claimBait,
  claimNext,
  complete,
  enqueue,
  ensureLayout,
  laneDirs,
  loadConfig,
  mergeEvidence,
  readEvidence,
  readStatusLog,
  resolveSessionHarness,
  signOnTrap,
} from '@lobstah/core';
import type { Descriptor, NormalizedEvent } from '@lobstah/core';
import { AsyncQueue } from '@lobstah/adapters';
import type { Adapter, AdapterRun, AdapterStartOpts } from '@lobstah/adapters';
import { worktreePath } from '@lobstah/worktree';
import { main } from '../src/run.js';
import type { RunnerDeps } from '../src/run.js';
import { planStart } from '../src/plan.js';

const CODEX_SID = '01a0ceb8-b9bd-7d42-927c-c52a334b8e2d'; // UUIDv7
const CLAUDE_SID = '19a4f6e4-1341-4c3a-9f2e-0123456789ab'; // UUIDv4

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-resume-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  // JSON.stringify, as appendRepoBlock writes it: a Windows temp path's
  // backslashes would otherwise read as TOML escapes (\U, \R).
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[repos.r]\npath = ${JSON.stringify(path.join(home, 'repo'))}\ntrunk = "main"\n`,
  );
  delete process.env.LOBSTAH_RESUME;
  delete process.env.LOBSTAH_NUDGE;
  // Desktop-thread detection reads Codex rollouts; never the host's.
  process.env.CODEX_HOME = path.join(home, 'codex');
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
  delete process.env.CODEX_HOME;
});

interface Start {
  harness: string;
  opts: AdapterStartOpts;
}

/**
 * Mock harnesses. A resume of a session this harness does not own (or one
 * listed as gone) fails the way the real CLIs do — an error result before
 * any work. Anything else: announce a session, do one tool call, report done.
 */
function mockDeps(opts: { owns: Record<string, string>; gone?: string[] }) {
  const starts: Start[] = [];
  const adapter = (name: string): Adapter => ({
    name,
    async start(o: AdapterStartOpts): Promise<AdapterRun> {
      starts.push({ harness: name, opts: o });
      const events = new AsyncQueue<NormalizedEvent>();
      let resolveDone!: (v: { sessionId?: string; error?: string }) => void;
      const done = new Promise<{ sessionId?: string; error?: string }>((r) => (resolveDone = r));
      const at = () => new Date().toISOString();
      const refused =
        o.resumeSession !== undefined && (opts.owns[o.resumeSession] !== name || opts.gone?.includes(o.resumeSession));
      setTimeout(() => {
        if (refused) {
          events.push({ at: at(), type: 'turn-end', data: { subtype: 'error_during_execution' } });
          return;
        }
        const sessionId = `${name}-new-${starts.length}`;
        events.push({ at: at(), type: 'session', data: { sessionId } });
        events.push({ at: at(), type: 'tool-start', data: { name: 'Bash' } });
        appendStatus(o.id, 'work', 'done', `finished on ${name}`);
        events.push({ at: at(), type: 'turn-end', data: {} });
      }, 0);
      const finish = () => {
        events.close();
        resolveDone(
          refused
            ? {
                error:
                  name === 'claude'
                    ? `Claude Code returned an error result: No conversation found with session ID: ${o.resumeSession}`
                    : `codex exited 1 — Error: no rollout found for thread id ${o.resumeSession}`,
              }
            : { sessionId: `${name}-new-${starts.length}` },
        );
      };
      return { events, send: () => {}, end: finish, kill: finish, done };
    },
  });
  const deps: RunnerDeps = {
    loadAdapter: adapter,
    allocate: async (_repo, id) => {
      fs.mkdirSync(worktreePath(id), { recursive: true });
      return worktreePath(id);
    },
    collectEvidence: async (_repo, id) => ({ branch: `lobstah/${id}`, commits: [] }),
  };
  return { deps, starts };
}

/** An origin a trap claimed and finished — the bfa8687a shape. */
function trapBuiltOrigin(id: string, trapHarness: string, sessionId: string, descriptorHarness = 'claude'): void {
  const wt = fs.mkdtempSync(path.join(home, 'trap-wt-'));
  const res = signOnTrap({ worktree: wt, cwd: wt, repo: 'r', harness: trapHarness, sessionId, ttlMs: 60_000 });
  if ('held' in res) throw new Error('trap held');
  enqueue({ id, repo: 'r', brief: 'build it', harness: descriptorHarness });
  const caught = claimBait(res.ok);
  expect(caught?.id).toBe(id);
  appendStatus(id, 'work', 'done', 'built');
  complete(id, 'work');
}

/** An origin a headless runner finished, with evidence as given. */
function headlessOrigin(id: string, evidence: Parameters<typeof mergeEvidence>[2], descriptor: Partial<Descriptor> = {}): void {
  enqueue({ id, repo: 'r', brief: 'build it', ...descriptor });
  claimNext('work');
  mergeEvidence(id, 'work', evidence);
  appendStatus(id, 'work', 'done', 'built');
  complete(id, 'work');
}

async function runFollowUp(id: string, d: Partial<Descriptor>, deps: RunnerDeps): Promise<void> {
  enqueue({ id, repo: 'r', brief: 'address review', ...d });
  expect(claimNext('work')).toBe(id);
  await main(path.join(laneDirs('work').active, id), 'work', deps);
}

const notes = (id: string) => readStatusLog(id, 'work').map((e) => `${e.verb}${e.note ? `: ${e.note}` : ''}`);

describe('runner — a follow-up resumes with the origin session’s harness', () => {
  it('a follow-up on a Codex-claimed origin resumes with codex despite a legacy (unrecorded) --harness claude', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    expect(readEvidence('origin', 'work').harness).toBe('codex'); // the trap's claim stamps it

    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin', harness: 'claude' }, deps);

    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['codex', CODEX_SID]]);
    const log = notes('fu');
    expect(log[0]).toContain('resuming codex session 01a0ceb8');
    expect(log[0]).toContain('--harness claude ignored');
    expect(log.at(-1)).toBe('done: finished on codex');
    expect(readEvidence('fu', 'work').harness).toBe('codex');
  });

  it('an explicit --harness claude on a Codex-claimed origin is a swap: cold on claude (e2de5dd7)', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin', harness: 'claude', harnessExplicit: true }, deps);

    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['claude', undefined]]);
    expect(starts[0]!.opts.prompt).toContain('previous agent session (harness: codex)');
    expect(notes('fu')[0]).toContain('swap — origin session is codex, claude requested; starting cold on claude');
    expect(notes('fu').at(-1)).toBe('done: finished on claude');
    expect(readEvidence('fu', 'work').harness).toBe('claude');
  });

  it('an explicit --harness equal to the origin session’s resumes it', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin', harness: 'codex', harnessExplicit: true }, deps);
    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['codex', CODEX_SID]]);
  });

  it('an unspecified harness follows the origin', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin' }, deps);
    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['codex', CODEX_SID]]);
    expect(notes('fu')[0]).toContain('resuming codex session 01a0ceb8 (harness from evidence)');
  });

  it('a resume failure falls back cold on the descriptor’s harness, not the origin’s', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' }, gone: [CODEX_SID] });
    await runFollowUp('fu', { followUp: 'origin', model: 'claude-opus-5-5' }, deps);

    expect(starts.map((s) => [s.harness, s.opts.resumeSession, s.opts.model])).toEqual([
      ['codex', CODEX_SID, undefined], // the claude model never reaches codex
      ['claude', undefined, 'claude-opus-5-5'],
    ]);
    const log = notes('fu');
    expect(log[0]).toContain('model claude-opus-5-5 is a claude model — dropped, using codex\'s default');
    expect(log.some((n) => /^working: resume-fallback: .*no rollout found.* — starting cold on claude$/.test(n))).toBe(true);
    expect(log.at(-1)).toBe('done: finished on claude');
    expect(readEvidence('fu', 'work')).toMatchObject({ harness: 'claude', sessionId: 'claude-new-2' });
  });

  it('a Codex desktop thread is not handed to the CLI: cold on the descriptor’s harness, no attempt', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const day = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '23');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, `rollout-2026-09-23T10-43-27-${CODEX_SID}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: CODEX_SID, originator: 'Codex Desktop', source: 'vscode' } }) + '\n',
    );
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin' }, deps);

    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['claude', undefined]]);
    expect(starts[0]!.opts.prompt).toContain('The earlier dispatch origin left:');
    expect(notes('fu')[0]).toContain('Codex desktop thread; not resumable from the CLI (01a0ceb8), starting cold on claude');
    expect(notes('fu').at(-1)).toBe('done: finished on claude');
  });

  it('a CLI rollout (codex_exec) is still resumed', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const day = path.join(process.env.CODEX_HOME!, 'sessions', '2026', '09', '23');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(
      path.join(day, `rollout-2026-09-23T10-43-27-${CODEX_SID}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: CODEX_SID, originator: 'codex_exec' } }) + '\n',
    );
    const { deps, starts } = mockDeps({ owns: { [CODEX_SID]: 'codex' } });
    await runFollowUp('fu', { followUp: 'origin' }, deps);
    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([['codex', CODEX_SID]]);
  });

  it('an origin claimed before evidence carried harness still resolves through the trap claim', async () => {
    trapBuiltOrigin('origin', 'codex', CODEX_SID);
    const ev = readEvidence('origin', 'work');
    delete ev.harness;
    fs.writeFileSync(path.join(laneDirs('work').state, 'origin.evidence'), JSON.stringify(ev));
    expect(resolveSessionHarness('origin')).toMatchObject({ harness: 'codex', source: 'trap' });
  });

  it('a follow-up that explicitly requests a different harness starts cold with the progress note', async () => {
    headlessOrigin('origin', { sessionId: CLAUDE_SID, harness: 'claude', branch: 'lobstah/origin', commits: ['abc123 first cut'], prUrl: 'https://x/pr/1' });

    const { deps, starts } = mockDeps({ owns: { [CLAUDE_SID]: 'claude' } });
    await runFollowUp('fu', { followUp: 'origin', harness: 'codex' }, deps);

    expect(starts).toHaveLength(1);
    expect(starts[0]!.harness).toBe('codex');
    expect(starts[0]!.opts.resumeSession).toBeUndefined();
    const prompt = starts[0]!.opts.prompt;
    expect(prompt).toContain('address review'); // the brief
    expect(prompt).toContain('previous agent session (harness: claude)');
    expect(prompt).toContain('Commits so far:');
    expect(prompt).toContain('abc123 first cut');
    expect(prompt).toContain('https://x/pr/1');
    expect(notes('fu')[0]).toContain('swap — origin session is claude, codex requested; starting cold on codex');
    expect(notes('fu').at(-1)).toBe('done: finished on codex');
  });

  it('a resume error falls back cold, records the reason, and the dispatch proceeds', async () => {
    headlessOrigin('origin', { sessionId: CLAUDE_SID, harness: 'claude' });

    const { deps, starts } = mockDeps({ owns: { [CLAUDE_SID]: 'claude' }, gone: [CLAUDE_SID] });
    await runFollowUp('fu', { followUp: 'origin' }, deps);

    expect(starts.map((s) => [s.harness, s.opts.resumeSession])).toEqual([
      ['claude', CLAUDE_SID],
      ['claude', undefined],
    ]);
    expect(starts[1]!.opts.prompt).toContain('Commits so far:');
    expect(starts[1]!.opts.prompt).toContain('The earlier dispatch origin left:');
    const log = notes('fu');
    expect(log.some((n) => n.startsWith('working: resume-fallback: Claude Code returned an error result: No conversation found'))).toBe(true);
    expect(log.at(-1)).toBe('done: finished on claude');
    const ev = readEvidence('fu', 'work');
    expect(ev.resumeFallback).toContain('No conversation found');
    expect(ev.sessionId).toBe('claude-new-2');
  });

  it('a genuine failure after work began is not mistaken for an unresumable session', async () => {
    headlessOrigin('origin', { sessionId: CLAUDE_SID, harness: 'claude' });
    const { deps, starts } = mockDeps({ owns: { [CLAUDE_SID]: 'claude' } });
    await runFollowUp('fu', { followUp: 'origin' }, deps);
    expect(starts).toHaveLength(1);
    expect(readEvidence('fu', 'work').resumeFallback).toBeUndefined();
  });
});

describe('runner — evidence records the harness', () => {
  it('a headless first run stamps the adapter’s harness', async () => {
    const { deps } = mockDeps({ owns: {} });
    await runFollowUp('solo', { harness: 'codex' }, deps);
    expect(readEvidence('solo', 'work')).toMatchObject({ harness: 'codex', sessionId: 'codex-new-1' });
    expect(notes('solo')[0]).toBe('working');
  });

  it('a claude model on a codex spawn is dropped for codex’s default and noted', async () => {
    const { deps, starts } = mockDeps({ owns: {} });
    await runFollowUp('m', { harness: 'codex', model: 'claude-opus-5-5' }, deps);
    expect(starts[0]!.opts.model).toBeUndefined();
    expect(notes('m')[0]).toBe("working: model claude-opus-5-5 is a claude model — dropped, using codex's default");
    expect(notes('m').at(-1)).toBe('done: finished on codex');
  });

  it('a gpt model on a claude spawn is dropped too; a matching model passes through', async () => {
    const { deps, starts } = mockDeps({ owns: {} });
    await runFollowUp('g', { harness: 'claude', model: 'gpt-5' }, deps);
    await runFollowUp('k', { harness: 'codex', model: 'gpt-5' }, deps);
    expect(starts.map((s) => s.opts.model)).toEqual([undefined, 'gpt-5']);
  });

  it('a trap-claimed catch stamps the trap’s harness', () => {
    trapBuiltOrigin('caught', 'codex', CODEX_SID);
    expect(readEvidence('caught', 'work')).toMatchObject({ harness: 'codex', sessionId: CODEX_SID });
  });
});

describe('resolveSessionHarness — UUID backfill only when evidence lacks harness', () => {
  it('evidence without harness backfills from the session id version', () => {
    headlessOrigin('old7', { sessionId: CODEX_SID }, { harness: 'claude' });
    headlessOrigin('old4', { sessionId: CLAUDE_SID }, { harness: 'codex' });
    expect(resolveSessionHarness('old7')).toMatchObject({ harness: 'codex', source: 'session-id' });
    expect(resolveSessionHarness('old4')).toMatchObject({ harness: 'claude', source: 'session-id' });
  });

  it('evidence harness wins over the session id version', () => {
    headlessOrigin('stamped', { sessionId: CODEX_SID, harness: 'claude' });
    expect(resolveSessionHarness('stamped')).toMatchObject({ harness: 'claude', source: 'evidence' });
  });

  it('a non-UUID session id with no evidence harness falls to the descriptor', () => {
    headlessOrigin('opaque', { sessionId: 'sess-1' }, { harness: 'codex' });
    expect(resolveSessionHarness('opaque')).toMatchObject({ harness: 'codex', source: 'descriptor' });
  });
});

describe('planStart — swap respawns, daemon restarts, and pickup rounds share the resolver', () => {
  const cfg = () => loadConfig();

  it('a pickup review round (no --harness) on a trap-built PR resumes the trap’s harness', () => {
    trapBuiltOrigin('impl', 'codex', CODEX_SID);
    const d: Descriptor = { id: 'round', repo: 'r', brief: 'review', followUp: 'impl' };
    expect(planStart({ id: 'round', lane: 'work', descriptor: d, cfg: cfg(), resolvedHarness: 'claude' })).toMatchObject({
      harness: 'codex',
      resume: { sessionId: CODEX_SID, own: false },
    });
  });

  it('a swap respawn of a follow-up starts cold instead of re-resuming the origin', () => {
    headlessOrigin('origin', { sessionId: CLAUDE_SID, harness: 'claude' });
    enqueue({ id: 'fu', repo: 'r', brief: 'b', followUp: 'origin', harness: 'codex' });
    claimNext('work');
    mergeEvidence('fu', 'work', { sessionId: 'claude-own', harness: 'claude' });
    const d = { id: 'fu', repo: 'r', brief: 'b', followUp: 'origin', harness: 'codex' };
    const plan = planStart({ id: 'fu', lane: 'work', descriptor: d, cfg: cfg(), resolvedHarness: 'codex' });
    expect(plan.resume).toBeUndefined();
    expect(plan).toMatchObject({ harness: 'codex', cold: { fromHarness: 'claude' } });
  });

  it('a daemon restart resumes the dispatch’s own session under the harness that wrote it', () => {
    enqueue({ id: 'r1', repo: 'r', brief: 'b', followUp: 'x' });
    claimNext('work');
    mergeEvidence('r1', 'work', { sessionId: CODEX_SID, harness: 'codex' });
    const d = { id: 'r1', repo: 'r', brief: 'b' };
    expect(
      planStart({ id: 'r1', lane: 'work', descriptor: d, cfg: cfg(), resolvedHarness: 'claude', envResume: CODEX_SID }),
    ).toMatchObject({ harness: 'codex', resume: { sessionId: CODEX_SID, own: true } });
  });
});
