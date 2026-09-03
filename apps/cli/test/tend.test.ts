import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { addWatch, appendStatus, claimNext, enqueue, ensureLayout, executorPath } from '@lobstah/core';
import { buildTendReport, renderTend } from '../src/tend.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tend-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

function heartbeat(agoMs = 0): void {
  fs.writeFileSync(executorPath(), JSON.stringify({ heartbeat: new Date(Date.now() - agoMs).toISOString() }));
}

describe('man tend — the fleet verdict', () => {
  it('empty home with a fresh heartbeat is idle, not stalled', () => {
    heartbeat();
    expect(buildTendReport().verdict).toBe('idle');
  });

  it('no heartbeat is daemon-down, whatever else is true', () => {
    enqueue({ id: 'a1', repo: 'r', brief: 'b' });
    expect(buildTendReport().verdict).toBe('daemon-down');
  });

  it('old queued work with free capacity and a live daemon is stalled', () => {
    heartbeat();
    enqueue({ id: 'a2', repo: 'r', brief: 'b' });
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(path.join(home, 'queue', 'a2.json'), old, old);
    expect(buildTendReport().verdict).toBe('stalled');
  });

  it('fresh queued work is just working', () => {
    heartbeat();
    enqueue({ id: 'a3', repo: 'r', brief: 'b' });
    expect(buildTendReport().verdict).toBe('working');
  });

  it('an unanswered needs-decision outranks working and carries its age', () => {
    heartbeat();
    enqueue({ id: 'a4', repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus('a4', 'work', 'needs-decision', 'which flavor?');
    const r = buildTendReport();
    expect(r.verdict).toBe('needs-attention');
    expect(r.attention).toEqual([expect.objectContaining({ id: 'a4', verb: 'needs-decision', note: 'which flavor?' })]);
  });

  it('joins the pickup map and merge view into work-item stories', () => {
    heartbeat();
    enqueue({ id: '55555555-5555-5555-5555-555555555555', repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus('55555555-5555-5555-5555-555555555555', 'work', 'working');
    fs.mkdirSync(path.join(home, 'pickup'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'pickup', 'state.json'),
      JSON.stringify({ map: { 'linear:BAS-9': { uuid: '55555555-5555-5555-5555-555555555555', kind: 'issue' } } }),
    );
    fs.writeFileSync(
      path.join(home, 'pickup', 'merge-view.json'),
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        repo: 'demo/demo',
        open: [
          {
            number: 3,
            url: 'https://x/pr/3',
            headRef: 'lobstah/55555555-5555-5555-5555-555555555555',
            headSha: 'abc',
            mergeableState: 'clean',
            gate: 'waiting-approval',
            uuid: '55555555-5555-5555-5555-555555555555',
          },
        ],
        recent: [],
      }),
    );
    const r = buildTendReport();
    expect(r.stories).toEqual([
      expect.objectContaining({ key: 'linear:BAS-9', gate: 'waiting-approval' }),
    ]);
    const text = renderTend(r);
    expect(text).toContain('linear:BAS-9');
    expect(text).toContain('waiting-approval');
  });
});

describe('man tend — watches join', () => {
  it('a man-owned watch with pending events is needs-attention with its age', () => {
    heartbeat();
    addWatch('ume:plan', 'true');
    fs.appendFileSync(
      path.join(home, 'watches', 'ume-plan.events'),
      `${JSON.stringify({ seq: 1, summary: 'feedback batch', at: new Date(Date.now() - 120_000).toISOString() })}\n`,
    );
    const r = buildTendReport();
    expect(r.verdict).toBe('needs-attention');
    const row = r.attention.find((a) => a.id === 'ume:plan');
    expect(row?.verb).toBe('watch');
    expect(row?.note).toBe('feedback batch');
    expect(row!.ageSecs).toBeGreaterThanOrEqual(119);
    expect(r.watches[0]).toMatchObject({ key: 'ume:plan', owner: 'man', pendingEvents: 1 });
    expect(renderTend(r)).toContain('feedback batch');
  });

  it('a consumed man-owned watch is listed but raises no attention', () => {
    heartbeat();
    addWatch('ume:quiet', 'true');
    expect(buildTendReport().verdict).toBe('idle');
    expect(buildTendReport().watches).toHaveLength(1);
  });

  it('a dispatch-owned watch annotates its story, including continuations', () => {
    heartbeat();
    const owner = '66666666-6666-6666-6666-666666666666';
    enqueue({ id: owner, repo: 'r', brief: 'b' });
    claimNext('work');
    appendStatus(owner, 'work', 'paused', 'awaiting review');
    addWatch('ume:story', 'true', { owner: `dispatch:${owner}` });
    const r = buildTendReport();
    const story = r.stories.find((s) => s.dispatches.some((d) => d.id === owner));
    expect(story?.watch).toBe('ume:story');
    expect(r.verdict).toBe('working'); // dispatch-owned pending is machinery's job, not the human's
  });
});
