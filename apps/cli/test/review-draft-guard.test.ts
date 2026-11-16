import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claimNext, enqueue, ensureLayout, observeReviewRequest, readStatusLog, reviewRoundDir, writeReview } from '@lobstah/core';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const cli = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-review-guard-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('returns an invalid draft to the job before recording done, then accepts the corrected verdict', () => {
  enqueue({ id: ID, repo: 'web', brief: 'Draft a PR review' }, 'chore');
  claimNext('chore');
  const { item } = observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number: 7, title: 'Review', author: 'dana', url: 'https://github.com/acme/web/pull/7', headSha: 'head' },
    round: { id: 'round', requestedAt: new Date().toISOString() },
  });
  Object.assign(item.rounds[0]!, { dispatch: ID, state: 'drafting' });
  writeReview(item);
  const dir = reviewRoundDir(item.key, 'round')!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.md'), 'The approval and Submit gates are pending.');
  fs.writeFileSync(path.join(dir, 'comments.json'), '[]');
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'comment', blocking: [] }));
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const report = () => spawnSync(process.execPath, [cli, 'report', ID, 'done', 'Drafted'], { encoding: 'utf8', env, timeout: 15_000 });
  const refused = report();
  expect(refused.status).not.toBe(0);
  expect(refused.stderr + refused.stdout).toContain('Fix verdict.json');
  expect(readStatusLog(ID, 'chore').map(event => event.verb)).not.toContain('done');
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ verdict: 'approve', blocking: [] }));
  const accepted = report();
  expect(accepted.status, accepted.stderr).toBe(0);
  expect(readStatusLog(ID, 'chore').at(-1)?.verb).toBe('done');
});
