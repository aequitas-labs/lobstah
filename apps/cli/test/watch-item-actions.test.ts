import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { builtinWatchRegistry, ensureLayout, observeReviewRequest, readReview, syncWatchRegistrations, WatchJournal, WatchRuntime } from '@lobstah/core';
import { CommandWatchType, validateWatchPresentation, WatchRegistry } from '@lobstah/watch-types';
import type { WatchActionRequest, WatchItem, WatchPresentation, WatchSnapshot, WatchValue } from '@lobstah/watch-types';
import { parseWatchItemAction, runWatchItemAction } from '../src/watch-item-actions.js';
import { serveGlass, buildGlassSnapshot } from '../src/glass.js';
import { createCliWatchRegistry } from '../src/watch-automation.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let server: Server | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-item-actions-'));
  process.env.LOBSTAH_HOME = home;
  ensureLayout();
});
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** A provider-free source with one item and a recorded effect log, as any plugin or built-in would supply. */
class ItemSource extends CommandWatchType {
  readonly descriptor = { id: 'fixture', keyPrefix: 'fixture:', apiVersion: 1 as const, stateVersion: 1, version: '1.0.0' };
  item: WatchItem = {
    id: 'doc-1',
    revision: 'r1',
    title: 'Plan',
    kind: 'document',
    glyph: { kind: 'document' },
    lifecycle: { phase: 'active', label: 'Active' },
    statuses: [],
    attention: 'needs-you',
    notification: { revision: 'n1', unread: true, action: 'seen' },
    metadata: [],
    actions: [
      { id: 'approve', label: 'Approve', placement: 'primary', enabled: true, binding: { effect: { action: 'approve' } } },
      { id: 'later', label: 'Later', placement: 'menu', enabled: false, reason: 'Answer its decisions first.', binding: { effect: { action: 'approve' } } },
      { id: 'open', label: 'Open', placement: 'open', enabled: true, binding: { link: { href: 'https://example.test/doc' } } },
    ],
    surfaces: { list: ['reviews'] },
  };
  effects: WatchActionRequest<WatchValue>[] = [];
  release?: () => void;
  readonly effectHandler = {
    execution: 'async' as const,
    execute: async (request: WatchActionRequest<WatchValue>) => {
      this.effects.push(request);
      if (this.release) await new Promise<void>((resolve) => (this.release = resolve));
      return { workIds: [] };
    },
  };
  identify(input: string) {
    return input.startsWith('fixture:') ? super.identify(input) : undefined;
  }
  present(snapshot: WatchSnapshot<never, never, never, never>): WatchPresentation {
    return {
      ...super.present(snapshot as never),
      version: 2,
      source: { id: 'fixture', name: 'Fixture', icon: { glyph: 'source' } },
      items: [this.item],
      actions: [
        { id: 'approve', label: 'Approve', requiresAuthority: true },
        { id: 'seen', label: 'Mark seen', requiresAuthority: true },
        { id: 'sync', label: 'Sync', requiresAuthority: true, automatic: true },
      ],
    };
  }
}

function setup() {
  const source = new ItemSource();
  const registry = new WatchRegistry();
  registry.register(source);
  const runtime = new WatchRuntime(registry);
  const snapshot = runtime.register('fixture', 'fixture:one', { check: 'unused', cursor: '0' }, { kind: 'helm', grounds: 'home' });
  const payload = (over: Partial<Parameters<typeof runWatchItemAction>[0]> = {}) => ({
    watch: snapshot.key,
    generation: snapshot.generation,
    item: 'doc-1',
    control: 'approve' as string | { acknowledge: string },
    revision: 'r1',
    idempotencyKey: 'click-1',
    ...over,
  });
  return { source, registry, runtime, snapshot, payload };
}

describe('the generic item action gateway', () => {
  it('runs a declared effect once, bound to the item, its revision and recorded authority', async () => {
    const { source, registry, payload } = setup();
    const reply = await runWatchItemAction(payload(), 'glass', { registry });
    expect(reply).toEqual({ status: 200, body: { ok: true } });
    expect(source.effects).toHaveLength(1);
    expect(source.effects[0]).toMatchObject({
      actionId: 'approve',
      expectedRevision: 'doc-1@r1',
      arguments: { item: 'doc-1', values: null },
      authorization: { id: 'glass', by: 'glass' },
    });
    // A double click or a reconnect retry reuses the receipt and runs nothing again.
    expect(await runWatchItemAction(payload(), 'glass', { registry })).toEqual({ status: 200, body: { ok: true } });
    expect(source.effects).toHaveLength(1);
  });

  it('returns a conflict when the item changed, without running anything', async () => {
    const { source, registry, payload } = setup();
    const reply = await runWatchItemAction(payload({ revision: 'r0' }), 'glass', { registry });
    expect(reply).toEqual({ status: 409, body: { ok: false, reason: 'This item changed. Its controls were refreshed.', conflict: true } });
    expect((await runWatchItemAction(payload({ generation: 'other' }), 'glass', { registry })).body.conflict).toBe(true);
    expect((await runWatchItemAction(payload({ item: 'missing' }), 'glass', { registry })).body.conflict).toBe(true);
    expect(source.effects).toEqual([]);
  });

  it('grants nothing to client labels: disabled, link-only and undeclared controls are refused', async () => {
    const { source, registry, payload, runtime, snapshot } = setup();
    expect((await runWatchItemAction(payload({ control: 'later' }), 'glass', { registry })).body).toEqual({ ok: false, reason: 'Answer its decisions first.' });
    expect((await runWatchItemAction(payload({ control: 'open' }), 'glass', { registry })).body.ok).toBe(false);
    expect((await runWatchItemAction(payload({ control: 'forged' }), 'glass', { registry })).body.ok).toBe(false);
    // A cached control bound to an action the source no longer declares as a human action is refused too.
    runtime.journal.update(snapshot.key, (current) => {
      current!.presentation.items![0]!.actions[0] = { ...current!.presentation.items![0]!.actions[0]!, binding: { effect: { action: 'sync' } } };
      return { snapshot: current, result: undefined };
    });
    expect((await runWatchItemAction(payload({ idempotencyKey: 'click-2' }), 'glass', { registry })).body).toEqual({ ok: false, reason: 'Watch action is not supported' });
    expect(source.effects).toEqual([]);
  });

  it('acknowledges only the notification revision the person saw', async () => {
    const { source, registry, payload } = setup();
    expect((await runWatchItemAction(payload({ control: { acknowledge: 'n0' } }), 'glass', { registry })).body.conflict).toBe(true);
    expect((await runWatchItemAction(payload({ control: { acknowledge: 'n1' } }), 'glass', { registry })).status).toBe(200);
    expect(source.effects.map((effect) => [effect.actionId, effect.arguments])).toEqual([['seen', { item: 'doc-1', values: { notification: 'n1' } }]]);
  });

  it('refuses effects on a held source and keeps its items', async () => {
    const { source, registry, payload, runtime, snapshot } = setup();
    runtime.journal.update(snapshot.key, (current) => {
      current!.status = 'held';
      return { snapshot: current, result: undefined };
    });
    expect((await runWatchItemAction(payload(), 'glass', { registry })).body).toEqual({ ok: false, reason: 'Watch cannot accept an action' });
    expect(runtime.journal.read(snapshot.key)?.presentation.items).toHaveLength(1);
    expect(source.effects).toEqual([]);
  });

  it('waits for another action on the same watch instead of dropping the request', async () => {
    const { source, registry, payload } = setup();
    source.release = () => {};
    const first = runWatchItemAction(payload(), 'glass', { registry });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = runWatchItemAction(payload({ control: { acknowledge: 'n1' }, idempotencyKey: 'open-1' }), 'glass', { registry });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(source.effects).toHaveLength(1);
    const release = source.release;
    source.release = undefined;
    release?.();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(source.effects.map((effect) => effect.actionId)).toEqual(['approve', 'seen']);
  });

  it('validates the request shape before resolving anything', () => {
    expect(parseWatchItemAction({ watch: 'w', generation: 'g', item: 'i', control: 'c', revision: 'r', idempotencyKey: 'k' })).toBeDefined();
    expect(parseWatchItemAction({ watch: 'w', generation: 'g', item: 'i', control: { acknowledge: 'n' }, revision: 'r', idempotencyKey: 'k' })).toBeDefined();
    for (const bad of [null, {}, { watch: 'w', generation: 'g', item: 'i', control: { acknowledge: 'n', extra: 1 }, revision: 'r', idempotencyKey: 'k' }, { watch: 'w'.repeat(500), generation: 'g', item: 'i', control: 'c', revision: 'r', idempotencyKey: 'k' }])
      expect(parseWatchItemAction(bad)).toBeUndefined();
  });
});

describe('the GitHub review source', () => {
  const pr = { owner: 'acme', repo: 'web', number: 7, url: 'https://github.com/acme/web/pull/7', title: 'Keep drafts visible', author: 'dana', headSha: 'aaaaaaa1' };
  const enable = () => fs.writeFileSync(path.join(home, 'config.toml'), '[reviews]\nenabled = true\nmode = "on-demand"\nidentity = "maya"\n');

  it('registers for the configured identity and supplies valid items the glass reads from the journal', () => {
    enable();
    observeReviewRequest({ pr, round: { id: 'RRE_7', requestedAt: new Date(Date.now() - 60_000).toISOString(), requestedBy: 'dana' } });
    syncWatchRegistrations(createCliWatchRegistry(() => {}), Date.now(), () => {});
    const stored = new WatchJournal().read('review-requests:maya');
    expect(stored?.owner).toEqual({ kind: 'helm', grounds: 'home' });
    expect(() => validateWatchPresentation(stored!.presentation, 2)).not.toThrow();
    const snapshot = buildGlassSnapshot();
    expect(snapshot.reviews?.map((review) => review.key)).toEqual(['review:acme/web#7']);
    expect(snapshot.reviewItems?.map((entry) => [entry.source.name, entry.item.id, entry.item.lifecycle.phase])).toEqual([['GitHub', 'review:acme/web#7', 'active']]);
    // Watches lists the source's own watch, owned by the home helm, from the same journal.
    expect(snapshot.watchInventory?.find((row) => row.key === 'review-requests:maya')).toMatchObject({
      source: { id: 'github', name: 'GitHub' },
      owner: { kind: 'helm', name: 'home helm' },
      glyph: 'pull-request',
      derived: false,
    });
    // The daemon's plain registry observes the watch too; without the projection it keeps the last items.
    new WatchRuntime(builtinWatchRegistry()).checkSync('review-requests:maya', { everySecs: 0 });
    expect(new WatchJournal().read('review-requests:maya')?.presentation.items?.map((item) => item.id)).toEqual(['review:acme/web#7']);
  });

  it('mutes through the guarded item action and shows the change in the next snapshot', async () => {
    enable();
    observeReviewRequest({ pr, round: { id: 'RRE_7', requestedAt: new Date(Date.now() - 60_000).toISOString(), requestedBy: 'dana' } });
    syncWatchRegistrations(createCliWatchRegistry(() => {}), Date.now(), () => {});
    const entry = buildGlassSnapshot().reviewItems![0]!;
    server = serveGlass(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const token = ((await (await fetch(`${base}/data`)).json()) as { focusToken: string }).focusToken;
    const send = (payload: unknown, auth = token) =>
      fetch(`${base}/requests`, { method: 'POST', headers: { Origin: base, 'content-type': 'application/json', 'x-lobstah-token': auth }, body: JSON.stringify({ kind: 'watch-item-action', payload }) });
    const payload = { watch: entry.watch.key, generation: entry.watch.generation, item: entry.item.id, control: 'mute', revision: entry.item.revision, idempotencyKey: 'k1' };
    expect((await send(payload, 'wrong')).status).toBe(403);
    expect((await send({ ...payload, control: 7 })).status).toBe(400);
    const reply = await send(payload);
    expect(reply.status).toBe(200);
    expect(readReview('review:acme/web#7')?.mutedAt).toEqual(expect.any(String));
    const after = buildGlassSnapshot().reviewItems![0]!;
    expect(after.item.statuses.map((status) => status.label)).toContain('muted');
    expect(after.item.actions.map((action) => action.id)).toContain('unmute');
    // The old revision now conflicts instead of acting on the changed review.
    const stale = await send({ ...payload, control: 'skip', idempotencyKey: 'k2' });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { conflict?: boolean }).conflict).toBe(true);
  });
});

