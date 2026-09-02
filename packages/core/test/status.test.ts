import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout, readStatusLog, reconcile } from '../src/index.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-test-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('status write path', () => {
  it('accepts the six verbs', () => {
    for (const v of ['working', 'needs-decision', 'blocked', 'paused', 'done', 'failed']) {
      appendStatus('s1', 'work', v);
    }
    expect(readStatusLog('s1', 'work')).toHaveLength(6);
  });

  it('rejects anything outside the set at the write path', () => {
    expect(() => appendStatus('s2', 'work', 'idle')).toThrow(/invalid status verb/);
    expect(() => appendStatus('s2', 'work', 'DONE')).toThrow(/invalid status verb/);
    expect(readStatusLog('s2', 'work')).toHaveLength(0);
  });

  it('skips malformed lines instead of failing the read', () => {
    appendStatus('s3', 'work', 'working');
    fs.appendFileSync(path.join(home, 'state', 's3.status'), 'garbage\n{"verb":"nonsense","at":"x"}\n');
    appendStatus('s3', 'work', 'done');
    const log = readStatusLog('s3', 'work');
    expect(log.map((e) => e.verb)).toEqual(['working', 'done']);
  });
});

describe('reconcile', () => {
  const at = new Date().toISOString();
  it('missing data is unknown, never idle', () => {
    expect(reconcile({ log: [] })).toBe('unknown');
  });
  it('terminal verbs win over activity', () => {
    expect(reconcile({ log: [{ at, verb: 'done' }], lastEventAt: Date.now() })).toBe('done');
  });
  it('fresh events mean working when the log is stale-working', () => {
    expect(reconcile({ log: [{ at, verb: 'working' }], lastEventAt: Date.now() })).toBe('working');
  });
  it('a declared needs-decision survives fresh events', () => {
    expect(reconcile({ log: [{ at, verb: 'needs-decision' }], lastEventAt: Date.now() })).toBe('needs-decision');
  });
  it('stale events fall back to the log', () => {
    expect(
      reconcile({ log: [{ at, verb: 'blocked' }], lastEventAt: Date.now() - 10 * 60_000 }),
    ).toBe('blocked');
  });
});
