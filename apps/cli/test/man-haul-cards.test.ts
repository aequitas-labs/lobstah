import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  answerDecision,
  appendStatus,
  askDecision,
  claimNext,
  decisionDir,
  enqueue,
  ensureLayout,
  helmOf,
  loadConfig,
  prepareRunCard,
  recordHelmPass,
  RUN_DONE_GRACE_MS,
  takeHelm,
  withdrawDecision,
} from '@lobstah/core';
import type { AskOptions, DecisionMeta } from '@lobstah/core';
import { openCardsAtStop } from '../src/open-cards.js';
import { HELM_STOP_REMINDER } from '../src/charter.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const sessionId = 'cards-helm';
const dispatchId = '11111111-1111-4111-8111-111111111111';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-haul-cards-'));
  previousHome = process.env.LOBSTAH_HOME;
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `remindSecs = 60\n[helm]\narmGraceSecs = 0\n[repos.web]\npath = '${home.replaceAll('\\', '/')}'\n[repos.api]\npath = '${home.replaceAll('\\', '/')}'\n[grounds.alpha]\nrepos = ['web']\n[grounds.beta]\nrepos = ['api']\n`,
  );
  recordHelmPass('alpha', loadConfig().helm);
  takeHelm({ sessionId, grounds: { name: 'alpha', repos: ['web'] }, ttlMs: 60_000, identity: { harness: 'claude' } });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = previousHome;
  removeTempDir(home);
});

function askCard(title: string, options: Partial<AskOptions> = {}): DecisionMeta {
  return askDecision({ title, grounds: 'alpha', askedBy: 'helm', maxBytes: 1024, ...options }).meta;
}

function askRun(title: string): DecisionMeta {
  const scriptFile = path.join(home, 'harmless.sh');
  fs.writeFileSync(scriptFile, 'echo ready\n');
  return askCard(title, { run: prepareRunCard({ scriptFile, cwd: home }) });
}

function stop(...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, 'man', 'haul', ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    input: JSON.stringify({ session_id: sessionId }),
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout).reason ?? '';
}

/** Runs `lobstah man tend` with the given flags and returns its stdout. */
function tend(...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, 'man', 'tend', ...args], {
    encoding: 'utf8',
    env: { ...process.env, LOBSTAH_HOME: home },
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

it('man tend lists every open card and run card, in text and JSON, until each is answered', () => {
  const run = askRun('Publish the package');
  const plain = askCard('Choose the release', { options: ['Ship', 'Hold'] });
  const other = askCard('Other grounds card', { grounds: 'beta' });

  const text = tend();
  expect(text).toContain('open-cards[3]{kind,key,grounds,title,age,link}:');
  expect(text).toContain(`run,${run.key},alpha,Publish the package,`);
  expect(text).toContain(`card,${plain.key},alpha,Choose the release,`);
  expect(text).toContain(`card,${other.key},beta,Other grounds card,`);

  const report = JSON.parse(tend('--json')) as { openCards?: Array<Record<string, unknown>> };
  expect(report.openCards?.map((card) => [card.kind, card.key, card.grounds])).toEqual(
    expect.arrayContaining([
      ['run', run.key, 'alpha'],
      ['card', plain.key, 'alpha'],
      ['card', other.key, 'beta'],
    ]),
  );
  expect(report.openCards?.find((card) => card.key === run.key)?.link).toBe(
    `http://127.0.0.1:4949/#decision/decision%3A${run.key.slice('decision:'.length)}`,
  );

  answerDecision({ key: plain.key, option: 'Ship', by: 'cli', maxBytes: 1024 });
  const after = JSON.parse(tend('--json')) as { openCards?: Array<{ key: string }> };
  expect(after.openCards?.map((card) => card.key).sort()).toEqual([run.key, other.key].sort());
  expect(tend()).toContain('open-cards[2]{');
  expect(tend()).not.toContain(`card,${plain.key},`);
});

it('lists an unbound run and a paused dispatch card, excluding answered, settled, withdrawn and other grounds cards', () => {
  enqueue({ id: dispatchId, repo: 'web', brief: 'Paused work' });
  claimNext('work');
  appendStatus(dispatchId, 'work', 'paused', 'Waiting for a release');
  const run = askRun('Publish the package');
  const regular = askCard('Choose the release', { dispatch: dispatchId, lane: 'work', repo: 'web' });
  const answered = askCard('Already answered', { options: ['Yes'] });
  answerDecision({ key: answered.key, option: 'Yes', by: 'cli', maxBytes: 1024 });
  const settled = askRun('Finished run');
  fs.writeFileSync(
    path.join(decisionDir(settled.key)!, 'run', 'latest.json'),
    JSON.stringify({ state: 'failed', finishedAt: new Date(Date.now() - RUN_DONE_GRACE_MS - 1000).toISOString() }),
  );
  const withdrawn = askCard('Withdrawn card');
  withdrawDecision(withdrawn.key);
  askCard('Other grounds card', { grounds: 'beta' });

  const reason = stop();
  const listedCards = reason
    .split('\n')
    .filter((line) => /^  (run|card),/.test(line))
    .join('\n');
  expect(reason).toContain(`run,${run.key},Publish the package,`);
  expect(reason).toContain(`card,${regular.key},Choose the release,`);
  expect(reason).toContain(`http://127.0.0.1:4949/#decision/decision%3A${run.key.slice('decision:'.length)}`);
  expect(listedCards).not.toMatch(/Already answered|Finished run|Withdrawn card|Other grounds card/);
  expect(reason.split('\n').at(-1)).toBe(HELM_STOP_REMINDER);
  expect(stop()).not.toContain('open-cards[');
});

it('lists a run card even when no dispatch is in flight, then lets the next quiet Stop end', () => {
  const run = askRun('Run the local check');
  expect(stop()).toContain(`run,${run.key},Run the local check,`);
  expect(stop()).toBe('');
});

it('paces each card across Stop processes, and peeking does not consume its next reminder', () => {
  const now = Date.now();
  const card = askCard('Read this card', { now: new Date(now - 120_000) });
  const helm = helmOf(sessionId)!;
  const config = loadConfig();
  expect(openCardsAtStop(helm, config, false, now)).toContain('2m');
  expect(openCardsAtStop(helm, config, true, now)).toContain(card.title);
  expect(openCardsAtStop(helm, config, false, now + 59_999)).toBe('');
  expect(openCardsAtStop(helm, config, false, now + 60_000)).toContain(card.title);
  expect(openCardsAtStop(helm, config, true, now + 60_000)).toContain(card.title);
  expect(openCardsAtStop(helm, config, false, now + 60_001)).toBe('');
});

it('wakes a parked helm when an open run card appears', async () => {
  enqueue({ id: dispatchId, repo: 'web', brief: 'Queued work keeps the park active' });
  const child = spawn(process.execPath, [cli, 'man', 'haul', '--park', '--timeout', '5'], {
    env: { ...process.env, LOBSTAH_HOME: home },
    stdio: 'pipe',
  });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  child.stdin.end(JSON.stringify({ session_id: sessionId }));
  try {
    const deadline = Date.now() + 4000;
    while (!helmOf(sessionId)?.parkedAt && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(helmOf(sessionId)?.parkedAt).toBeDefined();
    const run = askRun('Check the queued release');
    await ended;
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(output).reason).toContain(`run,${run.key},Check the queued release,`);
    expect(openCardsAtStop(helmOf(sessionId)!, loadConfig(), false)).toBe('');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await ended;
    }
  }
}, 10_000);
