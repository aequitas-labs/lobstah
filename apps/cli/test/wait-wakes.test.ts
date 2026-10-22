import { expect, it } from 'vitest';
import { digestWakeKeys, helmWakeKeys } from '../src/wait-wakes.js';
import type { Digest } from '../src/digest.js';
import type { Notice } from '@lobstah/core';

it('ignores routine working progress and quiet lifecycle, while new actionable events get stable keys', () => {
  const at = '2026-10-22T05:12:00Z';
  const progress = { id: 'work', lane: 'work' as const, entry: { verb: 'working' as const, at, note: 'still working' } };
  const quiet: Notice = { seq: '1', at, kind: 'trap-listening', text: 'heartbeat' };
  expect(helmWakeKeys({ events: [progress], notices: [quiet] })).toEqual([]);
  const done = { ...progress, entry: { ...progress.entry, verb: 'done' as const } };
  expect(helmWakeKeys({ events: [done] })).toHaveLength(1);
  expect(helmWakeKeys({ replies: [{ ...progress, sent: 'please review' }] })).toHaveLength(1);
  const stale: Notice = { seq: '2', at, kind: 'dispatch-progress', refId: 'work', stateHash: 'stalled:since', text: 'stale' };
  expect(helmWakeKeys({ notices: [stale] })).toEqual(helmWakeKeys({ notices: [{ ...stale, seq: '3' }] }));
});

it('a repeated digest carries only actionable identities and matches direct status delivery', () => {
  const at = '2026-10-22T05:12:00Z';
  const digest: Digest = { since: at, now: at, changed: true, landed: [{ id: 'work', lane: 'work', verb: 'done', at }], arisen: [], standing: [], stacks: [], traps: [{ kind: 'trap-stowed', at, text: 'routine' }], verdict: 'idle', counts: { queued: 0, active: 0, headlessActive: 0, trapActive: 0, headlessLimit: 1, choresActive: 0, done24h: 1, failed24h: 0 } };
  expect(digestWakeKeys(digest)).toEqual(helmWakeKeys({ events: [{ id: 'work', lane: 'work', entry: { verb: 'done', at } }] }));
  expect(digestWakeKeys({ ...digest, landed: [] })).toEqual([]);
});
