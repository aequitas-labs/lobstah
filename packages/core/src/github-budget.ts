import * as fs from 'node:fs';
import * as path from 'node:path';
import { uniqueTempPath, lobstahHome } from './paths.js';
import { postNotice } from './notices.js';

interface Budget {
  limit: number;
  remaining: number;
  reset: number;
  cost: number;
}
interface BudgetState {
  resources: Record<string, Budget>;
  limitedSince?: number;
  retryAt?: number;
}
const file = () => path.join(lobstahHome(), 'github-budget.json');
function read(): BudgetState {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return { resources: {} };
  }
}
function write(s: BudgetState): void {
  fs.mkdirSync(lobstahHome(), { recursive: true });
  const tmp = uniqueTempPath(file());
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file());
}

function withBudgetLock<T>(action: () => T): T {
  fs.mkdirSync(lobstahHome(), { recursive: true });
  const lock = `${file()}.lock`,
    deadline = Date.now() + 10_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
      } catch {
        /* raced */
      }
      if (Date.now() >= deadline) throw new Error('GitHub budget state locked; retry next cycle');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return action();
  } finally {
    fs.rmdirSync(lock);
  }
}

/** gh api --include: headers come with the request, never a separate rate_limit poll. */
export function splitGitHubResponse(stdout: string): { headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {};
  const start = stdout.search(/^[{[]/m);
  const prefix = start < 0 ? stdout : stdout.slice(0, start);
  for (const line of prefix.split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return { headers, body: start < 0 ? '' : stdout.slice(start) };
}

/** Fixed 15% low-water mark; spend at most half the remaining budget before reset. */
export function githubPollIntervalSecs(floor: number, now = Date.now(), cycleRequests = 1): number {
  const s = read();
  let interval = floor;
  if (s.retryAt && s.retryAt > now) interval = Math.max(interval, (s.retryAt - now) / 1000);
  for (const b of Object.values(s.resources)) {
    if (b.reset <= now || b.remaining >= b.limit * 0.15) continue;
    interval = Math.max(interval, (((b.reset - now) / 1000) * b.cost * cycleRequests) / Math.max(1, b.remaining / 2));
  }
  return interval;
}

export function githubBlockedUntil(now = Date.now()): number | undefined {
  const s = read();
  const zeros = Object.values(s.resources)
    .filter((b) => b.remaining === 0 && b.reset > now)
    .map((b) => b.reset);
  const until = Math.max(s.retryAt ?? 0, ...zeros);
  return until > now ? until : undefined;
}

/** One shared incident, not one streak/recovery for every watch. */
export function recordGitHubRateLimit(now = Date.now(), retryAt?: number): void {
  withBudgetLock(() => {
    const s = read();
    const known = Math.max(s.retryAt ?? 0, ...Object.values(s.resources).map((b) => b.reset));
    const reset = retryAt ?? (known > now ? known : now + 60_000);
    if (!s.limitedSince) {
      s.limitedSince = now;
      postNotice({
        kind: 'rate-limited',
        refId: 'github',
        text: `GitHub rate limited; PR polling waits until ${new Date(reset).toISOString()} (shared budget; worker calls need room)`,
        dedupeKey: `github-rate-limited-${now}`,
      });
    }
    s.retryAt = Math.max(s.retryAt ?? 0, reset);
    write(s);
  });
}

export function recordGitHubResponse(headers: Record<string, string>, opts: { now?: number; cost?: number; success?: boolean } = {}): void {
  withBudgetLock(() => {
    const now = opts.now ?? Date.now(),
      s = read();
    const resource = headers['x-ratelimit-resource'];
    const limit = Number(headers['x-ratelimit-limit']),
      remaining = Number(headers['x-ratelimit-remaining']);
    const reset = Number(headers['x-ratelimit-reset']) * 1000;
    if (resource && Number.isFinite(limit) && limit > 0 && Number.isFinite(remaining) && remaining >= 0 && Number.isFinite(reset)) {
      const before = s.resources[resource];
      s.resources[resource] = {
        limit,
        remaining: before?.reset === reset ? Math.min(before.remaining, remaining) : remaining,
        reset,
        cost: Math.max(1, opts.cost ?? 1, before?.reset === reset ? before.cost : 1),
      };
    }
    if (opts.success && s.limitedSince && remaining !== 0) {
      postNotice({
        kind: 'rate-limit-recovered',
        refId: 'github',
        text: 'GitHub rate limit recovered; PR polling resumed',
        dedupeKey: `github-rate-recovered-${s.limitedSince}`,
      });
      s.limitedSince = undefined;
      s.retryAt = undefined;
    }
    write(s);
  });
}
