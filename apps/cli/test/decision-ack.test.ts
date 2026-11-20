import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ACK_CLEAR_MS,
  ackDecision,
  answerDecision,
  appendStatus,
  askDecision,
  awaitingAckDecisions,
  claimNext,
  decisionHandoff,
  enqueue,
  ensureLayout,
  handoffDecisions,
  loadConfig,
  prepareRunCard,
  readDecisionAck,
  readDecisionAnswer,
  recordHelmPass,
  relieveHelm,
  takeHelm,
} from '@lobstah/core';
import type { AskOptions, DecisionMeta } from '@lobstah/core';
import { glassDecisions } from '../src/decisions.js';
import { wakeIndex } from '../src/wait-wakes.js';
import { decisionCards, openDecisionOrder } from '../../../packages/glass-ui/src/glass-diff.js';
import { removeTempDir } from '../../../test/temp-dir.js';

/**
 * A card's answer is handed to the helm: it stays `answered` until the helm
 * acks it with `man ack`, then `acked`, and the glass clears it after
 * ACK_CLEAR_MS. With no helm on the card's grounds, an answer needs no ack.
 */

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const sessionId = 'ack-helm';
const dispatchId = '22222222-2222-4222-8222-222222222222';
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-decision-ack-'));
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

function lobstah(args: string[], input?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env, input, timeout: 15_000 });
}

/** The helm's Stop hook: its block reason, or '' when the stop goes through. */
function stop(): string {
  const result = lobstah(['man', 'haul'], JSON.stringify({ session_id: sessionId }));
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { decision?: string; reason?: string })
    .find((out) => out.decision === 'block')?.reason ?? '';
}

describe('the hand-off state', () => {
  it('an answer awaits the ack, the ack holds its note once, and the acked card clears after the grace', () => {
    const card = askCard('Ship 0.9?', { options: ['Ship', 'Hold'] });
    expect(decisionHandoff(card.key)).toBeUndefined();
    expect(() => ackDecision(card.key)).toThrow(/not answered yet/);

    const answeredAt = new Date();
    answerDecision({ key: card.key, option: 'Ship', text: 'after the docs land', by: 'glass', maxBytes: 1024, now: answeredAt });
    expect(readDecisionAnswer(card.key)?.awaitsAck).toBe(true);
    expect(decisionHandoff(card.key)?.state).toBe('answered');
    expect(awaitingAckDecisions().map((d) => d.key)).toEqual([card.key]);
    expect(handoffDecisions().map((d) => d.key)).toEqual([card.key]);

    const ackedAt = new Date(answeredAt.getTime() + 1000);
    const ack = ackDecision(card.key, { note: '  Sent the release\n to the trap ', now: ackedAt });
    expect(ack).toEqual({ key: card.key, ackedAt: ackedAt.toISOString(), note: 'Sent the release to the trap', by: 'ack' });
    expect(() => ackDecision(card.key, { note: 'again' })).toThrow(/already acked/);
    expect(readDecisionAck(card.key)?.note).toBe('Sent the release to the trap');
    expect(decisionHandoff(card.key)?.state).toBe('acked');
    expect(awaitingAckDecisions()).toEqual([]);
    expect(handoffDecisions(ackedAt.getTime() + ACK_CLEAR_MS - 1).map((d) => d.key)).toEqual([card.key]);
    expect(handoffDecisions(ackedAt.getTime() + ACK_CLEAR_MS)).toEqual([]);
  });

  it('with no helm on the card grounds, an answer needs no ack, as before', () => {
    const other = askCard('Other grounds', { grounds: 'beta', options: ['Yes'] });
    answerDecision({ key: other.key, option: 'Yes', by: 'glass', maxBytes: 1024 });
    expect(readDecisionAnswer(other.key)?.awaitsAck).toBeUndefined();
    expect(decisionHandoff(other.key)).toBeUndefined();
    expect(() => ackDecision(other.key)).toThrow(/needs no ack/);

    relieveHelm(sessionId);
    const headless = askCard('No helm', { options: ['Yes'] });
    answerDecision({ key: headless.key, option: 'Yes', by: 'glass', maxBytes: 1024 });
    expect(decisionHandoff(headless.key)).toBeUndefined();
    expect(awaitingAckDecisions()).toEqual([]);
  });

  it('run cards and answers delivered to a worker inbox need no helm ack', () => {
    const scriptFile = path.join(home, 'check.sh');
    fs.writeFileSync(scriptFile, 'echo ok\n');
    const run = askCard('Run the check', { run: prepareRunCard({ scriptFile, cwd: home }), options: ['Decline'] });
    answerDecision({ key: run.key, option: 'Decline', by: 'glass', maxBytes: 1024 });
    expect(decisionHandoff(run.key)).toBeUndefined();

    enqueue({ id: dispatchId, repo: 'web', brief: 'Pick a schema' });
    claimNext('work');
    appendStatus(dispatchId, 'work', 'needs-decision', 'v1 or v2?');
    const framed = askCard('Which schema?', { dispatch: dispatchId, lane: 'work', repo: 'web', options: ['v1', 'v2'] });
    answerDecision({ key: framed.key, option: 'v2', by: 'glass', maxBytes: 1024 });
    expect(decisionHandoff(framed.key)).toBeUndefined();
  });
});

describe('the helm acks', () => {
  it('man ack records the note; the Stop hook blocks on the answer until then, and man report never acks', () => {
    const card = askCard('Ship 0.9?', { options: ['Ship', 'Hold'] });
    answerDecision({ key: card.key, option: 'Ship', text: 'after the docs land', by: 'glass', maxBytes: 1024 });

    const first = stop();
    expect(first).toContain('answered-cards[1]{key,title,answer,age}:');
    expect(first).toContain(`  ${card.key},Ship 0.9?,"Ship" · after the docs land,`);
    expect(first).toContain(`lobstah man ack <key> "<what you did>"`);
    // Unpaced: an answer awaiting the helm blocks every turn end, unlike an open card's reminder.
    expect(stop()).toContain(card.key);

    const report = lobstah(['man', 'report', '--session', sessionId]);
    expect(report.status, report.stderr).toBe(0);
    expect(decisionHandoff(card.key)?.state).toBe('answered');
    expect(stop()).toContain(card.key);

    const tend = lobstah(['man', 'tend']);
    expect(tend.stdout).toContain('answered-cards[1]{key,title,answer,age}:');

    const ack = lobstah(['man', 'ack', card.key, 'Started the release', '--session', sessionId]);
    expect(ack.status, ack.stderr).toBe(0);
    expect(ack.stdout).toContain(`key: ${card.key}`);
    expect(ack.stdout).toContain('note: Started the release');
    expect(readDecisionAck(card.key)?.by).toBe('ack');
    expect(stop()).toBe('');
    expect(lobstah(['man', 'tend']).stdout).not.toContain('answered-cards');

    const again = lobstah(['man', 'ack', card.key, '--session', sessionId]);
    expect(again.status).not.toBe(0);
    expect(again.stdout + again.stderr).toMatch(/already acked/);
  }, 30_000);

  it('only the helm acks', () => {
    const card = askCard('Ship 0.9?', { options: ['Ship'] });
    answerDecision({ key: card.key, option: 'Ship', by: 'glass', maxBytes: 1024 });
    const stranger = lobstah(['man', 'ack', card.key, '--session', 'someone-else']);
    expect(stranger.status).not.toBe(0);
    expect(decisionHandoff(card.key)?.state).toBe('answered');
  }, 30_000);

  it('withdrawing or replacing an answered card acks it', () => {
    const withdrawn = askCard('Withdraw me', { options: ['Yes'] });
    answerDecision({ key: withdrawn.key, option: 'Yes', by: 'glass', maxBytes: 1024 });
    const out = lobstah(['man', 'ask', '--withdraw', withdrawn.key, '--session', sessionId]);
    expect(out.status, out.stderr).toBe(0);
    expect(readDecisionAck(withdrawn.key)).toMatchObject({ note: 'Withdrawn', by: 'withdraw' });

    const replaced = askCard('Replace me', { options: ['Yes'] });
    answerDecision({ key: replaced.key, option: 'Yes', by: 'glass', maxBytes: 1024 });
    const next = askCard('The follow-up', { replace: replaced.key });
    expect(readDecisionAck(replaced.key)).toMatchObject({ note: `Replaced by ${next.key}`, by: 'replace' });
    expect(awaitingAckDecisions()).toEqual([]);
  }, 30_000);

  it('send --for-decision acks the card once the message is delivered, and refuses a card with nothing to ack', () => {
    enqueue({ id: dispatchId, repo: 'web', brief: 'Ship it' });
    const card = askCard('Ship 0.9?', { options: ['Ship'] });
    const refused = lobstah(['send', dispatchId, '--for-decision', card.key, 'go', '--session', sessionId]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(/no answer awaiting your ack/);

    answerDecision({ key: card.key, option: 'Ship', by: 'glass', maxBytes: 1024 });
    const sent = lobstah(['send', dispatchId, '--for-decision', card.key, 'Ship it now', '--session', sessionId]);
    expect(sent.status, sent.stderr).toBe(0);
    expect(sent.stdout).toContain(`acked: ${card.key}`);
    expect(readDecisionAck(card.key)).toMatchObject({ note: `Sent to ${dispatchId.slice(0, 8)}: Ship it now`, by: 'send' });
  }, 30_000);
});

describe('man wait', () => {
  it('starts the wake with an index line, and the decision-answer event asks for the ack', () => {
    const card = askCard('Ship 0.9?', { options: ['Ship'] });
    answerDecision({ key: card.key, option: 'Ship', by: 'glass', maxBytes: 1024 });
    const wait = lobstah(['man', 'wait', '--session', sessionId, '--timeout', '2']);
    expect(wait.status, wait.stderr).toBe(0);
    const lines = wait.stdout.split('\n');
    expect(lines[0]).toBe(`wake[1]: answer ${card.key.slice('decision:'.length)}`);
    expect(wait.stdout).toContain('event: decision-answer');
    expect(wait.stdout).toContain(`lobstah man ack ${card.key} \\"<what you did>\\"`);
  }, 30_000);

  it('the index names every event in the wake, by kind and id', () => {
    const line = wakeIndex({
      todos: [{ grounds: 'alpha', id: 1510, text: 'check', firedAt: '', firedBy: 'time', repeats: false }],
      events: [{ id: dispatchId, lane: 'work', entry: { verb: 'needs-decision', at: '' } }] as never,
      replies: [{ id: 'a89ad2ba-0000-4000-8000-000000000000', lane: 'work', entry: { verb: 'working', at: '' }, sent: 'go' }] as never,
      notices: [{ seq: '1', kind: 'trap-stowed', at: '', text: 'stowed' }] as never,
    });
    expect(line).toBe('wake[4]: todo 1510, needs-decision 22222222, trap-stowed, reply a89ad2ba');
  });
});

describe('the glass', () => {
  it('hands the glass only the state, keeps the card out of the open order, then clears it', () => {
    const card = askCard('Ship 0.9?', { options: ['Ship'] });
    answerDecision({ key: card.key, option: 'Ship', text: 'today', by: 'glass', maxBytes: 1024 });
    const spinning = glassDecisions().find((d) => d.key === card.key);
    expect(spinning?.handoff).toEqual({ state: 'answered', answeredAt: readDecisionAnswer(card.key)!.answeredAt });
    const cards = decisionCards([], glassDecisions());
    expect(cards.map((c) => c.key)).toEqual([card.key]);
    expect(openDecisionOrder(cards, () => false)).toEqual([]);

    ackDecision(card.key, { note: 'Released' });
    // The glass gets the state only: the note stays in the record and the CLI.
    const acked = glassDecisions().find((d) => d.key === card.key)?.handoff;
    expect(acked).toEqual({ state: 'acked', answeredAt: readDecisionAnswer(card.key)!.answeredAt, ackedAt: readDecisionAck(card.key)!.ackedAt });
    expect(glassDecisions([...handoffDecisions(Date.now() + ACK_CLEAR_MS)])).toEqual([]);
  });
});
