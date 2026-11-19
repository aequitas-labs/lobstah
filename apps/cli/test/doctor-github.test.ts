import { afterEach, describe, expect, it, vi } from 'vitest';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { configuredGithubRows, doctorGithubToken, ghApi, githubRows } from '../src/doctor.js';
import type { GhApi } from '../src/doctor.js';

const REPOS = [{ key: 'web', forgeRepo: 'acme/web', trunk: 'main' }];
const FORBIDDEN = 'Resource not accessible by integration (HTTP 403)';

/** A stubbed `gh api`: each path answers, or fails with the given reason. */
function api(answers: Record<string, string | { err: string }>): { api: GhApi; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    api: (p) => {
      calls.push(p);
      const hit = Object.entries(answers).find(([prefix]) => p.startsWith(prefix))?.[1];
      if (hit === undefined) return { ok: false, err: `HTTP 404: Not Found (${p})` };
      return typeof hit === 'string' ? { ok: true, out: hit } : { ok: false, err: hit.err };
    },
  };
}

describe('doctor github rows', () => {
  it('names a user identity and reports every probe readable', () => {
    const { api: a, calls } = api({ user: '{"login":"octocat"}', 'repos/acme/web/': '[]' });
    const rows = githubRows(REPOS, a, true);
    expect(rows[0]).toEqual({ check: 'github', status: 'ok', detail: 'gh runs as user octocat' });
    expect(rows[1]).toEqual({
      check: 'github web',
      status: 'ok',
      detail: 'acme/web: pull requests readable, contents readable, checks readable',
    });
    expect(calls).toContain('repos/acme/web/commits/main/check-runs?per_page=1');
  });

  it('names an App installation, and a forbidden check-runs read points at Checks: read', () => {
    const { api: a } = api({
      user: { err: FORBIDDEN },
      'installation/repositories': '{"total_count":4}',
      'repos/acme/web/commits/main/check-runs': { err: FORBIDDEN },
      'repos/acme/web/': '[]',
    });
    const rows = githubRows(REPOS, a, true);
    expect(rows[0]!.detail).toBe('gh runs as a GitHub App installation (4 repos)');
    expect(rows[1]!.status).toBe('warn');
    expect(rows[1]!.detail).toContain('checks NOT readable');
    expect(rows[1]!.detail).toContain('`Checks: read`');
  });

  it('a forbidden pulls read names Pull requests: read', () => {
    const { api: a } = api({
      user: '{"login":"bot"}',
      'repos/acme/web/pulls': { err: FORBIDDEN },
      'repos/acme/web/': '[]',
    });
    expect(githubRows(REPOS, a, true)[1]!.detail).toContain('`Pull requests: read`');
  });

  it('bad credentials fail the identity row with the auth remedy; gh missing warns', () => {
    const { api: a } = api({ user: { err: 'HTTP 401: Bad credentials' }, installation: { err: 'HTTP 401: Bad credentials' } });
    const rows = githubRows(REPOS, a, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('fail');
    expect(rows[0]!.detail).toContain('gh auth');
    expect(githubRows(REPOS, a, false)[0]!.detail).toContain('gh not on PATH');
  });

  it('skips without calling gh when no configured repo has a GitHub origin', () => {
    const { api: a, calls } = api({ user: '{"login":"octocat"}' });
    expect(githubRows([], a, true)).toEqual([{ check: 'github', status: 'skip', detail: 'no configured repo has a GitHub origin' }]);
    expect(calls).toEqual([]);
  });
});


afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

it('uses the configured App token for every probe while a stale local gh login is informational', () => {
  const calls: Array<{ path: string; token?: string }> = [];
  const readToken = vi.fn(() => 'installation-secret');
  const api: GhApi = (path, token) => {
    calls.push({ path, token });
    if (!token) return { ok: false, err: 'Bad credentials (HTTP 401)' };
    if (path === 'user') return { ok: false, err: FORBIDDEN };
    return { ok: true, out: path.startsWith('installation/') ? '{"total_count":7}' : '[]' };
  };
  const rows = configuredGithubRows(REPOS, 'mint-token', api, readToken, true);
  expect(readToken).toHaveBeenCalledExactlyOnceWith('mint-token');
  expect(rows[0]).toMatchObject({ status: 'ok', detail: 'gh runs as a GitHub App installation (7 repos)' });
  expect(rows[1]!.status).toBe('ok');
  expect(rows[2]).toMatchObject({ check: 'gh login', status: 'skip' });
  expect(calls.slice(0, -1).every((call) => call.token === 'installation-secret')).toBe(true);
  expect(calls.at(-1)).toEqual({ path: 'user', token: undefined });
  expect(JSON.stringify(rows)).not.toContain('installation-secret');
  expect(JSON.stringify(rows)).not.toContain('gh auth login');
});

it('reports configured credential failures without recommending a local login or exposing the token', () => {
  const rows = configuredGithubRows(REPOS, 'mint-token', () => ({ ok: false, err: 'HTTP 401: Bad credentials installation-secret' }), () => 'installation-secret', true);
  expect(rows[0]!.status).toBe('fail');
  expect(rows[0]!.detail).toContain('pickup.github.tokenCommand');
  expect(JSON.stringify(rows)).not.toContain('installation-secret');
  expect(JSON.stringify(rows)).not.toContain('gh auth login');
});

it.each(['', 'one\ntwo'])('rejects empty or multiline command output without calling gh', (output) => {
  const api = vi.fn<GhApi>();
  expect(configuredGithubRows(REPOS, 'mint-token', api, () => output, true)[0]!.status).toBe('fail');
  expect(api).not.toHaveBeenCalled();
});

it('keeps token-command errors private and does not fall back to local credentials', () => {
  const api = vi.fn<GhApi>();
  const rows = configuredGithubRows(REPOS, 'mint-token', api, () => { throw new Error('secret stderr'); }, true);
  expect(rows[0]!.status).toBe('fail');
  expect(JSON.stringify(rows)).not.toContain('secret stderr');
  expect(api).not.toHaveBeenCalled();
});

it('skips minting without GitHub repos or gh, and preserves the bare-gh path without a command', () => {
  const readToken = vi.fn();
  const { api: probe } = api({ user: '{"login":"octocat"}', 'repos/acme/web/': '[]' });
  expect(configuredGithubRows([], 'mint-token', probe, readToken, true)[0]!.status).toBe('skip');
  expect(configuredGithubRows(REPOS, 'mint-token', probe, readToken, false)[0]!.status).toBe('warn');
  expect(configuredGithubRows(REPOS, undefined, probe, readToken, true)[0]!.detail).toContain('octocat');
  expect(readToken).not.toHaveBeenCalled();
});

it('passes the token only in the gh child environment and captures token-command errors', () => {
  const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({ status: 1, stdout: '', stderr: 'secret-token', pid: 1, output: [], signal: null });
  syncBuiltinESMExports();
  expect(ghApi('user', 'secret-token')).toEqual({ ok: false, err: '[redacted]' });
  expect(spawn).toHaveBeenLastCalledWith('gh', ['api', '--method', 'GET', 'user'], expect.objectContaining({ env: expect.objectContaining({ GH_TOKEN: 'secret-token' }) }));
  expect(() => doctorGithubToken('mint-token')).toThrow('GitHub token command failed.');
  expect(spawn).toHaveBeenLastCalledWith('mint-token', expect.objectContaining({ shell: true, stdio: ['ignore', 'pipe', 'pipe'] }));
});
