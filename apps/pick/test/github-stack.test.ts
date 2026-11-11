import { afterEach, expect, it, vi } from 'vitest';
import { GithubSource } from '../src/sources/github.js';
const source = (): GithubSource =>
  new GithubSource({ repo: 'o/r', key: 'demo', identity: 'bot', token: () => 'test', startLabel: 'start', claimedLabel: 'claimed' });
const pr = {
  number: 2,
  html_url: 'https://github.com/o/r/pull/2',
  state: 'open',
  user: { login: 'bot' },
  head: { ref: 'b2', sha: 'sha2', repo: { full_name: 'o/r' } },
  base: { ref: 'b1', sha: 'base', repo: { default_branch: 'trunk' } },
  stack: { number: 9, position: 2, size: 2, base: { ref: 'trunk' } },
  labels: [],
  assignees: [],
  mergeable_state: 'clean',
  draft: false,
};
type Call = { method: string; url: string; body: Record<string, unknown>; version?: string };
const stub = (response: (call: Call) => { status?: number; body: unknown }): Call[] => {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = {
      method: init.method!,
      url: new URL(url).pathname + new URL(url).search,
      body: init.body ? JSON.parse(String(init.body)) : {},
      version: (init.headers as Record<string, string>)['X-GitHub-Api-Version'],
    };
    calls.push(call);
    const result = response(call);
    const status = result.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => result.body, text: async () => JSON.stringify(result.body) };
  });
  return calls;
};
afterEach(() => vi.unstubAllGlobals());

it('reads authoritative native stack membership and default branch, keeping foreign authors as boundaries', async () => {
  const calls = stub((call) => ({
    body: call.url.includes('/reviews') ? [] : [pr, { ...pr, number: 3, user: { login: 'someone-else' } }],
  }));
  const candidates = await source().mergeCandidates();
  expect(candidates[0]).toMatchObject({
    defaultBranch: 'trunk',
    baseRef: 'b1',
    linkedStack: { number: 9, base: 'trunk', position: 2 },
    eligible: true,
  });
  expect(candidates[1]!.eligible).toBe(false);
  expect(calls.some((call) => call.url.includes('/pulls/3/reviews'))).toBe(false);
});

it('retargets and updates with a normal base merge pinned to the expected head', async () => {
  const calls = stub((call) => ({ body: call.method === 'GET' ? pr : {} }));
  const github = source();
  await github.retarget(2, 'trunk');
  await github.updateBranch(2);
  expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
    { method: 'PATCH', url: '/repos/o/r/pulls/2', body: { base: 'trunk' } },
    { method: 'GET', url: '/repos/o/r/pulls/2', body: {} },
    { method: 'PUT', url: '/repos/o/r/pulls/2/update-branch', body: { expected_head_sha: 'sha2' } },
  ]);
});

it('uses merge-async and its result endpoint for a linked stack, distinguishing queued from merged', async () => {
  const calls = stub((call) => ({
    body: call.url.includes('/stacks/')
      ? {
          pull_requests: [
            { number: 1, state: 'closed' },
            { number: 2, state: 'open' },
          ],
        }
      : call.method === 'PUT'
        ? { status: 'pending', details: { uuid: 'request' } }
        : { status: 'enqueued', details: {} },
  }));
  const github = source();
  expect(await github.linkedMembers(9)).toEqual([2]);
  expect((await github.mergeLinked(2, 'squash', 'sha2')).status).toBe('pending');
  expect((await github.linkedResult(2, 'request')).status).toBe('enqueued');
  expect(calls[1]).toMatchObject({
    url: '/repos/o/r/pulls/2/merge-async',
    method: 'PUT',
    body: { sha: 'sha2', merge_method: 'squash', merge_action: 'default' },
    version: '2026-03-10',
  });
  expect(calls[2]!.url).toBe('/repos/o/r/pulls/2/merge-async/request');
});

it('adopts only an identical already-pending async request', async () => {
  const github = source();
  stub(() => ({
    status: 409,
    body: { status: 'pending', details: { uuid: 'request', expected_head_sha: 'sha2', merge_method: 'squash' } },
  }));
  expect((await github.mergeLinked(2, 'squash', 'sha2')).details.uuid).toBe('request');
  await expect(github.mergeLinked(2, 'squash', 'different-head')).rejects.toThrow('different merge request');
});

it('pins ordinary merges and rejects a successful HTTP response that did not merge', async () => {
  const calls = stub(() => ({ body: { merged: false, message: 'The head changed' } }));
  await expect(source().merge(2, 'squash', 'sha2')).rejects.toThrow('head changed');
  expect(calls[0]).toMatchObject({ url: '/repos/o/r/pulls/2/merge', body: { sha: 'sha2', merge_method: 'squash' } });
});

it.each([
  ['SUCCESS', 'green'],
  ['PENDING', 'pending'],
  ['FAILURE', 'red'],
  ['ERROR', 'red'],
  [null, 'pending'],
] as const)('reads %s checks on the same head', async (state, expected) => {
  stub(() => ({
    body: {
      data: {
        repository: {
          pullRequest: { headRefOid: 'sha2', commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } },
        },
      },
    },
  }));
  expect(await source().checks(2, 'sha2')).toBe(expected);
  expect(await source().checks(2, 'stale-head')).toBe('pending');
});
