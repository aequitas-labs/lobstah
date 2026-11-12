import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RUN_DONE_GRACE_MS,
  RUN_PROPOSAL_TTL_MS,
  answerDecision,
  archivedDecisionDir,
  askDecision,
  decisionDir,
  ensureLayout,
  prepareRunCard,
  proposeRunScript,
  pruneRunHistory,
  readDecision,
  readRunAttempt,
  recentRuns,
  retireFinishedRuns,
  runProposalsDir,
  standingDecisions,
  writeRunAttempt,
} from '../src/index.js';
import type { RunAttempt, RunState } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * Finished runs leave the glass: a run card stands for RUN_DONE_GRACE_MS
 * after its run ends, so its result can be read, then it's withdrawn and
 * listed under Recent runs. Its history is pruned after the retention.
 */

const NOW = Date.parse('2026-11-12T12:00:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-cleanup-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

let attempts = 0;
/** A run card, with an attempt in `state` that ended `endedAgo` ms before NOW (none when undefined). */
function runCard(title: string, state?: RunState, endedAgo = 0): string {
  const scriptFile = path.join(home, `${title.replace(/\W/g, '')}.sh`);
  fs.writeFileSync(scriptFile, 'echo harmless\n');
  const run = prepareRunCard({ scriptFile, cwd: home });
  const { meta } = askDecision({ title, askedBy: 'helm', options: ['Decline'], run, maxBytes: 1024, repo: 'lobstah' });
  if (state) {
    const n = String(++attempts).padStart(12, '0');
    const attempt: RunAttempt = {
      id: `11111111-1111-4111-8111-${n}`,
      key: meta.key,
      scriptSha256: run.card.scriptSha256,
      state,
      startedAt: new Date(NOW - endedAgo - MIN).toISOString(),
      ...(state === 'running' ? {} : { finishedAt: new Date(NOW - endedAgo).toISOString(), result: { exitCode: state === 'failed' ? 2 : 0, timedOut: false, durationMs: MIN, outputBytes: 3, scrubbed: 0 } }),
    };
    writeRunAttempt(attempt, 'ok\n');
  }
  return meta.key;
}
const standing = () => standingDecisions(NOW).map((d) => d.title);

describe('the grace period', () => {
  it('keeps a finished run on the glass for two minutes, then not', () => {
    runCard('Just finished', 'succeeded', RUN_DONE_GRACE_MS - 1000);
    runCard('Finished a while ago', 'succeeded', RUN_DONE_GRACE_MS + 1000);
    runCard('Failed a while ago', 'failed', 10 * MIN);
    runCard('Stopped a while ago', 'stopped', 10 * MIN);
    runCard('Still running', 'running');
    runCard('Never run');
    expect(standing().sort()).toEqual(['Just finished', 'Never run', 'Still running']);
  });

  it('a declined card leaves at once', () => {
    const key = runCard('Declined');
    answerDecision({ key, option: 'Decline', by: 'glass', maxBytes: 1024 });
    expect(standing()).toEqual([]);
  });
});

describe('retiring finished run cards', () => {
  it('withdraws a card past the grace period and keeps its history, and leaves the rest', () => {
    const old = runCard('Done', 'succeeded', 5 * MIN);
    const recent = runCard('Just done', 'failed', MIN);
    const running = runCard('Running', 'running');
    expect(retireFinishedRuns(NOW)).toEqual([old]);
    expect(readDecision(old)).toBeUndefined();
    expect(fs.existsSync(archivedDecisionDir(old)!)).toBe(true);
    expect(readRunAttempt(old)?.state).toBe('succeeded');
    expect(readDecision(recent)).toBeDefined();
    expect(readDecision(running)).toBeDefined();
    expect(retireFinishedRuns(NOW)).toEqual([]);
  });
});

describe('Recent runs', () => {
  it('lists runs whose cards left, newest first, within seven days, and not one still on the glass', () => {
    runCard('Earlier', 'failed', 3 * 60 * MIN);
    runCard('Later', 'succeeded', 30 * MIN);
    runCard('Long ago', 'succeeded', 8 * DAY);
    runCard('Still on the glass', 'succeeded', MIN);
    const declined = runCard('Ran, then declined', 'stopped', 10 * MIN);
    answerDecision({ key: declined, option: 'Decline', by: 'glass', maxBytes: 1024 });
    retireFinishedRuns(NOW);
    expect(recentRuns(NOW).map((r) => [r.title, r.state, r.exitCode, r.repo])).toEqual([
      ['Ran, then declined', 'stopped', 0, 'lobstah'],
      ['Later', 'succeeded', 0, 'lobstah'],
      ['Earlier', 'failed', 2, 'lobstah'],
    ]);
  });

  it('lists at most twenty', () => {
    for (let i = 0; i < 25; i++) runCard(`Run ${i}`, 'succeeded', (10 + i) * MIN);
    expect(recentRuns(NOW)).toHaveLength(20);
    expect(recentRuns(NOW)[0]!.title).toBe('Run 0');
  });
});

describe('pruning run history', () => {
  it('removes runs and withdrawn cards past the retention, and keeps newer ones and running ones', () => {
    const old = runCard('Old', 'succeeded', 20 * DAY);
    const fresh = runCard('Fresh', 'succeeded', DAY);
    const running = runCard('Running', 'running');
    retireFinishedRuns(NOW);
    expect(pruneRunHistory(14, NOW)).toMatchObject({ attempts: 1, cards: 1 });
    expect(fs.existsSync(archivedDecisionDir(old)!)).toBe(false);
    expect(readRunAttempt(fresh)?.state).toBe('succeeded');
    expect(fs.existsSync(path.join(decisionDir(running)!, 'run', 'latest.json'))).toBe(true);
    expect(pruneRunHistory(14, NOW)).toMatchObject({ attempts: 0, cards: 0 });
  });

  it('keeps everything with a retention of 0', () => {
    runCard('Old', 'succeeded', 400 * DAY);
    retireFinishedRuns(NOW);
    expect(pruneRunHistory(0, NOW)).toMatchObject({ attempts: 0, cards: 0 });
    expect(recentRuns(NOW + 0)).toEqual([]);
  });

  it('drops a proposal the helm never posted after a day, and its empty folder', () => {
    const scriptFile = path.join(home, 'proposed.sh');
    fs.writeFileSync(scriptFile, 'echo proposed\n');
    proposeRunScript('dispatch-old', scriptFile, 'pearl-gull', new Date(NOW - RUN_PROPOSAL_TTL_MS - MIN));
    proposeRunScript('dispatch-new', scriptFile, 'pearl-gull', new Date(NOW - MIN));
    expect(pruneRunHistory(14, NOW).proposals).toBe(1);
    expect(fs.existsSync(runProposalsDir('dispatch-old'))).toBe(false);
    expect(fs.readdirSync(runProposalsDir('dispatch-new'))).toHaveLength(2);
  });
});
