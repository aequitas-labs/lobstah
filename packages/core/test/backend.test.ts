import { beforeEach, afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { coordinationDescriptor, localBackend, parseBackendLocation } from '../src/backend.js';
import { ensureLayout } from '../src/paths.js';
import { readStatusLog } from '../src/status.js';
import { signOnTrap } from '../src/soak.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'backend-')); process.env.LOBSTAH_HOME = home; ensureLayout(); });
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });
it('defaults to local and validates explicit remote locations without embedding secrets', () => {
  expect(parseBackendLocation(undefined)).toBeUndefined();
  expect(parseBackendLocation({ kind: 'server', url: 'http://127.0.0.1:8787/', account: 'test', tokenEnv: 'LOBSTAH_TOKEN' })?.url).toBe('http://127.0.0.1:8787');
  expect(() => parseBackendLocation({ kind: 'server', url: 'http://remote.test', account: 'test', tokenEnv: 'TOKEN' })).toThrow('HTTPS');
});
it('only serializes coordination, not worker paths, env, setup, or attachments', () => {
  const d = coordinationDescriptor({ id: 'one', repo: 'repo', brief: 'work', env: { SECRET: 'never sent' }, flags: ['--unsafe'], attachments: [{ name: 'x', path: '/private/x', bytes: 1, type: 'text/plain' }] });
  expect(JSON.stringify(d)).not.toMatch(/SECRET|private|unsafe/);
});
it('the local adapter uses the existing queue, sticky addressing and report/inbox paths', async () => {
  const worktree = path.join(home, 'checkout'); fs.mkdirSync(worktree);
  const result = signOnTrap({ worktree, cwd: worktree, repo: 'repo', harness: 'codex', sessionId: 'session', ttlMs: 60_000 });
  if (!('ok' in result)) throw new Error('held');
  const b = localBackend(result.ok);
  await b.enqueue({ id: 'other', repo: 'repo', brief: 'other', for: 'wt:foreign' }, 'other');
  await b.enqueue({ id: 'one', repo: 'repo', brief: 'work', for: `wt:${result.ok.trapId}` }, 'one');
  expect((await b.claim('claim'))?.dispatch.id).toBe('one');
  await b.report('one', { verb: 'working', note: 'started' }, 'report');
  expect(readStatusLog('one', 'work').at(-1)?.note).toBe('started');
  await b.send('one', 'hello', 'send'); const [m] = await b.messages('one');
  expect(m.text).toBe('hello'); await b.receipt('one', m.id, 'receipt');
  expect(await b.messages('one')).toEqual([]);
});
