import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureLayout, syncWatchRegistrations } from '@lobstah/core';
import type { GlassDispatch } from '@lobstah/core';
import { createCliWatchRegistry } from '../src/watch-automation.js';
import { prGlassProjection } from '../src/watch-adapters/pr-glass.js';
import { deliverMergeWatchActions } from '../src/watch-sources/merge.js';
import { removeTempDir } from '../../../test/temp-dir.js';

vi.mock('../src/watch-sources/merge.js', () => ({ deliverMergeWatchActions: vi.fn() }));
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-source-lifecycle-'));
  vi.stubEnv('LOBSTAH_HOME', home);
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), 'schemaVersion = 2\n[watchTypes.pr]\nenabled = false\n');
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  removeTempDir(home);
});

it('runs stack and merge lifecycles when the PR observation adapter is unavailable', () => {
  const registry = createCliWatchRegistry(() => {});
  expect(registry.get('pr').registration).toBeUndefined();
  syncWatchRegistrations(registry, Date.now(), () => {}, 'after-observe');
  expect(vi.mocked(deliverMergeWatchActions).mock.calls.map((call) => call[1])).toEqual([{ stack: {} }, { pr: {} }]);
});

it('preserves provider badges already projected by a hosted boat', () => {
  const hosted: GlassDispatch = {
    id: 'remote-dispatch',
    lane: 'work',
    bucket: 'done',
    title: 'Hosted work',
    verb: 'done',
    sort: 1,
    brief: 'Hosted work',
    attachments: [],
    messageAttachments: [],
    log: [],
    inbox: [],
    backend: { grounds: 'shared', wharf: 'fixture', dispatch: 'remote-dispatch' },
    prBadge: { text: 'ready', tone: 'ok', state: 'open', observedAt: '2026-11-19T00:00:00.000Z' },
    prGate: 'green',
  };
  const view = prGlassProjection([], [], [hosted]);
  expect(view.dispatches).toEqual([hosted]);
  expect(view.dispatches[0]!.prBadge).toEqual(hosted.prBadge);
  expect(view.dispatches[0]!.prGate).toBe('green');
});
