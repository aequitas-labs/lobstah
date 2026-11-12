import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicRenameSync, laneDirs, lobstahHome, uniqueTempPath } from './paths.js';
import { claudeTranscriptFile } from './remote-link.js';
import { codexRolloutFile } from './resume.js';
import { parseTodoTime } from './todo-time.js';
import { listTraps, readSessionClaim, readTrap, type TrapRegistration } from './soak.js';
import { listRoster, readRoster } from './roster.js';
import { storedDescriptor } from './queue.js';
import type { Lane } from './types.js';
import { postNotice } from './notices.js';

/** A provider's terminal usage error, separate from the worker's own reported verb. */
export interface UsageLimit {
  reason: string;
  at: string;
  resetAt?: string;
  fingerprint: string;
}

/** One account surface's limit, with the traps and work held behind it. */
export interface UsageLimitGroup extends UsageLimit {
  account: string;
  harness: string;
  traps: string[];
  waiting: string[];
}

/** A reset wake is kept until its session receives it, including across daemon restarts. */
export interface UsageResetWake {
  trapId: string;
  sessionId: string;
  fingerprint: string;
  resetAt?: string;
}

interface TrapLimit extends UsageLimit {
  trapId: string;
  sessionId: string;
  harness: string;
  account: string;
  dispatch?: string;
  resumed?: boolean;
  woken?: boolean;
}
interface LimitStore {
  traps: Record<string, TrapLimit>;
}
interface QuotaWindow {
  window_minutes?: number;
  used_percent?: number;
  resets_at?: number;
}
interface TranscriptEntry {
  timestamp?: string;
  uuid?: string;
  type?: string;
  isApiErrorMessage?: boolean;
  error?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
  payload?: {
    type?: string;
    role?: string;
    codex_error_info?: string;
    message?: string;
    will_retry?: boolean;
    rate_limits?: { primary?: QuotaWindow; secondary?: QuotaWindow };
  };
}
/** Provider errors and quota percentages observed without reading credentials or estimating tokens. */
export interface TranscriptObservation {
  limit?: UsageLimit;
  /** A later model response proves the session got past its provider hold. */
  recoveredAt?: string;
  warning?: { used: number; resetAt: string };
}
const fileFor = (): string => path.join(lobstahHome(), 'usage-limits.json');
const RESET_MARGIN_MS = 60_000;
const files = new Map<string, string>();
const observations = new Map<string, { size: number; modified: number; value: TranscriptObservation }>();
const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 24);

/** Read the daemon's observations; an absent or damaged cache does not block work. */
function readStore(): LimitStore {
  try {
    const value = JSON.parse(fs.readFileSync(fileFor(), 'utf8')) as LimitStore;
    if (!value?.traps || typeof value.traps !== 'object' || Array.isArray(value.traps)) return { traps: {} };
    return {
      traps: Object.fromEntries(
        Object.entries(value.traps).filter(
          ([id, limit]) =>
            limit &&
            typeof limit === 'object' &&
            limit.trapId === id &&
            typeof limit.sessionId === 'string' &&
            typeof limit.harness === 'string' &&
            typeof limit.account === 'string' &&
            typeof limit.reason === 'string' &&
            typeof limit.fingerprint === 'string' &&
            Number.isFinite(Date.parse(limit.at)),
        ),
      ),
    };
  } catch {
    return { traps: {} };
  }
}

/** Interpret a provider's reset clock in its stated timezone, retaining unknown clocks as raw text. */
export function usageResetAt(reason: string, at: number): string | undefined {
  const instant = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b/.exec(reason)?.[1];
  if (instant && Number.isFinite(Date.parse(instant)) && Date.parse(instant) > at) return new Date(instant).toISOString();
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*\(([^)]+)\)/i.exec(reason);
  if (!clock || Number(clock[1]) < 1 || Number(clock[1]) > 12 || Number(clock[2] ?? 0) > 59) return undefined;
  const hour = (Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === 'pm' ? 12 : 0);
  try {
    return parseTodoTime(`${String(hour).padStart(2, '0')}:${clock[2] ?? '00'}`, at, clock[4]);
  } catch {
    return undefined;
  }
}

/** Read only a bounded transcript tail; tool output and model prose never count as limit signals. */
export function transcriptUsage(file: string, harness: string): TranscriptObservation {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return {};
  }
  const cached = observations.get(file);
  if (cached?.size === stat.size && cached.modified === stat.mtimeMs) return cached.value;
  const fd = fs.openSync(file, 'r');
  let text: string;
  try {
    const bytes = Buffer.alloc(Math.min(stat.size, 256 * 1024));
    const read = fs.readSync(fd, bytes, 0, bytes.length, stat.size - bytes.length);
    text = bytes.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const observation: TranscriptObservation = {};
  let quotaReset: string | undefined;
  for (const line of text.split('\n')) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const payload = entry.payload ?? {};
    const at = typeof entry.timestamp === 'string' ? entry.timestamp : new Date(stat.mtimeMs).toISOString();
    let reason: string | undefined;
    if (harness === 'claude' && entry.type === 'assistant') {
      if (entry.isApiErrorMessage === true && entry.error === 'rate_limit') {
        reason = (Array.isArray(entry.message?.content) ? entry.message.content : [])
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('\n');
      } else {
        delete observation.limit;
        observation.recoveredAt = at;
      }
    }
    if (harness === 'codex') {
      if (
        entry.type === 'event_msg' &&
        payload.type === 'error' &&
        payload.will_retry !== true &&
        (/^(usageLimitExceeded|rateLimitExceeded|usage_limit_reached|usage_limit_exceeded|rate_limit_exceeded)$/.test(
          String(payload.codex_error_info ?? ''),
        ) ||
          /(?:usage.limit.{0,20}(?:reached|exceeded)|(?:hit|reached|exceeded).{0,20}usage limit)/i.test(String(payload.message ?? '')))
      )
        reason = String(payload.message ?? 'Codex usage limit reached');
      else if (entry.type === 'response_item' && (payload.role === 'assistant' || payload.type === 'function_call')) {
        delete observation.limit;
        observation.recoveredAt = at;
      }
      if (entry.type === 'event_msg' && payload.type === 'token_count') {
        const windows = [payload.rate_limits?.primary, payload.rate_limits?.secondary];
        const reached = windows.filter((window) => (window?.used_percent ?? 0) >= 100 && Number.isFinite(window?.resets_at));
        quotaReset = reached.length ? new Date(Math.max(...reached.map((window) => window!.resets_at!)) * 1000).toISOString() : undefined;
        const weekly = windows.find(
          (window) =>
            (window?.window_minutes ?? 0) >= 7 * 24 * 60 && (window?.used_percent ?? 0) >= 90 && Number.isFinite(window?.resets_at),
        );
        if (weekly) observation.warning = { used: weekly.used_percent!, resetAt: new Date(weekly.resets_at! * 1000).toISOString() };
        else delete observation.warning;
      }
    }
    if (reason) {
      delete observation.recoveredAt;
      const resetAt =
        usageResetAt(reason, Date.parse(at)) ??
        (harness === 'codex' && quotaReset && Date.parse(quotaReset) > Date.parse(at) ? quotaReset : undefined);
      observation.limit = {
        reason: reason.slice(0, 2000),
        at,
        fingerprint: hash(`${entry.uuid ?? at}:${reason}`),
        ...(resetAt ? { resetAt } : {}),
      };
    }
  }
  observations.set(file, { size: stat.size, modified: stat.mtimeMs, value: observation });
  return observation;
}

/** Local CLI credentials share a bucket; app-owned sessions remain separate from the CLI subscription. */
export function usageAccount(trap: Pick<TrapRegistration, 'harness' | 'window' | 'link' | 'configured'>): string {
  const app =
    trap.configured?.surface === 'claude-desktop' ||
    /desktop|vscode/i.test(trap.window?.entrypoint ?? '') ||
    /^(claude|codex|vscode):/.test(trap.link ?? '');
  return trap.harness === 'claude'
    ? `Claude ${app ? 'app' : 'CLI'} account`
    : `${trap.harness === 'codex' ? 'Codex' : trap.harness} account`;
}

/** Current limits grouped by account and reset window, without one notice per trap. */
export function usageLimitGroups(): UsageLimitGroup[] {
  const groups = new Map<string, UsageLimitGroup>();
  const live = listTraps();
  for (const limit of Object.values(readStore().traps).filter((limit) => !limit.resumed)) {
    const key = `${limit.account}:${hash(limit.reason)}:${limit.resetAt ?? ''}`;
    const group = groups.get(key) ?? { ...limit, traps: [], waiting: [] };
    const current = live.find((trap) => trap.trapId === limit.trapId);
    if (!current || usageAccount(current) === limit.account) {
      group.traps.push(limit.trapId);
      const dispatch = current?.claimed ?? limit.dispatch;
      if (
        dispatch &&
        (['work', 'chore'] as const).some(
          (lane) =>
            fs.existsSync(path.join(laneDirs(lane).active, dispatch)) || fs.existsSync(path.join(laneDirs(lane).queue, `${dispatch}.json`)),
        )
      )
        group.waiting.push(dispatch);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** An account limit blocks pickup without changing a worker's report or a sticky address. */
export function trapUsageLimit(trap: Pick<TrapRegistration, 'harness' | 'window' | 'link' | 'configured'>): UsageLimitGroup | undefined {
  return usageLimitGroups().find((group) => group.account === usageAccount(trap));
}

/** An unfinished sticky catch shows its provider limit instead of its stale worker verb. */
export function dispatchUsageLimit(id: string, lane: Lane): UsageLimitGroup | undefined {
  const dirs = laneDirs(lane);
  if (!fs.existsSync(path.join(dirs.active, id)) && !fs.existsSync(path.join(dirs.queue, `${id}.json`))) return undefined;
  const address = readSessionClaim(id, lane)?.by ?? storedDescriptor(id, lane)?.for;
  if (!address?.startsWith('wt:')) return undefined;
  const trap = readTrap(address.slice(3)) ?? readRoster(address.slice(3));
  return trap ? trapUsageLimit(trap) : undefined;
}

/** Observe real provider signals before ghost sweeping, then queue each reset wake once. */
export function observeUsageLimits(now = Date.now()): UsageResetWake[] {
  const store = readStore();
  const before = JSON.stringify(store);
  const live = listTraps();
  const traps = [
    ...live,
    ...listRoster().filter(
      (entry) =>
        entry.state === 'ghosted' &&
        now - Date.parse(entry.leftAt ?? '') <= 86_400_000 &&
        !live.some((trap) => trap.trapId === entry.trapId),
    ),
  ];
  for (const trap of traps) {
    if (!trap.sessionId || !['claude', 'codex'].includes(trap.harness)) continue;
    const key = `${lobstahHome()}:${process.env.CLAUDE_CONFIG_DIR ?? ''}:${process.env.CODEX_HOME ?? ''}:${trap.harness}:${trap.sessionId}`;
    let file = files.get(key);
    if (file && !fs.existsSync(file)) {
      files.delete(key);
      file = undefined;
    }
    if (!file) {
      file = trap.harness === 'claude' ? claudeTranscriptFile(trap.sessionId, [trap.worktree]) : codexRolloutFile(trap.sessionId);
      if (file) files.set(key, file);
    }
    if (!file) continue;
    const observed = transcriptUsage(file, trap.harness);
    const prior = store.traps[trap.trapId];
    const account = usageAccount(trap);
    if (observed.limit && (!prior || prior.fingerprint !== observed.limit.fingerprint || prior.sessionId !== trap.sessionId)) {
      const dispatch =
        live.find((registration) => registration.trapId === trap.trapId)?.claimed ?? ('lastCatch' in trap ? trap.lastCatch : undefined);
      store.traps[trap.trapId] = {
        ...observed.limit,
        trapId: trap.trapId,
        sessionId: trap.sessionId,
        harness: trap.harness,
        account,
        ...(dispatch ? { dispatch } : {}),
      };
    } else if (
      !observed.limit &&
      observed.recoveredAt &&
      prior &&
      !prior.resumed &&
      Date.parse(observed.recoveredAt) >= Date.parse(prior.at)
    )
      prior.resumed = prior.woken = true;
    if (observed.warning && !observed.limit)
      postNotice({
        kind: 'usage-limit-warning',
        text: `${account} weekly usage is ${Math.round(observed.warning.used)}% · resets ${observed.warning.resetAt}`,
        dedupeKey: `usage-warning-${hash(`${account}:${observed.warning.resetAt}`)}`,
      });
  }
  for (const limit of Object.values(store.traps))
    if (!limit.resumed && limit.resetAt && now >= Date.parse(limit.resetAt) + RESET_MARGIN_MS) limit.resumed = true;
  if (JSON.stringify(store) !== before) {
    fs.mkdirSync(lobstahHome(), { recursive: true });
    const tmp = uniqueTempPath(fileFor());
    fs.writeFileSync(tmp, JSON.stringify(store));
    atomicRenameSync(tmp, fileFor());
  }
  for (const group of usageLimitGroups())
    postNotice({
      kind: 'usage-limit',
      text: `${group.account} limited · ${group.traps.length} traps · ${group.resetAt ? `resets ${group.resetAt}` : 'reset unknown'} · waiting: ${group.waiting.join(', ') || 'pickup queue'}`,
      dedupeKey: `usage-limit-${hash(`${group.account}:${group.resetAt ?? ''}:${group.reason}`)}`,
    });
  return Object.values(store.traps)
    .filter((limit) => limit.resumed && !limit.woken)
    .map((limit) => ({ trapId: limit.trapId, sessionId: limit.sessionId, fingerprint: limit.fingerprint, resetAt: limit.resetAt }));
}

/** A delivered reset prompt must not be replayed after the next daemon tick or restart. */
export function acknowledgeUsageReset(wake: UsageResetWake): void {
  const store = readStore(),
    limit = store.traps[wake.trapId];
  if (!limit || limit.sessionId !== wake.sessionId || limit.fingerprint !== wake.fingerprint) return;
  limit.woken = true;
  const tmp = uniqueTempPath(fileFor());
  fs.writeFileSync(tmp, JSON.stringify(store));
  atomicRenameSync(tmp, fileFor());
}
