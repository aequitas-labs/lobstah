import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, enqueue, ensureLayout, executorPath, mergeEvidence } from '@lobstah/core';
import type { PrEvidence } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tend-pr-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date().toISOString() }));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

const Q = '11111111-1111-1111-1111-111111111111';
const P = '22222222-2222-2222-2222-222222222222';
const pr = (draft: boolean, state = 'OPEN'): PrEvidence => ({
  url: 'https://github.com/acme/web/pull/9',
  number: 9,
  state,
  draft,
  reviewDecision: '',
  mergeStateStatus: 'DRAFT',
  headSha: 'abc1234',
  checks: { total: 2, passed: 1, failed: 0, pending: 1 },
  observedAt: new Date().toISOString(),
});

describe('man tend --json attention kinds', () => {
  it('a needs-decision dispatch is kind question, shape otherwise unchanged', () => {
    enqueue({ id: Q, repo: 'web', brief: 'b' }, 'work');
    appendStatus(Q, 'work', 'needs-decision', 'which color?');
    const r = buildTendReport();
    expect(r.attention).toEqual([
      expect.objectContaining({ kind: 'question', id: Q, lane: 'work', verb: 'needs-decision', note: 'which color?' }),
    ]);
    expect(r.verdict).toBe('needs-attention');
  });

  it('a dispatch whose evidence pr is open and draft is kind pr, and does not flip the verdict', () => {
    enqueue({ id: P, repo: 'web', brief: 'b' }, 'work');
    appendStatus(P, 'work', 'done', 'opened');
    mergeEvidence(P, 'work', { prUrl: 'https://github.com/acme/web/pull/9', pr: pr(true) });
    const r = buildTendReport();
    expect(r.attention).toEqual([
      expect.objectContaining({
        kind: 'pr',
        id: P,
        verb: 'pr',
        note: '#9 draft',
        prUrl: 'https://github.com/acme/web/pull/9',
        draft: true,
        checks: { total: 2, passed: 1, failed: 0, pending: 1 },
      }),
    ]);
    expect(r.verdict).not.toBe('needs-attention');
    expect(renderTend(r)).toContain('#9 draft https://github.com/acme/web/pull/9');
  });

  it('the same dispatch after draft: false (or merged) drops out of attention', () => {
    enqueue({ id: P, repo: 'web', brief: 'b' }, 'work');
    appendStatus(P, 'work', 'done', 'opened');
    mergeEvidence(P, 'work', { pr: pr(false) });
    expect(buildTendReport().attention).toEqual([]);
    mergeEvidence(P, 'work', { pr: pr(true, 'MERGED') });
    expect(buildTendReport().attention).toEqual([]);
  });
});
