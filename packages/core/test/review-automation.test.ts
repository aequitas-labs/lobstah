import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseReviews, reviewSettings, reviewCanPublish } from '../src/reviews.js';
import { reviewAutomationCutoff } from '../src/review-automation.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const START = Date.parse('2026-11-11T10:00:00Z');
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'review-automation-')); process.env.LOBSTAH_HOME = home; });
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

it('captures enable time and first automatic time, retaining them across later polls', () => {
  const notify = parseReviews({ enabled: true });
  expect(reviewAutomationCutoff(notify, 'web', START)).toBe(new Date(START).toISOString());
  const auto = parseReviews({ enabled: true, mode: 'auto-review' });
  expect(reviewAutomationCutoff(auto, 'web', START + 1000)).toBe(new Date(START + 1000).toISOString());
  expect(reviewAutomationCutoff(auto, 'web', START + 2000)).toBe(new Date(START + 1000).toISOString());
  expect(reviewAutomationCutoff(auto, 'new-repo', START + 3000)).toBe(new Date(START + 1000).toISOString());
});

it('tracks repo mode transitions independently and resets when reviews are re-enabled', () => {
  const config = (mode: string, enabled = true) => parseReviews({ enabled, mode: 'notify' }, { web: { reviews: { mode } } });
  reviewAutomationCutoff(config('notify'), undefined, START);
  expect(reviewAutomationCutoff(config('auto-draft'), 'web', START + 1000)).toBe(new Date(START + 1000).toISOString());
  reviewAutomationCutoff(config('auto-review'), 'web', START + 2000);
  expect(reviewAutomationCutoff(config('auto-review'), 'web', START + 3000)).toBe(new Date(START + 1000).toISOString());
  reviewAutomationCutoff(config('auto-review', false), undefined, START + 4000);
  expect(reviewAutomationCutoff(config('auto-review'), 'web', START + 5000)).toBe(new Date(START + 5000).toISOString());
});

it('honors global and repo timestamp overrides and validates settings', () => {
  const config = parseReviews({ enabled: true, mode: 'auto-review', requestedAfter: '2026-01-01T00:00:00Z' }, {
    web: { reviews: { requestedAfter: '2026-02-01T00:00:00Z' } },
  });
  expect(reviewAutomationCutoff(config, undefined, START)).toBe('2026-01-01T00:00:00.000Z');
  expect(reviewAutomationCutoff(config, 'web', START)).toBe('2026-02-01T00:00:00.000Z');
  expect(reviewSettings(parseReviews({}), 'web').requestedAfter).toBe('enabled');
  for (const requestedAfter of [false, 123, 'bad date']) expect(() => parseReviews({ requestedAfter })).toThrow('requestedAfter');
});

it('auto-posts only a captured verdict setting and respects the current mode', () => {
  const round = { verdict: 'approve', autoPostApprove: 'auto-post', autoPostRequestChanges: 'ask' } as Parameters<typeof reviewCanPublish>[2];
  expect(reviewCanPublish(parseReviews({ enabled: true, mode: 'auto-draft', autoPostApprove: 'auto-post' }), 'web', round)).toBe(true);
  expect(reviewCanPublish(parseReviews({ enabled: true, mode: 'auto-draft' }), 'web', round)).toBe(false);
  expect(reviewCanPublish(parseReviews({ enabled: true, mode: 'notify', autoPostApprove: 'auto-post' }), 'web', round)).toBe(false);
  expect(reviewCanPublish(parseReviews({ enabled: true, mode: 'on-demand', autoPostApprove: 'auto-post' }), 'web', { ...round, onDemand: true })).toBe(true);
  expect(reviewCanPublish(parseReviews({ enabled: false, mode: 'auto-draft', autoPostApprove: 'auto-post' }), 'web', round)).toBe(false);
  expect(reviewCanPublish(parseReviews({ enabled: true, mode: 'auto-draft', autoPostApprove: 'auto-post', autoPostRequestChanges: 'auto-post' }), 'web', { ...round, autoPostApprove: 'ask' })).toBe(false);
});
