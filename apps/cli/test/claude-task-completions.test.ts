import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureLayout, readTrap, signOnTrap, stowTrap } from '@lobstah/core';
import { ClaudeTaskCompletions } from '../src/claude-task-completions.js';
import { soakPark } from '../src/trap-park.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let transcript: string;
const session = 'background-session';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-claude-tasks-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  transcript = path.join(home, 'session.jsonl');
  fs.writeFileSync(transcript, '');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

/** Claude 2.1.329 queues this record before it can deliver the notification. */
function completion(taskId: string, sessionId = session, status = 'completed', toolUseId = 'bash-task'): string {
  return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', sessionId,
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n<summary>Background command finished</summary>\n</task-notification>` }) + '\n';
}

function signOn(harness: 'claude' | 'codex'): string {
  const worktree = path.join(home, 'worktree'); fs.mkdirSync(worktree);
  const signed = signOnTrap({ repo: 'r', worktree, cwd: worktree, harness, sessionId: session, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('held');
  return signed.ok.trapId;
}

it.each(['completed', 'failed', 'killed'])('a task %s while Claude is parked wakes the park and resumes its turn', async status => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const trapId = signOn('claude');
  const park = soakPark(trapId, undefined, false, transcript);
  fs.appendFileSync(transcript, completion('new-task', session, status));
  await vi.advanceTimersByTimeAsync(1500);
  expect(await park).toBe('woke');
  expect(JSON.parse(output.mock.calls.at(-1)![0])).toEqual({ decision: 'block', reason: expect.stringContaining('background task') });
  expect(readTrap(trapId)?.idleSince).toBeUndefined();
  // Starting another park does not redeliver the same completion.
  expect(await soakPark(trapId, '0', false, transcript)).toBe('timeout');
});

it.each(['old completion', 'another session', 'Codex'])('%s does not wake the park', async scenario => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const trapId = signOn(scenario === 'Codex' ? 'codex' : 'claude');
  if (scenario === 'old completion') fs.appendFileSync(transcript, completion('old-task'));
  let settled = false;
  const park = soakPark(trapId, undefined, false, transcript).then(result => { settled = true; return result; });
  if (scenario !== 'old completion') fs.appendFileSync(transcript, completion('new-task', scenario === 'another session' ? 'other-session' : session));
  await vi.advanceTimersByTimeAsync(3000);
  expect(settled).toBe(false);
  stowTrap(trapId, 'test complete');
  await vi.advanceTimersByTimeAsync(1500);
  expect(await park).toBe('gone');
});

it('ignores park machinery, queue removals, attachments and repeated completion enqueues', () => {
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: session, message: { content: [
    { type: 'tool_use', id: 'listener', name: 'Bash', input: { command: 'lobstah soak --session background-session --wait' } },
  ] } }) + '\n');
  const tasks = new ClaudeTaskCompletions(transcript, session);
  fs.appendFileSync(transcript, completion('park', session, 'completed', 'listener'));
  fs.appendFileSync(transcript, completion('running', session, 'running'));
  fs.appendFileSync(transcript, completion('removed').replace('enqueue', 'remove'));
  fs.appendFileSync(transcript, JSON.stringify({ type: 'attachment', sessionId: session, attachment: { type: 'queued_command', prompt: completion('attachment') } }) + '\n');
  expect(tasks.poll()).toBe(false);
  fs.appendFileSync(transcript, completion('real'));
  expect(tasks.poll()).toBe(true);
  fs.appendFileSync(transcript, completion('real'));
  expect(tasks.poll()).toBe(false);
});

it('handles partial appends, malformed lines, missing files and transcript replacement without replaying history', () => {
  fs.rmSync(transcript);
  const tasks = new ClaudeTaskCompletions(transcript, session);
  expect(tasks.poll()).toBe(false);
  const record = completion('partial');
  fs.writeFileSync(transcript, 'not json\n' + record.slice(0, 40));
  expect(tasks.poll()).toBe(false);
  fs.appendFileSync(transcript, record.slice(40));
  expect(tasks.poll()).toBe(true);
  fs.renameSync(transcript, transcript + '.old');
  fs.writeFileSync(transcript, completion('historical'));
  expect(tasks.poll()).toBe(false);
  fs.appendFileSync(transcript, completion('after-replacement'));
  expect(tasks.poll()).toBe(true);
});
