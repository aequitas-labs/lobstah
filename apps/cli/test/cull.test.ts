import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendStatus, claimNext, complete, dispatchAttachmentsDir, enqueue, ensureLayout } from '@lobstah/core';
import { applyCull, planCull } from '../src/cull.js';

let home: string;
const DAY = 86_400_000;

function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-cull-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.LOBSTAH_HOME;
});

describe('planCull', () => {
  it('flags old done entries and keeps recent ones', () => {
    for (const [id, days] of [['old1', 20], ['fresh1', 2]] as const) {
      fs.mkdirSync(path.join(home, 'done', id));
      age(path.join(home, 'done', id), days);
    }
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['done:old1']);
  });

  it('flags orphaned worktrees but never live or recently-done ones', () => {
    fs.mkdirSync(path.join(home, 'worktrees', 'live1'), { recursive: true });
    fs.mkdirSync(path.join(home, 'active', 'live1'));
    fs.mkdirSync(path.join(home, 'worktrees', 'recent1'));
    fs.mkdirSync(path.join(home, 'done', 'recent1'));
    fs.mkdirSync(path.join(home, 'worktrees', 'ghost1'));
    age(path.join(home, 'worktrees', 'ghost1'), 30);
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['worktree:ghost1']);
  });

  it('flags stale state for ids nothing knows, keeps state of known dispatches', () => {
    enqueue({ id: 'queued1', repo: 'r', brief: 'b' });
    appendStatus('queued1', 'work', 'working');
    appendStatus('lost1', 'work', 'failed');
    age(path.join(home, 'state', 'lost1.status'), 30);
    const plan = planCull(14);
    expect(plan.map((i) => `${i.kind}:${i.id}`)).toEqual(['state:lost1']);
  });

  it('never touches queue or active regardless of age', () => {
    enqueue({ id: 'q1', repo: 'r', brief: 'b' });
    age(path.join(home, 'queue', 'q1.json'), 60);
    fs.mkdirSync(path.join(home, 'active', 'a1'));
    age(path.join(home, 'active', 'a1'), 60);
    expect(planCull(14)).toEqual([]);
  });

  it('counts attachment bytes in the dry run and removes them with old state', () => {
    const done = path.join(home, 'done', 'old2');
    const attachments = dispatchAttachmentsDir('old2', 'work');
    fs.mkdirSync(done);
    fs.mkdirSync(attachments, { recursive: true });
    fs.writeFileSync(path.join(attachments, 'note.txt'), 'five!');
    age(done, 30);
    const plan = planCull(14);
    expect(plan.map((item) => `${item.kind}:${item.id}`)).toEqual(['done:old2', 'state:old2']);
    expect(plan.find((item) => item.kind === 'state')?.bytes).toBe(5);
    applyCull(plan);
    expect(fs.existsSync(attachments)).toBe(false);
    expect(fs.existsSync(done)).toBe(false);
  });

  it('keeps an old origin attachment while a live follow-up still references it', () => {
    const attachments = dispatchAttachmentsDir('origin', 'work');
    fs.mkdirSync(attachments, { recursive: true });
    const file = path.join(attachments, 'spec.txt');
    fs.writeFileSync(file, 'keep me');
    enqueue({ id: 'origin', repo: 'r', brief: 'first', attachments: [{ name: 'spec.txt', path: file, bytes: 7, type: 'text/plain' }] });
    claimNext('work');
    complete('origin', 'work');
    age(path.join(home, 'done', 'origin'), 30);
    enqueue({ id: 'child', repo: 'r', brief: 'next', followUp: 'origin' });
    const plan = planCull(14);
    expect(plan.map((item) => `${item.kind}:${item.id}`)).toContain('done:origin');
    expect(plan.map((item) => `${item.kind}:${item.id}`)).not.toContain('state:origin');
    applyCull(plan);
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
  });
});
