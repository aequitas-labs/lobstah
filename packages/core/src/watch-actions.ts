import { sourceWatchFailure } from './watch-source-errors.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { watchJson } from '@lobstah/watch-types';
import type {
  WatchActionProposal,
  WatchActionReceipt,
  WatchActionRequest,
  WatchEffectResult,
  WatchRegistry,
  WatchSnapshot,
  WatchValue,
} from '@lobstah/watch-types';
import { WatchJournal } from './watch-journal.js';
type ActionClaim = { kind: 'cached'; result: WatchEffectResult | undefined } | { kind: 'execute'; typeId: string; generation: string } | undefined;

/** A person's request to run one item control, as the glass sends it. */
export interface WatchItemActionProposal {
  /** The item's ID within the watch. */
  item: string;
  /** The control's ID on that item, or the item's notification acknowledgement. */
  control: string | { acknowledge: string };
  /** The watch generation and item revision the person saw. */
  generation: string;
  expectedRevision: string;
  /** Repeated clicks and reconnect retries reuse it, and so reuse one receipt. */
  idempotencyKey: string;
}

/** The item or its controls changed since the person saw them; the caller refreshes instead of acting. */
export class WatchItemConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchItemConflict';
  }
}

/** The effect an item control or notification acknowledgement runs, resolved from cached source state. */
function resolveItemControl(snapshot: WatchSnapshot | undefined, proposal: WatchItemActionProposal): { action: string; values: WatchValue } {
  if (!snapshot || snapshot.status === 'retired') throw new WatchItemConflict('This watch is no longer active.');
  if (snapshot.generation !== proposal.generation) throw new WatchItemConflict('This watch was replaced. Refresh to see its items.');
  const item = snapshot.presentation.items?.find((entry) => entry.id === proposal.item);
  if (!item) throw new WatchItemConflict('This item is no longer listed.');
  if (item.revision !== proposal.expectedRevision) throw new WatchItemConflict('This item changed. Its controls were refreshed.');
  let action: string, values: WatchValue;
  if (typeof proposal.control === 'string') {
    const control = item.actions.find((entry) => entry.id === proposal.control);
    if (!control || !('effect' in control.binding)) throw new Error('This control does not run an action.');
    if (!control.enabled) throw new Error(control.reason ?? 'This action is not available now.');
    action = control.binding.effect.action;
    values = control.binding.effect.arguments ?? null;
  } else {
    if (!item.notification?.action || item.notification.revision !== proposal.control.acknowledge)
      throw new WatchItemConflict('This notification changed. Refresh to see it.');
    action = item.notification.action;
    values = { notification: item.notification.revision };
  }
  const declaration = snapshot.presentation.actions.find((entry) => entry.id === action);
  if (!declaration || declaration.automatic || !declaration.requiresAuthority) throw new Error('Watch action is not supported');
  return { action, values };
}

/** Recorded authority binds an action, arguments, reference and source revision to one receipt. */
export class WatchActionRunner {
  constructor(
    readonly registry: WatchRegistry,
    readonly journal = new WatchJournal(),
  ) {}

  /** Only the trusted host records authority; provider observations never call this method. */
  authorize(
    key: string,
    proposal: WatchActionProposal,
    authorization: WatchActionRequest<WatchValue>['authorization'],
    /** Rechecks the current source state under the journal lock before any receipt is recorded. */
    verify?: (snapshot: WatchSnapshot) => void,
  ): WatchActionRequest<WatchValue> {
    watchJson(proposal);
    watchJson(authorization);
    if (!proposal.actionId || !proposal.expectedRevision || !proposal.idempotencyKey || proposal.authority !== authorization.id)
      throw new Error('Watch action authority does not match its scope');
    if (!authorization.id || !authorization.by || !Number.isFinite(Date.parse(authorization.at)))
      throw new Error('Recorded watch action authority is required');
    return this.journal.update(key, (snapshot) => {
      if (!snapshot || snapshot.status === 'retired' || snapshot.status === 'held') throw new Error('Watch cannot accept an action');
      verify?.(snapshot);
      const adapter = this.registry.get(snapshot.type.id);
      if (!adapter.effectHandler || !snapshot.presentation.actions.some((action) => action.id === proposal.actionId))
        throw new Error('Watch action is not supported');
      const receipts = (snapshot.actionReceipts ??= []);
      const prior = receipts.find(
        (receipt) => receipt.generation === snapshot.generation && receipt.idempotencyKey === proposal.idempotencyKey,
      );
      if (prior) {
        if (
          prior.request.actionId !== proposal.actionId ||
          prior.request.expectedRevision !== proposal.expectedRevision ||
          !isDeepStrictEqual(prior.request.arguments, proposal.arguments)
        )
          throw new Error('Watch action replay changed its scope');
        return { result: structuredClone(prior.request) };
      }
      const request: WatchActionRequest<WatchValue> = {
        id: randomUUID(),
        actionId: proposal.actionId,
        reference: snapshot.reference,
        expectedRevision: proposal.expectedRevision,
        authorization,
        arguments: proposal.arguments,
      };
      const pending = receipts.filter(
        (receipt) => receipt.generation === snapshot.generation && (receipt.status === 'pending' || receipt.status === 'running'),
      );
      const completed = receipts.filter((receipt) => receipt.status === 'done' || receipt.status === 'failed').slice(-100);
      snapshot.actionReceipts = [
        ...completed,
        ...pending,
        { request, generation: snapshot.generation, idempotencyKey: proposal.idempotencyKey, status: 'pending' },
      ];
      return { snapshot, result: structuredClone(request) };
    });
  }

  /**
   * Resolve an item control from the current cached source state and record
   * its authority. The client's labels and enabled flags grant nothing: the
   * control must still exist, be enabled and bind an effect the source
   * declares as a human action, and the item must still have the revision
   * the person saw. The receipt and generation checks are those of
   * `authorize`; the item ID travels in the recorded arguments.
   */
  authorizeItem(
    key: string,
    proposal: WatchItemActionProposal,
    authorization: WatchActionRequest<WatchValue>['authorization'],
  ): WatchActionRequest<WatchValue> {
    const resolved = resolveItemControl(this.journal.read(key), proposal);
    return this.authorize(
      key,
      {
        actionId: resolved.action,
        expectedRevision: `${proposal.item}@${proposal.expectedRevision}`,
        idempotencyKey: proposal.idempotencyKey,
        authority: authorization.id,
        arguments: { item: proposal.item, values: resolved.values },
      },
      authorization,
      // Resolve again under the journal lock, so a concurrent change cannot slip in.
      (current) => {
        const again = resolveItemControl(current, proposal);
        if (again.action !== resolved.action || !isDeepStrictEqual(again.values, resolved.values))
          throw new WatchItemConflict('This item changed. Its controls were refreshed.');
      },
    );
  }

  /** Replay returns the recorded result. A stale generation or forged request performs no effect. */
  async execute(key: string, request: WatchActionRequest<WatchValue>): Promise<WatchEffectResult | undefined> {
    const token = randomUUID(),
      claimed = this.claim(key, request, token);
    if (!claimed) return undefined;
    if (claimed.kind === 'cached') return claimed.result;
    const adapter = this.registry.get(claimed.typeId),
      handler = adapter.effectHandler;
    if (!handler) throw new Error('Watch action handler is unavailable');
    try {
      const result = await handler.execute({ ...structuredClone(request), generation: claimed.generation });
      watchJson(result);
      if (!Array.isArray(result.workIds) || result.workIds.some((id) => typeof id !== 'string' || !id))
        throw new Error('Watch effect returned invalid work IDs');
      this.finish(key, request.id, token, (receipt) => {
        receipt.status = 'done';
        receipt.result = result;
        receipt.failure = undefined;
      });
      return result;
    } catch (error) {
      const failure = sourceWatchFailure(adapter, error);
      this.finish(key, request.id, token, (receipt) => {
        receipt.status = 'failed';
        receipt.failure = failure;
      });
      throw error;
    }
  }

  /** The synchronous daemon can run local effects without an async polling branch. */
  executeSync(key: string, request: WatchActionRequest<WatchValue>): WatchEffectResult | undefined {
    const token = randomUUID(),
      claimed = this.claim(key, request, token);
    if (!claimed) return undefined;
    if (claimed.kind === 'cached') return claimed.result;
    const adapter = this.registry.get(claimed.typeId),
      handler = adapter.effectHandler;
    if (!handler) throw new Error('Watch action handler is unavailable');
    try {
      if (handler.execution === 'async') throw new Error('An asynchronous watch effect requires the asynchronous runtime');
      const result = handler.execute({ ...structuredClone(request), generation: claimed.generation });
      if (result && typeof (result as Promise<WatchEffectResult>).then === 'function') {
        void (result as Promise<WatchEffectResult>).catch(() => {});
        throw new Error('An asynchronous watch effect requires the asynchronous runtime');
      }
      const output = result as WatchEffectResult;
      watchJson(output);
      if (!Array.isArray(output.workIds) || output.workIds.some((id) => typeof id !== 'string' || !id))
        throw new Error('Watch effect returned invalid work IDs');
      this.finish(key, request.id, token, (receipt) => {
        receipt.status = 'done';
        receipt.result = output;
        receipt.failure = undefined;
      });
      return output;
    } catch (error) {
      const failure = sourceWatchFailure(adapter, error);
      this.finish(key, request.id, token, (receipt) => {
        receipt.status = 'failed';
        receipt.failure = failure;
      });
      throw error;
    }
  }

  private claim(key: string, request: WatchActionRequest<WatchValue>, token: string): ActionClaim {
    watchJson(request);
    return this.journal.update<ActionClaim>(key, (snapshot) => {
      const receipt = snapshot?.actionReceipts?.find((entry) => entry.request.id === request.id);
      if (
        !snapshot ||
        !receipt ||
        receipt.generation !== snapshot.generation ||
        snapshot.status === 'retired' ||
        !isDeepStrictEqual(receipt.request, request)
      )
        throw new Error('Watch action has no matching recorded authority');
      if (!this.registry.get(snapshot.type.id).effectHandler) throw new Error('Watch action handler is unavailable');
      if (receipt.status === 'done') return { result: { kind: 'cached', result: receipt.result } };
      if (snapshot.actionReceipts?.some((entry) => entry.lease && entry.lease.until > Date.now())) return { result: undefined };
      receipt.status = 'running';
      receipt.lease = { token, until: Date.now() + 120_000 };
      return { snapshot, result: { kind: 'execute', typeId: snapshot.type.id, generation: snapshot.generation } };
    });
  }

  private finish(key: string, requestId: string, token: string, change: (receipt: WatchActionReceipt) => void): void {
    this.journal.update(key, (snapshot) => {
      const receipt = snapshot?.actionReceipts?.find((entry) => entry.request.id === requestId);
      if (!snapshot || !receipt || receipt.generation !== snapshot.generation || receipt.lease?.token !== token)
        return { result: undefined };
      change(receipt);
      receipt.lease = undefined;
      return { snapshot, result: undefined };
    });
  }
}
