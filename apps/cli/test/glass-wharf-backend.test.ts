import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWharfBackend, WHARF_CAPABILITIES } from '../../../packages/glass-ui/ui/backends/wharf.js';
import { dispatchDetail, dispatchSummary, trapOf, wharfSnapshot } from '../../../packages/glass-ui/ui/wharf-snapshot.js';
import { detail, jobs, markdown, snapshot } from './fixtures/wharf-glass.js';

/**
 * The wharf backend: the hosted glass's account projected onto the snapshot
 * the local glass renders, and the glass's writes mapped onto the wharf's
 * cookie-only routes. The fixture is the one the hosted glass's own tests use.
 */

const NOW = Date.parse('2026-10-10T17:05:00Z');

describe('the wharf account as a glass snapshot', () => {
  const d = wharfSnapshot(snapshot, jobs, NOW, new Map([['md', '# Pick one']]), 'token');

  it('lists each job as a dispatch, with its title, verb, note and worker', () => {
    expect(d.dispatches).toEqual([
      {
        id: 'job',
        lane: 'work',
        bucket: 'active',
        repo: 'lobstah',
        title: 'Build the hosted spyglass',
        verb: 'working',
        note: 'Browser controls and cookie boundary tests in progress.',
        verbAt: '2026-10-10T17:00:00Z',
        claimedBy: 'kind-crab',
        sort: Date.parse('2026-10-10T17:00:00Z'),
      },
    ]);
  });

  it('shows a standing decision on the deck with its Markdown, options and files', () => {
    expect(d.attention).toContainEqual(expect.objectContaining({ kind: 'decision', key: 'decision:card', verb: 'needs-decision' }));
    const card = d.decisions!.find((x) => x.key === 'decision:card')!;
    expect(card).toMatchObject({ title: 'Choose the next catch', detail: '# Pick one', options: ['Keep it small', 'Split the work'], askedBy: 'helm' });
    expect(card.attachments).toEqual([
      { name: 'lob.png', path: '', bytes: 100, type: '', url: '/api/glass/documents/card/files/image' },
    ]);
  });

  it('lists reports and workers', () => {
    expect(d.reports.map((r) => [r.key, r.title, r.author])).toEqual([['report:report', 'Wharf progress', 'kind-crab']]);
    expect(d.traps).toEqual([trapOf(snapshot.workers[0]!)]);
    expect(d.traps[0]).toMatchObject({ trapId: 'kind-crab', live: false, harness: 'codex', sessionId: 'test-session', repo: 'lobstah' });
  });

  it('fakes nothing the wharf does not record', () => {
    expect(d).toMatchObject({ version: '', helms: [], notices: [], watches: [], prs: [], stacks: [], landed: [] });
    expect(d.daemon).toBeUndefined();
    expect(d.stats).toBeUndefined();
    expect(d.todos).toBeUndefined();
    expect(d.sessionGrants).toBeUndefined();
  });

  it('waits on a person when a job asks, and lands a finished job', () => {
    const asking = { ...jobs[0]!, status: { verb: 'needs-decision' as const, note: 'Which base?', at: '2026-10-10T17:04:00Z' } };
    const landed = { ...jobs[0]!, id: 'done-job', state: 'done' as const, status: { verb: 'done' as const, note: 'Merged', at: '2026-10-10T16:00:00Z' } };
    const old = { ...landed, id: 'old-job', status: { ...landed.status, at: '2026-10-01T16:00:00Z' } };
    const next = wharfSnapshot(snapshot, [asking, landed, old], NOW, new Map(), 'token');
    expect(next.attention).toContainEqual(expect.objectContaining({ kind: 'question', key: 'work:job', verb: 'needs-decision', note: 'Which base?' }));
    expect(next.landed.map((l) => l.id)).toEqual(['done-job']);
  });

  it('keeps a job without a report as queued or unknown, never a guessed verb', () => {
    expect(dispatchSummary({ ...jobs[0]!, state: 'queued', status: undefined }).verb).toBe('queued');
    expect(dispatchSummary({ ...jobs[0]!, state: 'active', status: undefined }).verb).toBe('unknown');
    expect(dispatchSummary({ ...jobs[0]!, state: 'cancelled', status: undefined }).bucket).toBe('done');
  });

  it("reads a job's detail as its log, inbox and files", () => {
    const x = dispatchDetail(detail);
    expect(x.brief).toBe('Build the hosted spyglass\nLocal files stay the default.');
    expect(x.log.map((e) => e.verb)).toEqual(['working', 'paused']);
    expect(x.log[1]).toMatchObject({ waitingOn: 'review' });
    expect(x.inbox).toEqual(['Please preserve local behavior.']);
    expect(x.attachments.map((a) => (a as { url?: string }).url)).toEqual([
      '/api/glass/dispatches/job/files/worker-md',
      '/api/glass/dispatches/job/files/worker-image',
    ]);
  });
});

describe('the wharf backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The wharf's browser API, from the fixture; every request is recorded. */
  function wharf() {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
      calls.push({ path, init });
      const answer = (status: number, body: unknown) =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
      if (path === '/api/glass') return answer(200, snapshot);
      if (path === '/api/glass/dispatches') return answer(200, jobs);
      if (path === '/api/glass/dispatches/job/detail') return answer(200, detail);
      if (path.includes('/files/')) return answer(200, markdown);
      if (init.method === 'POST') return answer(200, { ok: true });
      return answer(404, { error: 'route not found' });
    });
    return calls;
  }

  it('fills only the tabs the wharf has, and takes none of the local-only actions', () => {
    expect(WHARF_CAPABILITIES.tabs).toEqual(['deck', 'dispatches', 'traps', 'reviews', 'reports']);
    expect([...WHARF_CAPABILITIES.actions]).toEqual([]);
  });

  it('reads the account and its jobs same-origin, with the cookie, and each decision file once', async () => {
    const calls = wharf();
    const b = createWharfBackend({ now: () => NOW });
    const first = await b.poll(null);
    await b.poll(null);
    expect(first.kind).toBe('snapshot');
    if (first.kind === 'snapshot') expect(first.snapshot.decisions![0]!.detail).toBe(markdown);
    expect(calls.every((c) => c.init.credentials === 'same-origin')).toBe(true);
    expect(calls.filter((c) => c.path === '/api/glass/documents/card/files/md')).toHaveLength(1);
  });

  it("answers a decision on the wharf's route with a fresh idempotency key", async () => {
    const calls = wharf();
    const b = createWharfBackend({ now: () => NOW });
    await b.poll(null);
    const sent = await b.request('decision-answer', { key: 'decision:card', option: 'Keep it small', text: 'go', files: [] }, 'token');
    expect(sent).toEqual({ ok: true, status: 200, body: { ok: true } });
    const post = calls.find((c) => c.init.method === 'POST')!;
    expect(post.path).toBe('/api/glass/documents/card/answer');
    expect(JSON.parse(String(post.init.body))).toEqual({ option: 'Keep it small', text: 'go' });
    expect((post.init.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('acks a report it showed, records nothing for a viewed decision, and refuses what the wharf lacks', async () => {
    const calls = wharf();
    const b = createWharfBackend({ now: () => NOW });
    await b.poll(null);
    expect((await b.request('report-viewed', { key: 'report:report' }, 'token')).ok).toBe(true);
    expect((await b.request('decision-viewed', { key: 'decision:card' }, 'token')).ok).toBe(true);
    expect((await b.request('trap-request', { repo: 'lobstah', harness: 'claude' }, 'token')).body).toEqual({
      ok: false,
      reason: 'This is not available on the wharf.',
    });
    expect((await b.request('decision-answer', { key: 'decision:card', files: [{ name: 'a.png' }] }, 'token')).ok).toBe(false);
    expect(calls.filter((c) => c.init.method === 'POST').map((c) => c.path)).toEqual(['/api/glass/documents/report/ack']);
  });

  it('opens a report on its own page, with its Markdown and a write marker that acks it', async () => {
    wharf();
    const b = createWharfBackend({ now: () => NOW });
    const report = await b.report('report:report');
    expect(report).toMatchObject({ ok: true, token: 'wharf-session' });
    expect(await b.reportText('report:report')).toEqual({ ok: true, status: 200, data: markdown });
    expect(await b.report('report:nope')).toEqual({ ok: false, status: 404 });
  });

  it("resolves files by name to the wharf's own file URLs", async () => {
    wharf();
    const b = createWharfBackend({ now: () => NOW });
    await b.poll(null);
    await b.dispatch('job');
    expect(b.fileUrl({ kind: 'decision', key: 'decision:card' }, 'lob.png')).toBe('/api/glass/documents/card/files/image');
    expect(b.fileUrl({ kind: 'dispatch', lane: 'work', id: 'job' }, 'lob.png')).toBe('/api/glass/dispatches/job/files/worker-image');
    expect(b.fileUrl({ kind: 'decision', key: 'decision:card' }, 'other.png')).toBe('');
    expect(b.fileUrl({ kind: 'trap', trapId: 'kind-crab' }, 'a.png')).toBe('');
  });

  it('tells the host when the wharf refuses the session, and the poll fails rather than showing stale data as current', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'sign in' }), { status: 401 }));
    const signedOut: number[] = [];
    const b = createWharfBackend({ onSignedOut: (s) => signedOut.push(s) });
    await expect(b.poll(null)).rejects.toThrow('/api/glass answered 401');
    expect(signedOut).toContain(401);
  });
});
