import type { WatchActionRequest, WatchRegistry, WatchValue } from '@lobstah/watch-types';
import { WatchActionRunner } from './watch-actions.js';
import { WatchJournal } from './watch-journal.js';

/** Automatic source effects share the same work cap and recorded-authority boundary. */
export class WatchAutomationRunner {
  readonly actions: WatchActionRunner;
  constructor(
    readonly registry: WatchRegistry,
    readonly journal = new WatchJournal(),
  ) {
    this.actions = new WatchActionRunner(registry, journal);
  }

  /** A synchronous host accepts only synchronous source handlers. */
  runSync(keys: readonly string[], now: number, cap: number, log: (message: string) => void): string[] {
    const work: string[] = [];
    for (const key of new Set(keys)) {
      if (work.length >= cap) break;
      for (const request of this.safeRequests(key, now, log, 'sync')) {
        if (work.length >= cap) break;
        try {
          work.push(...(this.actions.executeSync(key, request)?.workIds ?? []));
        } catch (error) {
          log(`watch ${key} action ${request.actionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return work;
  }

  /** Async hosts use the same receipt rules for review posting and process plugins. */
  async run(keys: readonly string[], now: number, cap: number, log: (message: string) => void): Promise<string[]> {
    const work: string[] = [];
    for (const key of new Set(keys)) {
      if (work.length >= cap) break;
      for (const request of this.safeRequests(key, now, log)) {
        if (work.length >= cap) break;
        try {
          work.push(...((await this.actions.execute(key, request))?.workIds ?? []));
        } catch (error) {
          log(`watch ${key} action ${request.actionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return work;
  }

  private safeRequests(key: string, now: number, log: (message: string) => void, execution?: 'sync'): WatchActionRequest<WatchValue>[] {
    try {
      return this.requests(key, now, execution);
    } catch (error) {
      log(`watch ${key} automation: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private requests(key: string, now: number, execution?: 'sync'): WatchActionRequest<WatchValue>[] {
    const snapshot = this.journal.read(key);
    if (!snapshot || snapshot.status === 'retired' || snapshot.status === 'held') return [];
    const adapter = this.registry.get(snapshot.type.id);
    if (!adapter.effectHandler || (execution === 'sync' && adapter.effectHandler.execution === 'async')) return [];
    const pending =
      snapshot.actionReceipts?.filter(
        (receipt) => receipt.generation === snapshot.generation && (receipt.status === 'pending' || receipt.status === 'running'),
      ) ?? [];
    if (pending.length) return pending.map((receipt) => receipt.request);
    return (adapter.automation?.propose({ snapshot, now: new Date(now).toISOString() }) ?? [])
      .map((proposal) =>
        this.actions.authorize(key, proposal, { id: proposal.authority, by: 'configuration', at: new Date(now).toISOString() }),
      )
      .filter(
        (request) =>
          !this.journal.read(key)?.actionReceipts?.some((receipt) => receipt.request.id === request.id && receipt.status === 'done'),
      );
  }
}
