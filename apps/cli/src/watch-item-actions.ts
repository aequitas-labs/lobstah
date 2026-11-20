import { WatchActionRunner, WatchItemConflict, WatchRuntime } from '@lobstah/core';
import type { WatchItemActionProposal } from '@lobstah/core';
import type { WatchRegistry } from '@lobstah/watch-types';
import { createCliWatchRegistry } from './watch-automation.js';

/**
 * The glass's generic item action: a person ran one control on an item a
 * source supplied (Publish, Skip, Open in ume's acknowledgement). The glass
 * names the watch, item, control, the generation and revision it showed,
 * and an idempotency key. The server resolves the declared action again
 * from cached source state, records authority through the action runner's
 * receipts, and only then runs the source's effect. Labels, enabled flags
 * and source text from the client grant nothing.
 */

/** What the glass sends; every field is checked before the runner sees it. */
export interface WatchItemActionPayload {
  watch: string;
  generation: string;
  item: string;
  /** A control ID, or `{ acknowledge: <notification revision> }` when the person opened the item. */
  control: string | { acknowledge: string };
  revision: string;
  idempotencyKey: string;
}

export interface WatchItemActionReply {
  status: number;
  body: { ok: boolean; reason?: string; conflict?: boolean };
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

/** Validate the request's shape; the runner validates its meaning. */
export function parseWatchItemAction(payload: unknown): WatchItemActionPayload | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const p = payload as Record<string, unknown>;
  const control = p.control;
  const validControl =
    text(control, 120) ||
    (!!control && typeof control === 'object' && text((control as { acknowledge?: unknown }).acknowledge, 300) && Object.keys(control).length === 1);
  if (!text(p.watch, 400) || !text(p.generation, 120) || !text(p.item, 400) || !validControl || !text(p.revision, 300) || !text(p.idempotencyKey, 120))
    return undefined;
  return {
    watch: p.watch,
    generation: p.generation,
    item: p.item,
    control: typeof control === 'string' ? control : { acknowledge: (control as { acknowledge: string }).acknowledge },
    revision: p.revision,
    idempotencyKey: p.idempotencyKey,
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Authorize and run one item action. Another action on the same watch holds
 * the runner's lease; this waits for it rather than dropping the request.
 * A changed item returns a conflict, and the glass refreshes its controls.
 */
export async function runWatchItemAction(
  payload: WatchItemActionPayload,
  by: string,
  options: { registry?: WatchRegistry; now?: () => number; waitMs?: number } = {},
): Promise<WatchItemActionReply> {
  const registry = options.registry ?? createCliWatchRegistry(() => {});
  const runner = new WatchActionRunner(registry);
  const now = options.now ?? Date.now;
  const proposal: WatchItemActionProposal = {
    item: payload.item,
    control: payload.control,
    generation: payload.generation,
    expectedRevision: payload.revision,
    idempotencyKey: payload.idempotencyKey,
  };
  try {
    const request = runner.authorizeItem(payload.watch, proposal, { id: 'glass', by, at: new Date(now()).toISOString() });
    const deadline = now() + (options.waitMs ?? 30_000);
    for (;;) {
      const snapshot = runner.journal.read(payload.watch);
      const receipt = snapshot?.actionReceipts?.find((entry) => entry.request.id === request.id);
      if (receipt?.status === 'done') break;
      // A live lease on this watch belongs to another action; wait for it to finish.
      const busy = snapshot?.actionReceipts?.some((entry) => entry.lease && entry.lease.until > now());
      if (!busy) {
        await runner.execute(payload.watch, request);
        const after = runner.journal.read(payload.watch)?.actionReceipts?.find((entry) => entry.request.id === request.id);
        if (after?.status === 'done') break;
      }
      if (now() > deadline) return { status: 409, body: { ok: false, reason: 'Another action on this source is still running. Try again.' } };
      await wait(200);
    }
    // Show the result at once: the source re-presents from its stored state.
    try {
      new WatchRuntime(registry).represent(payload.watch);
    } catch {
      // The next check refreshes it.
    }
    return { status: 200, body: { ok: true } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return error instanceof WatchItemConflict
      ? { status: 409, body: { ok: false, reason, conflict: true } }
      : { status: 409, body: { ok: false, reason } };
  }
}
