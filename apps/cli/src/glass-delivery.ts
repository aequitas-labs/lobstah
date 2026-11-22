import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COMPILED_BINARY } from '@lobstah/core';
import { deliverPending, pendingSubmissions, readSubmissionStatus } from './glass-submissions.js';
import type { SubmissionStatus } from './glass-submissions.js';

/**
 * The glass server's side of the outbox (glass-submissions.ts): it starts
 * `lobstah glass deliver` when something is recorded, starts it again when
 * more arrived while it ran, and hears each settled submission from its
 * output. A page waiting on its answer or message is told the moment it
 * settles.
 */
export interface SubmissionDelivery {
  /** Deliver what is pending: start a delivery, or have the running one's successor pick up what it missed. */
  kick(): void;
  /** The submission's status once it settles, or as it stands after `waitMs`. Undefined for an id the outbox never had. */
  settled(id: string, waitMs: number): Promise<SubmissionStatus | undefined>;
}

/** Runs one delivery pass and reports each settled submission. Resolves when the pass ends. */
export type DeliveryRunner = (onSettled: (status: SubmissionStatus) => void) => Promise<void>;

/** The CLI entry a node install runs `glass deliver` from: the built main.js beside this file. */
function cliEntry(): string[] | undefined {
  if (COMPILED_BINARY) return [];
  const main = fileURLToPath(new URL('./main.js', import.meta.url));
  return fs.existsSync(main) ? [main] : undefined;
}

/**
 * Deliver in a separate `lobstah glass deliver` process, so its lock waits
 * and scans never stall the glass server. Without a built CLI beside this
 * file (a test running the source), delivery runs in this process instead.
 */
export const processRunner: DeliveryRunner = (onSettled) => {
  const entry = cliEntry();
  return entry ? deliveryProcess(entry)(onSettled) : deliverPending(onSettled);
};

/** Run `glass deliver` with node and these arguments before it (the CLI's entry file; none for the compiled binary). */
export function deliveryProcess(entry: readonly string[]): DeliveryRunner {
  return (onSettled) => new Promise((resolve) => {
    const child = spawn(process.execPath, [...entry, 'glass', 'deliver'], { stdio: ['ignore', 'pipe', 'inherit'], env: process.env, windowsHide: true });
    let buffered = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buffered += chunk;
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try {
          onSettled(JSON.parse(line) as SubmissionStatus);
        } catch {
          // Not a status line: nothing to tell a page.
        }
      }
    });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

export function startSubmissionDelivery(opts: { run?: DeliveryRunner; onSettled?: (status: SubmissionStatus) => void } = {}): SubmissionDelivery {
  const run = opts.run ?? processRunner;
  const waiters = new Map<string, Set<(status: SubmissionStatus) => void>>();
  let running = false;
  let again = false;
  /** Passes in a row that ended with work pending and nothing settled: each waits longer, up to 30 s. */
  let stalled = 0;
  let settledThisPass = false;
  const told = (status: SubmissionStatus) => {
    settledThisPass = true;
    opts.onSettled?.(status);
    for (const wake of waiters.get(status.id) ?? []) wake(status);
    waiters.delete(status.id);
  };
  const pass = (): void => {
    running = true;
    again = false;
    settledThisPass = false;
    run(told)
      .catch(() => undefined)
      .then(() => {
        running = false;
        // A submission recorded while the pass ran may have come after its last look.
        if (again) return void setTimeout(pass, 0);
        if (pendingSubmissions().length === 0) return void (stalled = 0);
        stalled = settledThisPass ? 0 : stalled + 1;
        setTimeout(pass, Math.min(30_000, 500 * 2 ** stalled)).unref?.();
      });
  };
  return {
    kick() {
      if (running) return void (again = true);
      running = true;
      // After the reply that recorded it has gone out.
      setImmediate(pass);
    },
    settled(id, waitMs) {
      const now = readSubmissionStatus(id);
      if (!now || now.state !== 'pending' || waitMs <= 0) return Promise.resolve(now);
      return new Promise((resolve) => {
        const wake = (status: SubmissionStatus) => {
          clearTimeout(timer);
          resolve(status);
        };
        const timer = setTimeout(() => {
          waiters.get(id)?.delete(wake);
          resolve(readSubmissionStatus(id));
        }, waitMs);
        timer.unref?.();
        if (!waiters.has(id)) waiters.set(id, new Set());
        waiters.get(id)!.add(wake);
      });
    },
  };
}
