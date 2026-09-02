import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, ensureLayout } from '@lobstah/core';
import { attentionNow, notifiableIds, pendingNotifications } from '../src/notify.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-notify-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('notifications', () => {
  it('emits only wake-worthy verbs, once each', () => {
    appendStatus('n1', 'work', 'working');
    appendStatus('n1', 'work', 'needs-decision', 'which db?');
    expect(pendingNotifications('n1', 'work').map((e) => e.entry.verb)).toEqual(['needs-decision']);
    expect(pendingNotifications('n1', 'work')).toEqual([]); // cursor advanced
    appendStatus('n1', 'work', 'done');
    expect(pendingNotifications('n1', 'work').map((e) => e.entry.verb)).toEqual(['done']);
  });

  it('the cursor swallows quiet verbs without emitting', () => {
    appendStatus('n2', 'work', 'working');
    expect(pendingNotifications('n2', 'work')).toEqual([]);
    appendStatus('n2', 'work', 'working', 'attempt 2');
    expect(pendingNotifications('n2', 'work')).toEqual([]);
  });

  it('custom verb sets are honored', () => {
    appendStatus('n3', 'work', 'working');
    expect(pendingNotifications('n3', 'work', ['working']).map((e) => e.entry.verb)).toEqual(['working']);
  });

  it('first sight with a baseline swallows history but keeps fresh entries', () => {
    appendStatus('n6', 'work', 'failed', 'ancient history');
    const future = Date.now() + 60_000;
    expect(pendingNotifications('n6', 'work', undefined, future)).toEqual([]); // baselined, not emitted
    appendStatus('n6', 'work', 'needs-decision', 'fresh');
    expect(pendingNotifications('n6', 'work', undefined, future).map((e) => e.entry.verb)).toEqual([
      'needs-decision',
    ]); // cursor exists now — sinceMs no longer applies
  });

  it('a standing attention state is reported once, not on every check', () => {
    fs.mkdirSync(path.join(home, 'active', 'a1'));
    appendStatus('a1', 'work', 'working');
    appendStatus('a1', 'work', 'needs-decision', 'which db?');
    expect(attentionNow().map((e) => e.id)).toEqual(['a1']);
    expect(attentionNow()).toEqual([]); // consumed — no re-wake loop
    // the human answers, the agent works, then hits a NEW question
    appendStatus('a1', 'work', 'working', 'answered, continuing');
    appendStatus('a1', 'work', 'needs-decision', 'and the cache layer?');
    expect(attentionNow().map((e) => e.entry.note)).toEqual(['and the cache layer?']);
  });

  it('an unanswered question re-fires after the remind window, not before', () => {
    fs.mkdirSync(path.join(home, 'active', 'a3'));
    appendStatus('a3', 'work', 'needs-decision', 'ok to deploy?');
    const t0 = Date.now();
    expect(attentionNow(true, 900_000, t0)).toHaveLength(1); // first report
    expect(attentionNow(true, 900_000, t0 + 60_000)).toEqual([]); // inside window: quiet
    expect(attentionNow(true, 900_000, t0 + 901_000)).toHaveLength(1); // reminder
    expect(attentionNow(true, 900_000, t0 + 902_000)).toEqual([]); // timer reset by reminder
    // the answer arrives: agent works, question resolved — reminders end
    appendStatus('a3', 'work', 'working', 'answered');
    expect(attentionNow(true, 900_000, t0 + 2_000_000)).toEqual([]);
  });

  it('remindMs 0 is pure at-most-once', () => {
    fs.mkdirSync(path.join(home, 'active', 'a4'));
    appendStatus('a4', 'work', 'blocked', 'creds');
    const t0 = Date.now();
    expect(attentionNow(true, 0, t0)).toHaveLength(1);
    expect(attentionNow(true, 0, t0 + 10_000_000)).toEqual([]);
  });

  it('peek reports without consuming', () => {
    fs.mkdirSync(path.join(home, 'active', 'a2'));
    appendStatus('a2', 'work', 'blocked', 'waiting on creds');
    expect(attentionNow(false)).toHaveLength(1);
    expect(attentionNow(false)).toHaveLength(1); // still standing
    expect(attentionNow(true)).toHaveLength(1); // consumed now
    expect(attentionNow(false)).toEqual([]);
  });

  it('notifiableIds lists recent status files per lane', () => {
    appendStatus('n4', 'work', 'working');
    appendStatus('n5', 'chore', 'working');
    expect(notifiableIds('work')).toEqual(['n4']);
    expect(notifiableIds('chore')).toEqual(['n5']);
  });
});
