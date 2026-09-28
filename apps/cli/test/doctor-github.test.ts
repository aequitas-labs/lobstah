import { describe, expect, it } from 'vitest';
import { githubRows } from '../src/doctor.js';
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
