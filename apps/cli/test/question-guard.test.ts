import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { askDecision, enqueue, ensureLayout, listNotices, postNotice, signOnTrap, takeHelm, unseenNotices } from '@lobstah/core';
import type { HelmRegistration } from '@lobstah/core';
import { endingMessage, extractHumanQuestions, helmQuestionGuard } from '../src/question-guard.js';
import { armWatcher } from '../src/watchers.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let helm: HelmRegistration;
const START = '2026-10-05T12:00:00.000Z';
const END = '2026-10-05T12:01:00.000Z';
const QUESTION = 'Which do you want? Shall I dispatch it?';
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const input = () => ({ session_id: helm.sessionId, transcript_path: path.join(home, 'transcript.jsonl') });
function transcript(text = QUESTION, id = 'assistant-1', turn = 'user-1') {
  fs.writeFileSync(
    input().transcript_path,
    [
      { type: 'user', uuid: turn, timestamp: START, message: { role: 'user', content: 'Plan the next step.' } },
      { type: 'assistant', uuid: 'tool', timestamp: START, message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', uuid: 'result', timestamp: END, message: { content: [{ type: 'tool_result', content: 'output' }] } },
      { type: 'assistant', uuid: id, timestamp: END, message: { content: [{ type: 'text', text }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  );
}
function stop(extra: Record<string, unknown> = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('CODEX')));
  return spawnSync(process.execPath, [cli, 'hook', 'stop', '--timeout', '0'], {
    cwd: home,
    env: { ...env, LOBSTAH_HOME: home },
    encoding: 'utf8',
    input: JSON.stringify({ ...input(), hook_event_name: 'Stop', cwd: home, ...extra }),
    timeout: 10_000,
  });
}
function card(at = END, grounds = 'fleet', session = helm.sessionId, replace?: string) {
  return askDecision({
    title: 'An unrelated title still satisfies the turn',
    askedBy: 'helm',
    askedBySession: session,
    grounds,
    maxBytes: 1024,
    now: new Date(at),
    replace,
  }).meta;
}
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-guard-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\narmGraceSecs = 0\n');
  const signed = takeHelm({
    sessionId: 'helm-session',
    grounds: { name: 'fleet', repos: ['web'] },
    ttlMs: 60_000,
    identity: { harness: 'claude' },
  });
  if (!('ok' in signed)) throw new Error('unexpected helm hold');
  helm = signed.ok;
  transcript();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

describe('human-question extraction', () => {
  it('finds plain, wrapped, and several questions', () => {
    expect(extractHumanQuestions('Which do you\nwant? Shall I dispatch it?\n\n- Proceed?')).toEqual([
      'Which do you want?',
      'Shall I dispatch it?',
      'Proceed?',
    ]);
  });
  it('ignores both fence styles, indented code, block quotes, and inline quoted text', () => {
    expect(
      extractHumanQuestions(
        '```md\nWhich do you want?\n```\n~~~\nShall I dispatch it?\n~~~\n    Proceed?\n> Which one?\nThe example is "Do you agree?" and `Proceed?`.\nWhich one?',
      ),
    ).toEqual(['Which one?']);
  });
  it('skips rhetorical lead-ins and prose without a question', () => {
    expect(extractHumanQuestions('Why does this matter? How does this work? What if it fails? All done.')).toEqual([]);
  });
  it('ignores single-quoted examples without stripping contractions', () => {
    expect(extractHumanQuestions("The example is 'Which do you want?' or ‘Shall I dispatch it?’.")).toEqual([]);
    expect(extractHumanQuestions("Would you prefer the option you'd picked earlier?")).toEqual([
      "Would you prefer the option you'd picked earlier?",
    ]);
  });
  it('recognizes direct human address and permission prompts, not technical questions', () => {
    expect(extractHumanQuestions('What do you think? Should we ship? Is that okay? Where is the database?')).toEqual([
      'What do you think?',
      'Should we ship?',
      'Is that okay?',
    ]);
  });
});

describe('guard state and transcript boundaries', () => {
  it('reads only the final assistant text, not tool results; records the human turn boundary', () => {
    expect(endingMessage(input(), 'claude')).toMatchObject({
      id: 'assistant-1',
      text: QUESTION,
      turnId: 'user-1',
      start: Date.parse(START),
    });
    fs.appendFileSync(
      input().transcript_path,
      `\n${JSON.stringify({ type: 'user', uuid: 'user-2', timestamp: END, message: { content: 'A new turn' } })}`,
    );
    expect(endingMessage(input(), 'claude')).toBeUndefined();
  });
  it('blocks once across hook processes; a revised final message in the same turn passes', () => {
    expect(helmQuestionGuard(input(), helm, 'block')).toContain('2 question(s)');
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
    transcript('Would you like another option?', 'assistant-2');
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
    transcript(QUESTION, 'assistant-3', 'user-2');
    expect(helmQuestionGuard(input(), helm, 'block')).toContain('2 question(s)');
  });
  it('honors stop_hook_active without blocking', () => {
    expect(helmQuestionGuard({ ...input(), stop_hook_active: true }, helm, 'block')).toBeUndefined();
  });
  it('a new or replaced card during this turn suffices without matching text', () => {
    const old = card('2026-10-05T11:00:00.000Z');
    card(END, 'fleet', helm.sessionId, old.key);
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
  });
  it('old cards, other grounds, other sessions, and worker cards do not satisfy this turn', () => {
    card('2026-10-05T11:00:00.000Z');
    card(END, 'elsewhere');
    card(END, 'fleet', 'other-helm');
    askDecision({ title: 'Worker question', askedBy: 'worker', grounds: 'fleet', maxBytes: 1024, now: new Date(END) });
    expect(helmQuestionGuard(input(), helm, 'block')).toContain('without a card');
  });
  it('warn posts one tend notice, never a Stop wake; off is entirely inert', () => {
    expect(helmQuestionGuard(input(), helm, 'off')).toBeUndefined();
    expect(listNotices()).toEqual([]);
    expect(helmQuestionGuard(input(), helm, 'warn')).toBeUndefined();
    expect(helmQuestionGuard(input(), helm, 'warn')).toBeUndefined();
    expect(listNotices()).toHaveLength(1);
    expect(listNotices()[0]?.kind).toBe('helm-question-guard');
    expect(unseenNotices(false)).toEqual([]);
  });
  it('no questions, missing transcripts, and malformed rows fail open', () => {
    transcript('All done.');
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
    fs.writeFileSync(input().transcript_path, 'not json\nnull\n');
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
    fs.unlinkSync(input().transcript_path);
    expect(helmQuestionGuard(input(), helm, 'block')).toBeUndefined();
  });
  it('truncates long previews and the number of listed questions', () => {
    transcript(Array.from({ length: 8 }, (_, i) => `Would you like ${i} ${'x'.repeat(400)}?`).join('\n\n'));
    const reason = helmQuestionGuard(input(), helm, 'block')!;
    expect(reason).toContain('8 question(s)');
    expect(reason.length).toBeLessThan(1100);
    expect(reason).toContain('…');
  });
  it('supports exposed Codex final text and turn id, including a missing transcript', () => {
    const hook = {
      session_id: helm.sessionId,
      turn_id: 'turn-1',
      last_assistant_message: QUESTION,
      transcript_path: path.join(home, 'missing'),
    };
    expect(helmQuestionGuard(hook, { ...helm, harness: 'codex' }, 'block')).toContain('2 question(s)');
    expect(helmQuestionGuard({ ...hook, last_assistant_message: 'Would you like more?' }, helm, 'block')).toBeUndefined();
    expect(helmQuestionGuard({ ...hook, turn_id: 'turn-2' }, helm, 'block')).toContain('2 question(s)');
  });
  it('uses a supplied Codex transcript turn boundary for card timestamps', () => {
    fs.writeFileSync(
      input().transcript_path,
      [
        { type: 'event_msg', timestamp: START, payload: { type: 'task_started', turn_id: 'turn-1' } },
        {
          type: 'response_item',
          timestamp: END,
          payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: QUESTION }] },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    const hook = { ...input(), turn_id: 'turn-1', last_assistant_message: QUESTION };
    expect(endingMessage(hook, 'codex')?.start).toBe(Date.parse(START));
    card();
    expect(helmQuestionGuard(hook, { ...helm, harness: 'codex' }, 'block')).toBeUndefined();
  });
});

describe('Stop-hook integration', () => {
  it('an uncarded turn blocks, the second stop passes, and a carded turn passes', () => {
    const first = stop();
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({ decision: 'block', reason: expect.stringContaining('without a card') });
    expect(stop().stdout).toBe('');
    transcript(QUESTION, 'assistant-2', 'user-2');
    card();
    expect(stop().stdout).toBe('');
  });
  it('combines the question and watcher-arm checks into one block', () => {
    enqueue({ id: '99999999-9999-4999-8999-999999999999', repo: 'web', brief: 'work' });
    const res = stop();
    const block = JSON.parse(res.stdout);
    expect(block.reason).toContain('Arm the watcher');
    expect(block.reason).toContain('without a card');
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
  });
  it('an armed watcher still gets the guard, and standing attention is combined too', () => {
    enqueue({ id: '99999999-9999-4999-8999-999999999999', repo: 'web', brief: 'work' });
    const watcher = armWatcher(helm.sessionId, 'man');
    try {
      expect(stop().stdout).toContain('without a card');
    } finally {
      watcher.stop();
    }
    transcript(QUESTION, 'assistant-2', 'user-2');
    postNotice({ kind: 'push-failed', text: 'Retry the failed push', repo: 'web' });
    const res = stop();
    const block = JSON.parse(res.stdout);
    expect(block.reason).toContain('Retry the failed push');
    expect(block.reason).toContain('without a card');
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
  });
  it('warn appears in tend, off never blocks, and ordinary sessions and traps are unaffected', () => {
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\nquestionGuard = "warn"\n');
    expect(stop().stdout).toBe('');
    const tend = spawnSync(process.execPath, [cli, 'man', 'tend', '--json'], {
      cwd: home,
      env: { ...process.env, LOBSTAH_HOME: home },
      encoding: 'utf8',
    });
    expect(tend.stdout).toContain('helm-question-guard');
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\nquestionGuard = "off"\n');
    transcript(QUESTION, 'assistant-2', 'user-2');
    expect(stop().stdout).toBe('');
    fs.writeFileSync(path.join(home, 'config.toml'), '[helm]\n');
    expect(stop({ session_id: 'nobody' }).stdout).toBe('');
    const signed = signOnTrap({ sessionId: 'trap-session', harness: 'codex', repo: 'web', worktree: home, cwd: home, ttlMs: 60_000 });
    if (!('ok' in signed)) throw new Error('unexpected trap hold');
    expect(stop({ session_id: 'trap-session', stop_hook_active: true }).stdout).not.toContain('without a card');
  });
});
