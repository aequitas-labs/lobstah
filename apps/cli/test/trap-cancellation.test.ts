import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimBait, complete, enqueue, ensureLayout, latestRound, observeReviewRequest, readReview, readStatusLog, signOnTrap, writeReview } from '@lobstah/core';
import { draftReviews } from '../../pick/src/loops/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const session = 'cancelled-review-session';
const id = 'cancelled-review-job';
const key = 'review:acme/web#1';
let home: string;
const run = (args: string[], input?: Record<string, unknown>) => spawnSync(process.execPath, [cli, ...args], {
  cwd: home, encoding: 'utf8', timeout: 15000,
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CLAUDE') && !name.startsWith('CODEX'))), LOBSTAH_HOME: home },
  input: input ? JSON.stringify(input) : undefined,
});
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-review-'));
  process.env.LOBSTAH_HOME = home; ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), '[soak]\nbeat = false\n[reviews]\nenabled = true\nmode = "auto-review"\n[repos.web]\npath = "/w"\n');
  const trap = signOnTrap({ sessionId: session, harness: 'codex', repo: 'web', worktree: home, cwd: home, ttlMs: 60000 });
  if (!('ok' in trap)) throw new Error('trap not available');
  enqueue({ id, repo: 'web', brief: 'review', readOnly: true, for: `wt:${trap.ok.trapId}` }, 'chore');
  expect(claimBait(trap.ok)?.id).toBe(id);
  const { item } = observeReviewRequest({ pr: { owner: 'acme', repo: 'web', number: 1, url: 'https://github.com/acme/web/pull/1', title: 'Review', author: 'dana', headSha: 'aaaaaaa1', repoKey: 'web' }, round: { id: 'round', requestedAt: new Date().toISOString() } });
  Object.assign(item.rounds[0]!, { dispatch: id, state: 'drafting', publish: true }); writeReview(item);
});
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it.each(['claude', 'codex'])('%s: cancel stops a running trap review at the tool hook and fails its round', harness => {
  expect(run(['cancel', id]).status).toBe(0);
  const input = { session_id: session, cwd: home, tool_name: 'Bash', tool_input: { command: 'git diff' }, ...(harness === 'codex' ? { turn_id: 'turn' } : {}) };
  const blocked = run(['hook', 'pre-tool-use', ...(harness === 'codex' ? ['codex'] : [])], input);
  expect(blocked.status, blocked.stderr).toBe(0);
  expect(JSON.parse(blocked.stdout).hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' });
  expect(readStatusLog(id, 'chore').at(-1)).toMatchObject({ verb: 'failed', note: expect.stringContaining('cancelled') });
  const stopped = run(['hook', 'post-tool-use'], input);
  expect(stopped.status, stopped.stderr).toBe(0);
  expect(JSON.parse(stopped.stdout)).toMatchObject({ continue: false, stopReason: expect.stringContaining('cancelled') });
  draftReviews('chris');
  expect(latestRound(readReview(key)!)).toMatchObject({ state: 'failed', reason: expect.stringContaining('cancelled') });
  complete(id, 'chore');
  expect(JSON.parse(run(['hook', 'pre-tool-use', 'codex'], input).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  const waiting = { ...input, tool_input: { command: 'lobstah soak --wait --timeout 600' } };
  expect(run(['hook', 'pre-tool-use', 'codex'], waiting).stdout).not.toContain('"permissionDecision":"deny"');
  const chain = { ...input, tool_input: { command: 'lobstah soak --wait; git diff' } };
  expect(JSON.parse(run(['hook', 'pre-tool-use', 'codex'], chain).stdout).hookSpecificOutput.permissionDecision).toBe('deny');
});
