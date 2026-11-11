import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLayout, listNotices, laneDirs } from '@lobstah/core';
import { mergeLoop } from '../src/loops/merge.js';
import { PickupState } from '../src/state.js';
import { DEFAULT_MERGE_POLICY } from '../src/types.js';
import type { AsyncMergeResult, MergeSource, PrCandidate } from '../src/types.js';
import { removeTempDir } from '../../../test/temp-dir.js';
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-stack-merge-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});
const policy = { ...DEFAULT_MERGE_POLICY, enabled: true, approvers: ['reviewer'] };
const candidate = (number: number, base = 'main'): PrCandidate => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  author: 'bot',
  headSha: `sha${number}`,
  headRef: `b${number}`,
  baseRef: base,
  defaultBranch: 'main',
  eligible: true,
  labels: [],
  assignees: [],
  reviews: [{ id: number, author: 'reviewer', state: 'APPROVED', sha: `sha${number}` }],
  mergeableState: 'clean',
});
class Forge implements MergeSource {
  name = 'gh:o/r';
  open: PrCandidate[] = [candidate(3, 'b2'), candidate(2, 'b1'), candidate(1)];
  events: string[] = [];
  merged = new Set<number>();
  closed = new Set<number>();
  included = new Set<number>([1]);
  status: Record<number, 'green' | 'pending' | 'red'> = { 1: 'green', 2: 'green', 3: 'green' };
  result: AsyncMergeResult = { status: 'pending', details: { uuid: 'request' } };
  mergeCandidates = async (): Promise<PrCandidate[]> => [...this.open];
  refresh = async (number: number): Promise<PrCandidate | undefined> => this.open.find((pr) => pr.number === number);
  disposition = async (number: number): Promise<'open' | 'merged' | 'closed'> =>
    this.merged.has(number) ? 'merged' : this.closed.has(number) ? 'closed' : 'open';
  forgeRepo = (): string => 'o/r';
  repoKey = (): string => 'demo';
  requestReview = async (): Promise<void> => {};
  comment = async (): Promise<void> => {};
  addLabel = async (): Promise<void> => {};
  includesBase = async (number: number): Promise<boolean> => this.included.has(number);
  checks = async (number: number): Promise<'green' | 'pending' | 'red'> => this.status[number]!;
  linkedMembers = async (): Promise<number[]> => [1, 2, 3];
  linkedResult = async (): Promise<AsyncMergeResult> => this.result;
  mergeLinked = async (number: number, method: string, head: string): Promise<AsyncMergeResult> => {
    this.events.push(`linked:${number}:${method}:${head}`);
    return this.result;
  };
  retarget = async (number: number, base: string): Promise<void> => {
    this.events.push(`retarget:${number}:${base}`);
    (await this.refresh(number))!.baseRef = base;
  };
  updateBranch = async (number: number): Promise<void> => {
    this.events.push(`update:${number}`);
    const pr = (await this.refresh(number))!;
    pr.headSha += '-updated';
    this.status[number] = 'pending';
    this.included.add(number);
  };
  merge = async (number: number, method: string, head?: string): Promise<void> => {
    const pr = (await this.refresh(number))!;
    expect(pr.baseRef).toBe('main');
    expect(head).toBe(pr.headSha);
    this.events.push(`merge:${number}:${method}`);
    this.merged.add(number);
    this.open = this.open.filter((member) => member.number !== number);
  };
}
const tick = async (forge: Forge): Promise<void> => mergeLoop(forge, policy, new PickupState());

it('merges an unlinked three-PR stack bottom-up, retargets and merges the default branch normally, and waits for new checks and approvals', async () => {
  const forge = new Forge();
  await tick(forge);
  expect(forge.events).toEqual(['merge:1:squash']);
  await tick(forge);
  expect(forge.events.at(-1)).toBe('retarget:2:main');
  await tick(forge);
  expect(forge.events.at(-1)).toBe('update:2');
  await tick(forge);
  expect([...forge.merged]).toEqual([1]);
  forge.status[2] = 'green';
  await tick(forge);
  expect([...forge.merged]).toEqual([1]); // old-head approval is stale
  (await forge.refresh(2))!.reviews[0]!.sha = (await forge.refresh(2))!.headSha;
  await tick(forge);
  expect([...forge.merged]).toEqual([1, 2]);
  await tick(forge);
  await tick(forge);
  expect(forge.events.slice(-2)).toEqual(['retarget:3:main', 'update:3']);
  forge.status[3] = 'green';
  (await forge.refresh(3))!.reviews[0]!.sha = (await forge.refresh(3))!.headSha;
  await tick(forge);
  expect([...forge.merged]).toEqual([1, 2, 3]);
});

it.each(['dirty', 'red'] as const)('stops the stack on %s without dispatching a rebase or merging another member', async (failure) => {
  const forge = new Forge();
  await tick(forge);
  await tick(forge);
  if (failure === 'dirty') (await forge.refresh(2))!.mergeableState = 'dirty';
  else {
    forge.included.add(2);
    forge.status[2] = 'red';
  }
  await tick(forge);
  await tick(forge);
  expect([...forge.merged]).toEqual([1]);
  expect(listNotices().filter((notice) => notice.kind === 'stack-stopped')).toHaveLength(1);
  expect(fs.readdirSync(laneDirs('chore').queue)).toEqual([]);
});

it('does not merge a PR whose non-default base has no observed parent', async () => {
  const forge = new Forge();
  forge.open = [candidate(3, 'missing-parent')];
  await tick(forge);
  expect(forge.events).toEqual([]);
});

it('holds branching stacks and out-of-scope members', async () => {
  const forge = new Forge();
  forge.open = [candidate(1), candidate(2, 'b1'), candidate(3, 'b1')];
  await tick(forge);
  expect(forge.events).toEqual([]);
  forge.open = [candidate(1), { ...candidate(2, 'b1'), eligible: false }];
  await tick(forge);
  expect(forge.events).toEqual([]);
});

it('uses native merge-async once for the top and polls the saved request across restarts', async () => {
  const forge = new Forge();
  forge.open.forEach((pr) => {
    pr.linkedStack = { number: 9, position: pr.number, size: 3, base: 'main' };
  });
  await tick(forge);
  expect(forge.events).toEqual(['linked:3:squash:sha3']);
  await tick(forge);
  expect(forge.events).toHaveLength(1);
  forge.result = { status: 'enqueued', details: {} };
  await tick(forge);
  expect(forge.events).toHaveLength(1);
  expect(new PickupState().stackMerge('gh:o/r:stack:9')).toBeDefined();
  forge.merged = new Set([1, 2, 3]);
  forge.open = [];
  await tick(forge);
  expect(new PickupState().stackMerge('gh:o/r:stack:9')).toBeUndefined();
});

it('reports asynchronous native failure and never retries the consumed approval', async () => {
  const forge = new Forge();
  forge.open.forEach((pr) => {
    pr.linkedStack = { number: 9, position: pr.number, size: 3, base: 'main' };
  });
  await tick(forge);
  forge.result = { status: 'failed', details: { message: 'Required check failed' } };
  await tick(forge);
  await tick(forge);
  expect(forge.events).toHaveLength(1);
  expect(listNotices().some((notice) => notice.text.includes('Required check failed'))).toBe(true);
});

it('does not submit a native stack when a member is red, missing or unapproved', async () => {
  for (const failure of ['red', 'missing', 'approval']) {
    const forge = new Forge();
    forge.open.forEach((pr) => {
      pr.linkedStack = { number: 9, position: pr.number, size: 3, base: 'main' };
    });
    if (failure === 'red') forge.status[1] = 'red';
    if (failure === 'missing') forge.open = forge.open.filter((pr) => pr.number !== 1);
    if (failure === 'approval') forge.open[0]!.reviews = [];
    await tick(forge);
    expect(forge.events).toEqual([]);
  }
});

it('reports a red queued native stack without calling it merged or submitting it again', async () => {
  const forge = new Forge();
  forge.result = { status: 'enqueued', details: {} };
  forge.open.forEach((pr) => {
    pr.linkedStack = { number: 9, position: pr.number, size: 3, base: 'main' };
  });
  await tick(forge);
  forge.status[1] = 'red';
  await tick(forge);
  expect(forge.events).toHaveLength(1);
  expect(new PickupState().stackMerge('gh:o/r:stack:9')).toBeDefined();
  expect(listNotices().some((notice) => notice.text.includes('failing check'))).toBe(true);
});

it('holds the initial bottom PR on a red check and reports it', async () => {
  const forge = new Forge();
  forge.status[1] = 'red';
  await tick(forge);
  expect(forge.events).toEqual([]);
  expect(listNotices().some((notice) => notice.kind === 'stack-stopped')).toBe(true);
});

it('stops when native membership order changes between listing and the merge gate', async () => {
  const forge = new Forge();
  forge.open.forEach((pr) => {
    pr.linkedStack = { number: 9, position: pr.number, size: 3, base: 'main' };
  });
  forge.linkedMembers = async () => [3, 2, 1];
  await tick(forge);
  expect(forge.events).toEqual([]);
  expect(listNotices().some((notice) => notice.text.includes('changed order'))).toBe(true);
});
