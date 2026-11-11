import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  askDecision,
  decisionDir,
  ensureLayout,
  prepareRunCard,
  readRunAttempt,
  readRunOutput,
  withdrawDecision,
  writeRunAttempt,
} from '../src/index.js';
import type { RunAttempt } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-run-history-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  vi.restoreAllMocks();
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

it('retains the result when another process withdraws the card during its final write', () => {
  const scriptFile = path.join(home, 'script.sh');
  fs.writeFileSync(scriptFile, 'echo harmless\n');
  const run = prepareRunCard({ scriptFile, cwd: home });
  const { meta } = askDecision({ title: 'Run it', askedBy: 'helm', options: ['Decline'], run, maxBytes: 1024 });
  const attempt: RunAttempt = {
    id: '11111111-1111-4111-8111-111111111111',
    key: meta.key,
    scriptSha256: run.card.scriptSha256,
    state: 'failed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: { exitCode: 2, timedOut: false, durationMs: 1, outputBytes: 8, scrubbed: 0 },
  };
  const output = path.join(decisionDir(meta.key)!, 'run', attempt.id, 'output.log');
  const write = fs.writeFileSync;
  let withdrawn = false;
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (!withdrawn && String(file).startsWith(output)) {
      withdrawn = true;
      withdrawDecision(meta.key);
    }
    write(file, data, options);
  });
  writeRunAttempt(attempt, 'failure\n');
  expect(withdrawn).toBe(true);
  expect(readRunAttempt(meta.key)).toEqual(attempt);
  expect(readRunOutput(attempt)).toBe('failure\n');
});
