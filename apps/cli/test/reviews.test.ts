import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, executorPath, observeReviewRequest, reviewBrief } from '@lobstah/core';
import { buildTendReport } from '../src/tend.js';
import { reviewRows, glassReviews } from '../src/reviews.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cli-reviews-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

function request(number: number, id = `RRE_${number}`): void {
  observeReviewRequest({
    pr: { owner: 'acme', repo: 'web', number, url: `https://github.com/acme/web/pull/${number}`, title: `pr ${number}`, author: 'dana', headSha: 'aaaaaaa1' },
    round: { id, requestedAt: new Date().toISOString(), requestedBy: 'dana' },
  });
}

const reviewKeys = () => buildTendReport().attention.filter((a) => a.kind === 'review').map((a) => a.key);

describe('review attention in tend', () => {
  it('never adds review requests to tend, even with review in attentionKinds', () => {
    request(7);
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\n');
    expect(reviewKeys()).toEqual([]); // enabling reviews includes their notifications by default
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["question"]\n[reviews]\nenabled = true\n');
    expect(reviewKeys()).toEqual([]); // an explicit attention list is respected
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["review"]\n[reviews]\nenabled = true\n');
    expect(reviewKeys()).toEqual([]);
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["review"]\n[reviews]\nenabled = false\n');
    expect(reviewKeys()).toEqual([]);
  });
});

describe('lobstah reviews', () => {
  it.each(['github-actions', 'github-actions[bot]', 'approval-gate[bot]'])('uses the author consistently for a cached bot request from %s', (bot) => {
    const { item } = observeReviewRequest({
      pr: { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', authorName: 'Dana Developer', authorAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4', headSha: 'aaaaaaa1' },
      round: { id: 'bot', requestedAt: '2026-10-15T09:00:00Z', requestedBy: bot },
    });
    expect(reviewRows()[0]!.requestedBy).toBe('dana');
    expect(glassReviews()[0]).toMatchObject({ requestedBy: 'dana', asker: 'dana', askerName: 'Dana Developer', askerAvatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4', automatic: true });
    expect(reviewBrief(item, item.rounds[0]!, { identity: 'chris', id: 'd', outDir: '/out', checkout: '/checkout' })).toContain('dana asked chris');
  });
  it('preserves a human requester in CLI and glass data after an automated re-request', () => {
    const pr = { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 't', author: 'dana', headSha: 'aaaaaaa1' };
    observeReviewRequest({ pr, round: { id: 'human', requestedAt: '2026-10-15T08:00:00Z', requestedBy: 'maya', requestedByName: 'Maya Maintainer' } });
    observeReviewRequest({ pr, round: { id: 'bot', requestedAt: '2026-10-15T09:00:00Z', requestedBy: 'workflow', requestedAutomatically: true } });
    expect(reviewRows()[0]!.requestedBy).toBe('maya');
    expect(glassReviews()[0]).toMatchObject({ requestedBy: 'maya', asker: 'maya', askerName: 'Maya Maintainer', automatic: true });
  });
  it('lists open rounds; --all adds closed ones', () => {
    request(7);
    request(8);
    request(8, 'RRE_8b'); // the first round of #8 is withdrawn, its second is open
    expect(reviewRows().map((r) => [r.key, r.state])).toEqual(
      expect.arrayContaining([
        ['review:acme/web#7', 'requested'],
        ['review:acme/web#8', 'requested'],
      ]),
    );
    expect(reviewRows()).toHaveLength(2);
    expect(reviewRows(true)[0]).toMatchObject({ title: expect.stringMatching(/^pr /), author: 'dana', requestedBy: 'dana' });
  });
});
