import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UmeReviews } from '@lobstah/core';
import { readUmeReviews, runUme } from '../src/ume-reviews.js';
import type { UmeRun, UmeRunner } from '../src/ume-reviews.js';
import { serveGlass } from '../src/glass.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const ME = 'me0000000001';
const ALEX = 'alex00000001';

const artifacts = {
  artifacts: [
    { id: 'a-waiting', title: 'Plan the importer', kind: 'doc', rev: 3, approval: 'in-review', sets: 'set-1:plan', archived: null },
    { id: 'a-approved', title: 'Approved spec', kind: 'doc', rev: 2, approval: 'approved', sets: 'set-2:spec', archived: null },
    { id: 'a-alex', title: 'Waiting on Alex', kind: 'doc', rev: 1, approval: 'in-review', sets: '', archived: null },
    { id: 'a-answered', title: 'Already answered', kind: 'doc', rev: 4, approval: 'in-review', sets: 'set-3:plan', archived: null },
    { id: 'a-archived', title: 'Archived review', kind: 'doc', rev: 1, approval: 'in-review', sets: '', archived: '2026-11-01T00:00:00Z' },
    { id: 'a-preview', title: 'Preview the flow', kind: 'preview', rev: 1, approval: 'in-review', sets: '', archived: null },
  ],
};

const touchpoints = {
  touchpoints: [
    { at: '2026-11-20T10:00:00Z', kind: 'review.requested', actor: ALEX, by: 'agent', artifact: 'a-waiting', to: ME },
    { at: '2026-11-20T09:00:00Z', kind: 'review.requested', actor: ALEX, by: 'agent', artifact: 'a-waiting', to: ME },
    { at: '2026-11-20T08:00:00Z', kind: 'review.requested', actor: ME, by: 'agent', artifact: 'a-alex', to: ALEX },
    { at: '2026-11-20T07:00:00Z', kind: 'review.requested', actor: ALEX, by: 'person', artifact: 'a-answered', to: ME },
    { at: '2026-11-20T07:30:00Z', kind: 'verdict.cast', actor: ME, by: 'person', artifact: 'a-answered', to: ALEX },
    { at: '2026-11-20T06:00:00Z', kind: 'review.requested', actor: ALEX, by: 'agent', artifact: 'a-archived', to: ME },
    { at: '2026-11-20T11:00:00Z', kind: 'review.requested', actor: ALEX, by: 'person', artifact: 'a-preview', to: ME },
  ],
};

const people = { people: [{ id: ME, name: 'Sam Reviewer', email: 'sam@example.com' }, { id: ALEX, name: 'Alex Author', email: 'alex@example.com' }] };

/** A fake ume: answers per verb and project, and records each call. */
function fakeUme(over: { project?: Record<string, UmeRun>; verb?: Record<string, UmeRun> } = {}): UmeRunner & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (args: string[], project?: string) => {
    const verb = args[0]!;
    calls.push(project ? `${verb}@${project}` : verb);
    if (over.verb?.[verb]) return over.verb[verb]!;
    if (project && over.project?.[project] && verb === 'artifacts') return over.project[project]!;
    if (verb === 'artifacts') return { ok: true, json: project === 'p-home' ? artifacts : { artifacts: [] } };
    if (verb === 'activity') return { ok: true, json: touchpoints };
    if (verb === 'people') return { ok: true, json: people };
    if (verb === 'whoami') return { ok: true, json: { user: ME, name: 'Sam Reviewer' } };
    if (verb === 'projects') return { ok: true, json: { projects: [{ project: 'p-home', name: 'homebase' }] } };
    return { ok: false, reason: `unexpected ${verb}` };
  }) as UmeRunner & { calls: string[] };
  run.calls = calls;
  return run;
}

describe('the ume review reader', () => {
  it('keeps the in-review artifacts waiting on you, newest request first', async () => {
    const run = fakeUme();
    const result = await readUmeReviews({ projects: ['p-home', 'p-quiet'] }, run);
    expect(result.configured).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.items.map((item) => item.id)).toEqual(['ume:a-preview', 'ume:a-waiting']);
    const waiting = result.items[1]!;
    expect(waiting).toMatchObject({
      title: 'Plan the importer',
      kind: 'plan',
      source: { id: 'ume', name: 'ume', icon: { glyph: 'ume' } },
      glyph: { kind: 'document' },
      lifecycle: { phase: 'active', label: 'In review' },
      attention: 'needs-you',
      person: { id: ALEX, name: 'Alex Author’s agent', role: 'requested by' },
      requestedAt: '2026-11-20T10:00:00Z',
      target: 'https://app.ume.so/a/a-waiting',
      actions: [{ label: 'Open in ume', href: 'https://app.ume.so/a/a-waiting', placement: 'primary' }],
    });
    expect(waiting.context.map((entry) => entry.value)).toEqual(['homebase', 'plan', 'revision 3', 'asked by Alex Author’s agent', '2026-11-20T10:00:00Z']);
    // A person's own request, with no set, names them and falls back to ume's kind.
    expect(result.items[0]).toMatchObject({ kind: 'preview', person: { name: 'Alex Author' } });
    // A project with nothing in review costs one call.
    expect(run.calls.filter((call) => call.endsWith('@p-quiet'))).toEqual(['artifacts@p-quiet']);
  });

  it('reads nothing more when nothing is in review', async () => {
    const run = fakeUme();
    expect(await readUmeReviews({ projects: ['p-quiet'] }, run)).toEqual({ configured: true, items: [], problems: [] });
    expect(run.calls).toEqual(['artifacts@p-quiet']);
  });

  it('matches a configured person by email, without asking who you are', async () => {
    const run = fakeUme();
    const result = await readUmeReviews({ projects: ['p-home'], person: 'ALEX@example.com' }, run);
    expect(result.items.map((item) => item.id)).toEqual(['ume:a-alex']);
    expect(run.calls).not.toContain('whoami');
  });

  it('names a project that fails and keeps the others', async () => {
    const run = fakeUme({ project: { 'p-broken': { ok: false, reason: 'no stored agent token reaches project p-broken' } } });
    const result = await readUmeReviews({ projects: ['p-home', 'p-broken'] }, run);
    expect(result.items.map((item) => item.id)).toEqual(['ume:a-preview', 'ume:a-waiting']);
    expect(result.problems).toEqual([{ project: 'p-broken', reason: 'no stored agent token reaches project p-broken' }]);
  });

  it('names the project whose activity fails', async () => {
    const run = fakeUme({ verb: { activity: { ok: false, reason: 'the engine is unreachable' } } });
    const result = await readUmeReviews({ projects: ['p-home'] }, run);
    expect(result.items).toEqual([]);
    expect(result.problems).toEqual([{ project: 'p-home', reason: 'the engine is unreachable' }]);
  });

  it('says ume is missing when the CLI is not installed', async () => {
    const run = fakeUme({ verb: { artifacts: { ok: false, missing: true, reason: 'ume is not installed' } } });
    expect(await readUmeReviews({ projects: ['p-home'] }, run)).toEqual({ configured: true, items: [], missing: true, problems: [] });
  });

  it('runs no ume at all without configured projects', async () => {
    const run = fakeUme();
    expect(await readUmeReviews({ projects: [] }, run)).toEqual({ configured: false, items: [], problems: [] });
    expect(run.calls).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('the ume CLI runner', () => {
  let dir: string | undefined;
  const PATH = process.env.PATH;
  afterEach(() => {
    process.env.PATH = PATH;
    if (dir) removeTempDir(dir);
    dir = undefined;
  });

  /** Put a fake `ume` first on PATH; it prints the given stdout and exits with the code. */
  function install(script: string): void {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-fake-ume-'));
    fs.writeFileSync(path.join(dir, 'ume'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${PATH}`;
  }

  it('passes the project and --json, and parses the answer', async () => {
    install('printf \'{"project":"%s","args":"%s"}\' "$UME_PROJECT" "$*"');
    expect(await runUme(['artifacts', '--fields', 'id'], 'p-home')).toEqual({ ok: true, json: { project: 'p-home', args: 'artifacts --fields id --json' } });
  });

  it("reports ume's own error words", async () => {
    install('echo \'{"ok":false,"error":"no stored agent token reaches project p-x"}\'; echo "ume: no stored agent token" >&2; exit 1');
    expect(await runUme(['artifacts'], 'p-x')).toEqual({ ok: false, reason: 'no stored agent token reaches project p-x' });
  });

  it('says ume is missing when it is not on PATH', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-no-ume-'));
    process.env.PATH = dir;
    expect(await runUme(['artifacts'])).toEqual({ ok: false, missing: true, reason: 'ume is not installed' });
  });
});

describe('/data/ume-reviews', () => {
  let server: Server | undefined;
  let home: string | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (home) removeTempDir(home);
    home = undefined;
    delete process.env.LOBSTAH_HOME;
  });

  it('answers this machine with one shared read, and refuses another host', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-route-'));
    process.env.LOBSTAH_HOME = home;
    let reads = 0;
    const answer: UmeReviews = { configured: true, items: [], problems: [{ project: 'p-x', reason: 'offline' }] };
    server = serveGlass(0, {
      snapshot: () => ({}) as never,
      umeReviews: async () => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return answer;
      },
    });
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const [first, second] = await Promise.all([fetch(`${base}/data/ume-reviews`), fetch(`${base}/data/ume-reviews`)]);
    expect(await first.json()).toEqual(answer);
    expect(await second.json()).toEqual(answer);
    expect(reads).toBe(1);
    // fetch drops a Host header; a rebound name arrives through http.get as it would from a browser.
    const foreign = await new Promise<number>((resolve, reject) =>
      http.get(`${base}/data/ume-reviews`, { headers: { host: 'rebound.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on('error', reject),
    );
    expect(foreign).toBe(403);
  });
});
