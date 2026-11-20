// Build first with `pnpm build`, then run `node scripts/repro-question-card.mjs`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendStatus, claimNext, enqueue, ensureLayout } from '../packages/core/dist/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-question-repro-'));
const previousHome = process.env.LOBSTAH_HOME;
process.env.LOBSTAH_HOME = home;
const cli = fileURLToPath(new URL('../apps/cli/dist/main.js', import.meta.url));
const id = '11111111-1111-4111-8111-111111111111';
function run(...args) {
  const env = { ...process.env, LOBSTAH_HOME: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 10_000 });
  assert.ifError(result.error);
  console.log(`lobstah ${args.join(' ')} → exit ${result.status}\n${result.stdout.trim()}\n`);
  return result;
}
try {
  console.log(`Temporary LOBSTAH_HOME: ${home}\n`);
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'remindSecs = 1\n');
  enqueue({ id, repo: 'r', brief: 'Reproduce question wakes' });
  claimNext('work');
  appendStatus(id, 'work', 'needs-decision', 'Which version?');
  const ask = run('man', 'ask', id, '--title', 'Which version?');
  assert.equal(ask.status, 0);
  const key = /^key: (decision:[a-f0-9]{8})$/m.exec(ask.stdout)?.[1];
  assert.ok(key);
  assert.equal(run('man', 'wait', '--timeout', '0.01').status, 0);
  // Cross the reminder interval as well as re-arming immediately.
  await new Promise(resolve => setTimeout(resolve, 1100));
  for (let i = 0; i < 3; i++) assert.equal(run('man', 'wait', '--timeout', '0.01').status, 3);
  appendStatus(id, 'work', 'needs-decision', 'New information: version B is unavailable');
  assert.equal(run('man', 'wait', '--timeout', '0.01').status, 0);
  run('man', 'tend');
  assert.equal(run('man', 'ask', '--withdraw', key).status, 0);
  console.log('PASS: one question wake, three quiet re-arms, a new question wake, and withdrawal.');
} finally {
  if (previousHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
}
