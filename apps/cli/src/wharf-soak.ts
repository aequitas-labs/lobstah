import { CONFIGURED_TRAP_INSTRUCTION, captureWindow } from '@lobstah/core';
import * as path from 'node:path';
import { IdleWait, loadConfig, brokerRequest, forgetBrokerAgent, readBrokerAgent, saveBrokerAgent, type BackendScope, type BrokerAgent, type BrokerPoll } from '@lobstah/core';
import { resolveSessionId } from './session-id.js';
import { wharfSessionPid } from './wharf-session-pid.js';
import { detectHarness } from './harness-detect.js';
import { TMUX_SOCKET } from './tmux-terminal.js';
type Scope = Extract<BackendScope, { kind: 'wharf' }>;
type Options = { opt: (flag: string) => string | undefined; has: (flag: string) => boolean };
/**
 * The pane to publish to the wharf, only when it's on lobstah's own tmux
 * server, because that's the server the command wharf offers will name.
 */
export function lobstahTmuxPane(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const socket = env.TMUX?.split(',')[0];
  return env.TMUX_PANE && socket && path.basename(socket) === TMUX_SOCKET ? env.TMUX_PANE : undefined;
}
/** How often a waiting hosted trap asks the boat's broker for work: a job queued is claimed within about a second. */
export const BROKER_POLL_MS = 1_000;
export const brokerBody = (a: BrokerAgent) => ({ grounds: a.grounds, session: a.session, capability: a.capability });
export async function endBrokerAgent(a: BrokerAgent) {
  try { await brokerRequest('end', brokerBody(a)); }
  finally {
    forgetBrokerAgent(a.grounds); forgetBrokerAgent(a.grounds, a.worktree);
    if (a.origin) forgetBrokerAgent(a.grounds, a.origin);
  }
}
export async function waitBrokerAgent(a: BrokerAgent, seconds?: number): Promise<BrokerPoll> {
  const idle = new IdleWait(a.session, loadConfig().wait, seconds === undefined ? undefined : String(seconds));
  do {
    const p = await brokerRequest<BrokerPoll>('poll', brokerBody(a));
    if (p.claim || p.messages?.length) { idle.woke(); return p; }
    if (!idle.probe && idle.expired()) break;
    // The broker is on loopback and asks the wharf only when its socket heard of work, so a second's wait costs nothing remote.
    await new Promise((resolve) => setTimeout(resolve, Math.min(BROKER_POLL_MS, idle.probe ? BROKER_POLL_MS : idle.remainingMs())));
  } while (idle.probe || !idle.expired());
  idle.timedOut();
  return { claim: null };
}
/** Every live hosted trap signs on and gets work through the boat daemon. */
export async function wharfSoak(scope: Scope, opts: Options): Promise<void> {
  let a = readBrokerAgent(scope.grounds);
  const session = resolveSessionId({ flag: opts.opt('--session') })?.id ?? a?.session;
  if (!session) throw new Error('wharf soak needs --session <harness-session-id>; the SessionStart hook prints it');
  if (a && a.session !== session) throw new Error('another hosted session owns this worktree; stow it first');
  const profileName = opts.opt('--trap') ?? a?.configured?.profile;
  const profile = profileName ? loadConfig().traps?.[profileName] : undefined;
  if (profileName && (!profile || profile.grounds !== scope.grounds)) throw new Error('configured profile is not served in this grounds');
  const repo = opts.opt('--repo') ?? process.env.LOBSTAH_WHARF_REPO ?? a?.repo;
  if (!repo && !profile) throw new Error('wharf soak requires --repo <configured-repo> or --trap <profile>');
  if (profile && repo) throw new Error('configured traps do not take --repo');
  if (a && a.repo !== repo) throw new Error('the signed-on trap belongs to a different repo');
  const seconds = opts.opt('--timeout') === undefined ? undefined : Number(opts.opt('--timeout'));
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 0)) throw new Error('timeout must be nonnegative seconds');
  if (!a) {
    const harness = detectHarness({ flag: opts.opt('--harness'), sessionId: session });
    if (!harness.harness) throw new Error(`${harness.reason}; use --harness claude|codex`);
    const supplied = opts.opt('--ticket');
    const t = supplied ? { ticket: supplied, trap: process.env.LOBSTAH_WHARF_TRAP,
      request: process.env.LOBSTAH_WHARF_REQUEST, repo, grounds: scope.grounds }
      : await brokerRequest<Record<string, unknown>>('ticket', { grounds: scope.grounds, ...(profileName ? { profile: profileName } : { repo }), cwd: process.cwd() });
    a = await brokerRequest<BrokerAgent>('sign-on', { ...t, session, pid: wharfSessionPid(), harness: harness.harness, entrypoint: captureWindow()?.entrypoint, link: opts.opt('--link'), tmuxPane: lobstahTmuxPane() });
    saveBrokerAgent(a); saveBrokerAgent(a, a.worktree);
  }
  if (path.resolve(process.cwd()) !== path.resolve(a.worktree)) {
    console.log(JSON.stringify({ trap: a.trap, grounds: a.grounds, ...(a.configured ? { profile: a.configured.profile, cwd: a.worktree, repo: 'none' } : { worktree: a.worktree }),
      instruction: `cd ${a.worktree}, then lobstah soak --grounds ${a.grounds} --wait` }, null, 2)); return;
  }
  const p = opts.has('--wait') ? await waitBrokerAgent(a, seconds) : await brokerRequest<BrokerPoll>('poll', brokerBody(a));
  console.log(JSON.stringify({ trap: a.trap, grounds: a.grounds, ...(a.configured ? { profile: a.configured.profile, cwd: a.worktree, repo: 'none' } : { worktree: a.worktree }), ...p,
    ...(p.claim ? { instruction: `${a.configured ? CONFIGURED_TRAP_INSTRUCTION : 'Branch first in this worktree.'} Then report ${p.claim.dispatch.id} working. The daemon owns claim/renew; your session uses only this dispatch's token.` }
      : p.messages?.length ? { instruction: 'Read these inbox messages and receipt them explicitly with lobstah wharf receipt.' } : { timeout: opts.has('--wait') }) }, null, 2));
  if (!p.claim && !p.messages?.length && opts.has('--wait')) process.exitCode = 3;
}
