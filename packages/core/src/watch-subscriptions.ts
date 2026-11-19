import type { WatchRegistry } from '@lobstah/watch-types';
import { WatchJournal } from './watch-journal.js';
import { randomUUID } from 'node:crypto';
import { WatchRuntime } from './watch-runtime.js';

interface ActiveSubscription {
  generation: string;
  token: string;
  installation: string;
  controller: AbortController;
  task: Promise<void>;
}

/** One leased stream per durable watch; reconnect always begins at its committed checkpoint. */
export class WatchSubscriptionManager {
  private readonly active = new Map<string, ActiveSubscription>();
  constructor(readonly runtime: WatchRuntime) {}

  /** Renew live streams and start eligible adapter capabilities without waiting for provider IO. */
  pass(now = Date.now(), registry = this.runtime.registry): void {
    this.runtime.registry = registry;
    const snapshots = this.runtime.journal.list();
    const installations = new Map(registry.list().map((source) => [source.descriptor.id, JSON.stringify(source.descriptor)]));
    const live = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
    for (const [key, entry] of this.active) {
      const snapshot = live.get(key);
      if (
        !snapshot ||
        snapshot.generation !== entry.generation ||
        snapshot.status !== 'watching' ||
        snapshot.subscriptionLease?.token !== entry.token ||
        installations.get(snapshot.type.id) !== entry.installation
      )
        entry.controller.abort();
    }
    for (const snapshot of snapshots) {
      if (snapshot.status !== 'watching') continue;
      let source;
      try {
        source = this.runtime.registry.get(snapshot.type.id);
      } catch {
        continue;
      }
      if (!source.subscriber) continue;
      const existing = this.active.get(snapshot.key);
      if (existing && (existing.generation !== snapshot.generation || existing.controller.signal.aborted)) continue;
      const token = existing?.token ?? randomUUID();
      const claimed = this.runtime.journal.update(snapshot.key, (current) => {
        if (
          !current ||
          current.generation !== snapshot.generation ||
          current.status !== 'watching' ||
          (current.subscriptionLease && current.subscriptionLease.token !== token && current.subscriptionLease.until > now)
        )
          return { result: undefined };
        current.subscriptionLease = { token, until: now + 120_000 };
        return { snapshot: current, result: structuredClone(current) };
      });
      if (!claimed || existing) continue;
      const controller = new AbortController();
      const entry: ActiveSubscription = {
        generation: claimed.generation,
        token,
        installation: JSON.stringify(source.descriptor),
        controller,
        task: Promise.resolve(),
      };
      this.active.set(claimed.key, entry);
      entry.task = (async () => {
        try {
          for await (const batch of source.subscriber!.subscribe({
            snapshot: claimed,
            now: new Date(now).toISOString(),
            signal: controller.signal,
          })) {
            while (!controller.signal.aborted) {
              const current = this.runtime.journal.read(claimed.key);
              if (
                !current ||
                current.generation !== claimed.generation ||
                current.status !== 'watching' ||
                current.subscriptionLease?.token !== token
              )
                return;
              if (this.runtime.accept(claimed.key, claimed.generation, batch)) break;
              await new Promise<void>((resolve) => {
                const finish = () => {
                  clearTimeout(timer);
                  controller.signal.removeEventListener('abort', finish);
                  resolve();
                };
                const timer = setTimeout(finish, 25);
                controller.signal.addEventListener('abort', finish, { once: true });
              });
            }
            if (controller.signal.aborted) break;
          }
        } catch (error) {
          if (!controller.signal.aborted) this.runtime.subscriptionFailed(claimed.key, claimed.generation, error);
        } finally {
          this.runtime.journal.update(claimed.key, (current) => {
            if (current?.subscriptionLease?.token !== token) return { result: undefined };
            current.subscriptionLease = undefined;
            return { snapshot: current, result: undefined };
          });
          if (this.active.get(claimed.key) === entry) this.active.delete(claimed.key);
        }
      })();
    }
  }

  /** Host shutdown aborts only streams owned by this manager. */
  async dispose(): Promise<void> {
    const entries = [...this.active.values()];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map((entry) => entry.task));
  }
}
const managers = new Map<string, WatchSubscriptionManager>();

/** Daemon and pickup hosts share generic scheduling; the journal lease arbitrates across processes. */
export function syncWatchSubscriptions(registry: WatchRegistry, now = Date.now()): void {
  const journal = new WatchJournal();
  let manager = managers.get(journal.directory);
  if (!manager) {
    manager = new WatchSubscriptionManager(new WatchRuntime(registry, journal));
    managers.set(journal.directory, manager);
  }
  manager.pass(now, registry);
}
