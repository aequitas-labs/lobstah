import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  acknowledgeUsageReset,
  claimBait,
  enqueue,
  ensureLayout,
  listNotices,
  loadConfig,
  observeUsageLimits,
  pendingIds,
  selectRepoTrap,
  signOnTrap,
  sweepGhostTraps,
  trapAvailability,
  trapUsageLimit,
  transcriptUsage,
  usageLimitGroups,
} from '../src/index.js';
import type { TrapRegistration } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
const now = Date.parse('2026-11-12T21:00:00Z');
const reason =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your weekly limit resets 8pm (America/New_York)";
const oldHome = process.env.LOBSTAH_HOME,
  oldClaude = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-usage-'));
  process.env.LOBSTAH_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
  ensureLayout();
  fs.writeFileSync(path.join(home, 'config.toml'), `[repos.r]\npath = '${home.replaceAll('\\', '/')}'\n`);
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.LOBSTAH_HOME;
  else process.env.LOBSTAH_HOME = oldHome;
  if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  removeTempDir(home);
});

/** A real registration and its isolated provider transcript. */
function trap(session: string, harness = 'claude'): { reg: TrapRegistration; file: string } {
  const worktree = path.join(home, session);
  fs.mkdirSync(worktree);
  const signed = signOnTrap({ worktree, cwd: worktree, repo: 'r', harness, sessionId: session, ttlMs: 60_000 });
  if (!('ok' in signed)) throw new Error('could not sign on');
  const file = path.join(process.env.CLAUDE_CONFIG_DIR!, 'projects', 'test', `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now).toISOString(),
      uuid: session,
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: reason }] },
    }) + '\n',
  );
  return { reg: signed.ok, file };
}

it('observes a real Claude limit fixture, parses its timezone, and tells the fleet once for many traps', () => {
  const first = trap('first'),
    second = trap('second');
  observeUsageLimits(now);
  expect(trapAvailability(first.reg).state).toBe('limited');
  expect(trapUsageLimit({ ...first.reg, window: { entrypoint: 'claude-desktop' } })).toBeUndefined();
  expect(trapUsageLimit(second.reg)?.resetAt).toBe('2026-11-13T01:00:00.000Z');
  expect(usageLimitGroups()[0]?.traps).toHaveLength(2);
  observeUsageLimits(now + 5000);
  expect(listNotices().filter((notice) => notice.kind === 'usage-limit')).toHaveLength(1);
  expect(listNotices().find((notice) => notice.kind === 'usage-limit')?.text).toContain('2 traps');
  expect(sweepGhostTraps(1, Date.now() + 3600_000)).toEqual([]);
});

it('keeps an unknown reset raw and defaults automatic swapping off', () => {
  const { reg, file } = trap('unknown-clock');
  fs.writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(now).toISOString(),
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'Usage limit reached; reset time unavailable' }] },
    }) + '\n',
  );
  expect(observeUsageLimits(now + 12 * 3600_000)).toEqual([]);
  expect(trapUsageLimit(reg)).toMatchObject({ reason: 'Usage limit reached; reset time unavailable' });
  expect(trapUsageLimit(reg)?.resetAt).toBeUndefined();
  expect(loadConfig().soak.swapOnLimit).toBe(false);
  fs.appendFileSync(path.join(home, 'config.toml'), '\n[soak]\nswapOnLimit = "yes"\n');
  expect(() => loadConfig()).toThrow('soak.swapOnLimit must be true or false');
});

it('does not clear a limit when its transcript disappears or only metadata follows the error', () => {
  const { reg, file } = trap('missing-transcript');
  observeUsageLimits(now);
  fs.appendFileSync(file, JSON.stringify({ type: 'system', timestamp: new Date(now + 1000).toISOString() }) + '\n');
  observeUsageLimits(now + 1000);
  expect(trapUsageLimit(reg)).toBeDefined();
  fs.rmSync(file);
  observeUsageLimits(now + 2000);
  expect(trapUsageLimit(reg)).toBeDefined();
  fs.writeFileSync(path.join(home, 'usage-limits.json'), JSON.stringify({ traps: { broken: {} } }));
  expect(usageLimitGroups()).toEqual([]);
});

it('uses only reached Codex quota windows as reset clocks and does not reuse an expired window', () => {
  const file = path.join(home, 'quota.jsonl');
  const records = [
    {
      type: 'event_msg',
      timestamp: new Date(now).toISOString(),
      payload: {
        type: 'token_count',
        rate_limits: { primary: { used_percent: 100, window_minutes: 10080, resets_at: Date.parse('2026-11-13T01:00:00Z') / 1000 } },
      },
    },
    {
      type: 'event_msg',
      timestamp: new Date(now).toISOString(),
      payload: { type: 'error', codex_error_info: 'usage_limit_reached', message: "You've hit your usage limit" },
    },
  ];
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  expect(transcriptUsage(file, 'codex').limit?.resetAt).toBe('2026-11-13T01:00:00.000Z');
  fs.appendFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: '2026-11-13T01:02:00Z', payload: records[1]!.payload }) + '\n');
  expect(transcriptUsage(file, 'codex').limit?.resetAt).toBeUndefined();
});

it('skips limited accounts for pickup, prefers a free Codex trap, and keeps addressed work sticky', () => {
  const limited = trap('limited').reg;
  const free = trap('free', 'codex').reg;
  observeUsageLimits(now);
  enqueue({ id: 'sticky', repo: 'r', brief: 'Continue here', for: `wt:${limited.trapId}` });
  enqueue({ id: 'pickup', repo: 'r', brief: 'Check release', trapAny: true });
  expect(claimBait(limited)).toBeNull();
  expect(selectRepoTrap(loadConfig(), 'r', undefined, Date.now())).toMatchObject({
    action: 'reuse',
    registration: { trapId: free.trapId },
  });
  expect(claimBait(free)?.id).toBe('pickup');
  expect(pendingIds('work')).toContain('sticky');
});

it('queues one reset wake after the margin, and a new error keeps the account limited again', () => {
  const { reg, file } = trap('reset');
  observeUsageLimits(now);
  const reset = Date.parse('2026-11-13T01:00:00Z');
  expect(observeUsageLimits(reset + 59_999)).toEqual([]);
  const [wake] = observeUsageLimits(reset + 60_000);
  expect(wake).toMatchObject({ trapId: reg.trapId, sessionId: reg.sessionId });
  expect(trapUsageLimit(reg)).toBeUndefined();
  expect(observeUsageLimits(reset + 60_001)).toEqual([wake]);
  acknowledgeUsageReset(wake!);
  expect(observeUsageLimits(reset + 60_002)).toEqual([]);
  fs.appendFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(reset + 61_000).toISOString(),
      uuid: 'again',
      isApiErrorMessage: true,
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: reason }] },
    }) + '\n',
  );
  observeUsageLimits(reset + 61_000);
  expect(trapUsageLimit(reg)).toBeDefined();
});

it('uses structured Codex errors and quota percentages, and ignores limit wording inside tool output', () => {
  const file = path.join(home, 'codex.jsonl');
  const write = (payload: unknown): void => {
    fs.appendFileSync(file, JSON.stringify(payload) + '\n');
  };
  write({
    type: 'event_msg',
    timestamp: new Date(now).toISOString(),
    payload: { type: 'token_count', rate_limits: { primary: { used_percent: 92, window_minutes: 10080, resets_at: 1794528000 } } },
  });
  write({ type: 'response_item', payload: { type: 'function_call_output', output: 'usage limit reached' } });
  expect(transcriptUsage(file, 'codex')).toMatchObject({ warning: { used: 92 } });
  expect(transcriptUsage(file, 'codex').limit).toBeUndefined();
  write({
    type: 'event_msg',
    timestamp: new Date(now).toISOString(),
    payload: { type: 'error', codex_error_info: 'usageLimitExceeded', message: 'Usage limit exceeded; resets at 2026-11-13T01:00:00Z' },
  });
  expect(transcriptUsage(file, 'codex').limit?.resetAt).toBe('2026-11-13T01:00:00.000Z');
  write({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } });
  expect(transcriptUsage(file, 'codex').limit).toBeUndefined();
});
