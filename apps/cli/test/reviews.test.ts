import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, executorPath, observeReviewRequest } from '@lobstah/core';
import { buildTendReport } from '../src/tend.js';
import { reviewRows } from '../src/reviews.js';
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
  it('walks only when [reviews] is on and attentionKinds lists review', () => {
    request(7);
    fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\n');
    expect(reviewKeys()).toEqual([]); // not in the default kinds
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["review"]\n[reviews]\nenabled = true\n');
    expect(reviewKeys()).toEqual(['review:acme/web#7']);
    fs.writeFileSync(path.join(home, 'config.toml'), 'attentionKinds = ["review"]\n[reviews]\nenabled = false\n');
    expect(reviewKeys()).toEqual([]);
  });
});

describe('lobstah reviews', () => {
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
