import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWatchPresentation } from '@lobstah/watch-types';
import type { WatchItem, WatchSnapshot } from '@lobstah/watch-types';
import { builtinWatchRegistry } from '../src/watch-source-registry.js';
import { WatchRuntime } from '../src/watch-runtime.js';
import { WatchJournal } from '../src/watch-journal.js';
import { syncWatchRegistrations } from '../src/watch-registration.js';
import { WatchActionRunner } from '../src/watch-actions.js';
import { watchSurfaceItems, watchSurfaceSources } from '../src/watch-surfaces.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-ume-reviews-'));
  process.env.LOBSTAH_HOME = home;
});
afterEach(() => {
  delete process.env.LOBSTAH_HOME;
  removeTempDir(home);
});

interface Need {
  kind?: string;
  artifact: string;
  ref: string;
  since: string;
}
/** ume as each project's reviewer sees it: needs, artifacts, people and projects, or a failure. */
class FakeUme {
  needs: Record<string, Need[]> = {};
  revisions: Record<string, number> = { 'plan-1': 2, 'plan-2': 5 };
  fail?: string;
  incomplete = false;
  calls: Array<{ args: string[]; project?: string; cwd?: string }> = [];
  read = (args: string[], cwd?: string, project?: string): unknown => {
    this.calls.push({ args, project, cwd });
    if (this.fail) throw new Error(this.fail);
    const verb = args[0];
    if (verb === 'whoami') return { user: 'chris' };
    if (verb === 'people') return { people: [{ id: 'dana', name: 'Dana' }] };
    if (verb === 'projects') return { projects: [{ project: 'ourrwyi8p5', name: 'lobstah' }, { project: 'qnf4so435l', name: 'bao' }] };
    if (verb === 'artifacts')
      return {
        artifactCount: Object.keys(this.revisions).length,
        artifacts: Object.entries(this.revisions).map(([id, rev]) => ({
          id,
          title: `Plan ${id}`,
          rev,
          owner: 'dana',
          sets: 'set-1:plan',
          url: `https://app.ume.so/a/${id}`,
        })),
      };
    const needs = (this.needs[project ?? ''] ?? []).map((need) => ({
      kind: need.kind ?? 'approval',
      artifact: need.artifact,
      title: `Plan ${need.artifact}`,
      ref: need.ref,
      since: need.since,
      owner: 'dana',
      url: `https://app.ume.so/a/${need.artifact}`,
    }));
    return { needCount: this.incomplete ? needs.length + 1 : needs.length, needs };
  };
}

const configure = (projects: string[]) =>
  fs.writeFileSync(path.join(home, 'config.toml'), `schemaVersion = 2\n[watchTypes.ume-reviews]\nprojects = ${JSON.stringify(projects)}\n`);

function setup(projects = ['ourrwyi8p5']) {
  configure(projects);
  const ume = new FakeUme();
  const registry = () => builtinWatchRegistry({ umeReviews: { read: ume.read } });
  const runtime = new WatchRuntime(registry());
  const sync = () => syncWatchRegistrations(registry(), Date.now(), () => {});
  // Each check runs after any retry delay a failure asked for.
  let clock = Date.now();
  const check = (project = 'ourrwyi8p5'): WatchSnapshot => runtime.checkSync(`ume-reviews:${project}`, { everySecs: 0, now: (clock += 3_600_000) })!;
  const items = (project = 'ourrwyi8p5'): WatchItem[] => new WatchJournal().read(`ume-reviews:${project}`)?.presentation.items ?? [];
  return { ume, registry, runtime, sync, check, items };
}

describe('incoming ume reviews', () => {
  it('registers each configured project for the home helm and reads only that project', () => {
    const { ume, sync, check, items } = setup(['ourrwyi8p5', 'qnf4so435l']);
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    ume.needs.qnf4so435l = [{ artifact: 'plan-2', ref: 'apr-9', since: '2026-11-19T11:00:00.000Z' }];
    sync();
    const stored = new WatchJournal().read('ume-reviews:ourrwyi8p5')!;
    expect(stored.owner).toEqual({ kind: 'helm', grounds: 'home' });
    check('ourrwyi8p5');
    check('qnf4so435l');
    expect(items('ourrwyi8p5').map((item) => item.id)).toEqual(['ourrwyi8p5/chris/plan-1']);
    expect(items('qnf4so435l').map((item) => item.id)).toEqual(['qnf4so435l/chris/plan-2']);
    // Every read names its project explicitly and runs outside any repo.
    expect(new Set(ume.calls.map((call) => call.project))).toEqual(new Set(['ourrwyi8p5', 'qnf4so435l']));
    expect(ume.calls.every((call) => call.cwd === home)).toBe(true);
    // Reading needs consumes nothing: only read verbs are called.
    expect(new Set(ume.calls.map((call) => call.args[0]))).toEqual(new Set(['whoami', 'needs', 'artifacts', 'people', 'projects']));
  });

  it('shows a formal request with Open in ume, and makes a same-revision re-request unread again', () => {
    const { ume, sync, check, items, registry } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    const [first] = items();
    expect(first).toMatchObject({
      title: 'Plan plan-1',
      lifecycle: { phase: 'active', label: 'Active' },
      statuses: [{ label: 'approval requested', category: 'workflow' }],
      attention: 'needs-you',
      notification: { revision: 'apr-1@2026-11-19T10:00:00.000Z', unread: true, action: 'ume-review-seen' },
      person: { id: 'dana', name: 'Dana', role: 'requested by' },
      metadata: [{ kind: 'project', value: 'lobstah' }, { kind: 'time', value: '2026-11-19T10:00:00.000Z' }, { kind: 'revision', value: 'plan r2' }],
      target: { href: 'https://app.ume.so/a/plan-1' },
      actions: [{ id: 'open', label: 'Open in ume', placement: 'open', acknowledges: true }],
    });
    expect(first!.repo).toBeUndefined();
    expect(() => validateWatchPresentation(new WatchJournal().read('ume-reviews:ourrwyi8p5')!.presentation, 2)).not.toThrow();
    // Opening it records the episode it showed, through the recorded-authority runner.
    const runner = new WatchActionRunner(registry());
    const snapshot = new WatchJournal().read('ume-reviews:ourrwyi8p5')!;
    const request = runner.authorizeItem(
      snapshot.key,
      { item: first!.id, control: { acknowledge: first!.notification!.revision }, generation: snapshot.generation, expectedRevision: first!.revision, idempotencyKey: 'open-1' },
      { id: 'glass', by: 'glass', at: new Date().toISOString() },
    );
    runner.executeSync(snapshot.key, request);
    check();
    expect(items()[0]!.notification).toMatchObject({ unread: false, seen: true });
    // A re-request against the same content is a new review episode.
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-2', since: '2026-11-19T12:00:00.000Z' }];
    check();
    expect(items()).toHaveLength(1);
    expect(items()[0]!.notification).toMatchObject({ revision: 'apr-2@2026-11-19T12:00:00.000Z', unread: true });
    expect(items()[0]!.revision).not.toBe(first!.revision);
  });

  it('retires completed or withdrawn requests and restores a later re-request after completion', () => {
    const { ume, sync, check, items } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    ume.needs.ourrwyi8p5 = [];
    check();
    expect(items()).toEqual([]);
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-3', since: '2026-11-20T09:00:00.000Z' }];
    check();
    expect(items().map((item) => [item.id, item.notification?.unread])).toEqual([['ourrwyi8p5/chris/plan-1', true]]);
  });

  it('rolls several requests for one artifact into one card and never duplicates on repeat polls', () => {
    const { ume, sync, check, items, runtime } = setup();
    ume.needs.ourrwyi8p5 = [
      { artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' },
      { artifact: 'plan-1', ref: 'apr-2', since: '2026-11-19T11:00:00.000Z' },
      { kind: 'reply', artifact: 'plan-2', ref: 't-1', since: '2026-11-19T11:30:00.000Z' },
    ];
    sync();
    check();
    check();
    expect(items()).toHaveLength(1);
    expect(items()[0]!.statuses[0]).toMatchObject({ detail: '2 pending requests' });
    expect(items()[0]!.notification!.revision).toBe('apr-2@2026-11-19T11:00:00.000Z');
    // No worker is woken: the helm-owned watch records no events or deliveries.
    const stored = runtime.journal.read('ume-reviews:ourrwyi8p5')!;
    expect(stored.events).toEqual([]);
    expect(stored.deliveries).toEqual([]);
    expect(runtime.journal.list().map((snapshot) => snapshot.key)).toEqual(['ume-reviews:ourrwyi8p5']);
  });

  it('a new revision updates the item in place', () => {
    const { ume, sync, check, items } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    const before = items()[0]!;
    ume.revisions['plan-1'] = 3;
    check();
    expect(items().map((item) => item.id)).toEqual([before.id]);
    expect(items()[0]!.revision).not.toBe(before.revision);
    expect(items()[0]!.metadata.at(-1)).toEqual({ kind: 'revision', value: 'plan r3' });
  });

  it('keeps the last good items as stale when access is lost or a listing is incomplete', () => {
    const { ume, sync, check, items } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    ume.fail = 'no stored agent token reaches project ourrwyi8p5';
    const failed = check();
    expect(failed.status).toBe('watching');
    expect(failed.failure).toMatchObject({ kind: 'auth', message: 'ume access to this project was lost.' });
    expect(items().map((item) => item.statuses.map((status) => status.code))).toEqual([['approval-requested', 'stale']]);
    expect(watchSurfaceSources('reviews').find((entry) => entry.source.id === 'ume')).toMatchObject({ health: 'stale', message: 'ume access to this project was lost.' });
    ume.fail = undefined;
    ume.incomplete = true;
    ume.needs.ourrwyi8p5 = [];
    check();
    expect(items()).toHaveLength(1);
    ume.incomplete = false;
    check();
    expect(items()).toEqual([]);
  });

  it('marks a confirmed unreadable artifact unavailable, without a way to act on it', () => {
    const { ume, sync, check, items } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'gone', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    expect(items()[0]).toMatchObject({ attention: 'error', actions: [], statuses: [{ code: 'approval-requested' }, { code: 'unavailable' }] });
    expect(items()[0]!.target).toBeUndefined();
  });

  it('holds a project that is no longer configured and keeps its items for the page', () => {
    const { ume, sync, check } = setup();
    ume.needs.ourrwyi8p5 = [{ artifact: 'plan-1', ref: 'apr-1', since: '2026-11-19T10:00:00.000Z' }];
    sync();
    check();
    configure([]);
    sync();
    const held = new WatchJournal().read('ume-reviews:ourrwyi8p5')!;
    expect(held.status).toBe('held');
    expect(watchSurfaceItems('reviews').map((entry) => [entry.item.id, entry.watch.status])).toEqual([['ourrwyi8p5/chris/plan-1', 'held']]);
    configure(['ourrwyi8p5']);
    sync();
    expect(new WatchJournal().read('ume-reviews:ourrwyi8p5')!.status).toBe('watching');
  });
});
