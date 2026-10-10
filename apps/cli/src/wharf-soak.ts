import * as path from 'node:path';
import { brokerRequest, forgetBrokerAgent, readBrokerAgent, saveBrokerAgent, type BackendScope, type BrokerAgent, type BrokerPoll } from '@lobstah/core';
import { resolveSessionId } from './session-id.js';
import { wharfSessionPid } from './wharf-session-pid.js';
import { detectHarness } from './harness-detect.js';
type Scope = Extract<BackendScope, { kind: 'wharf' }>;
type Options = { opt: (flag: string) => string | undefined; has: (flag: string) => boolean };
export const brokerBody = (a: BrokerAgent) => ({ grounds: a.grounds, session: a.session, capability: a.capability });
export async function endBrokerAgent(a: BrokerAgent) {
  try { await brokerRequest('end', brokerBody(a)); }
  finally {
    forgetBrokerAgent(a.grounds); forgetBrokerAgent(a.grounds, a.worktree);
    if (a.origin) forgetBrokerAgent(a.grounds, a.origin);
  }
}
export async function waitBrokerAgent(a: BrokerAgent, seconds: number): Promise<BrokerPoll> {
  const deadline = seconds ? Date.now() + seconds * 1000 : Infinity;
  do {
    const p = await brokerRequest<BrokerPoll>('poll', brokerBody(a));
    if (p.claim || p.messages?.length || Date.now() >= deadline) return p;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return { claim: null };
}
/** Every live hosted trap signs on and gets work through the boat daemon. */
export async function wharfSoak(scope: Scope, opts: Options): Promise<void> {
  let a = readBrokerAgent(scope.grounds);
  const session = resolveSessionId({ flag: opts.opt('--session') })?.id ?? a?.session;
  if (!session) throw new Error('wharf soak needs --session <harness-session-id>; the SessionStart hook prints it');
  if (a && a.session !== session) throw new Error('another hosted session owns this worktree; stow it first');
  const repo = opts.opt('--repo') ?? process.env.LOBSTAH_WHARF_REPO ?? a?.repo;
  if (!repo) throw new Error('wharf soak requires --repo <configured-repo>');
  if (a && a.repo !== repo) throw new Error('the signed-on trap belongs to a different repo');
  const seconds = opts.has('--wait') ? Number(opts.opt('--timeout') ?? 600) : 0;
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('timeout must be nonnegative seconds');
  if (!a) {
    const harness = detectHarness({ flag: opts.opt('--harness'), sessionId: session });
    if (!harness.harness) throw new Error(`${harness.reason}; use --harness claude|codex`);
    const supplied = opts.opt('--ticket');
    const t = supplied ? { ticket: supplied, trap: process.env.LOBSTAH_WHARF_TRAP,
      request: process.env.LOBSTAH_WHARF_REQUEST, repo, grounds: scope.grounds }
      : await brokerRequest<Record<string, unknown>>('ticket', { grounds: scope.grounds, repo, cwd: process.cwd() });
    a = await brokerRequest<BrokerAgent>('sign-on', { ...t, session, pid: wharfSessionPid(), harness: harness.harness });
    saveBrokerAgent(a); saveBrokerAgent(a, a.worktree);
  }
  if (path.resolve(process.cwd()) !== path.resolve(a.worktree)) {
    console.log(JSON.stringify({ trap: a.trap, grounds: a.grounds, worktree: a.worktree,
      instruction: `cd ${a.worktree}, then lobstah soak --grounds ${a.grounds} --wait` }, null, 2)); return;
  }
  const p = opts.has('--wait') ? await waitBrokerAgent(a, seconds) : await brokerRequest<BrokerPoll>('poll', brokerBody(a));
  console.log(JSON.stringify({ trap: a.trap, grounds: a.grounds, worktree: a.worktree, ...p,
    ...(p.claim ? { instruction: `Branch first in this worktree, then report ${p.claim.dispatch.id} working. The daemon owns claim/renew; your session uses only this dispatch's token.` }
      : p.messages?.length ? { instruction: 'Read these inbox messages and receipt them explicitly with lobstah wharf receipt.' } : { timeout: opts.has('--wait') }) }, null, 2));
  if (!p.claim && !p.messages?.length && opts.has('--wait')) process.exitCode = 3;
}
