import {
  groundsList,
  displayGrounds,
  heartbeatHelm,
  helmLabel,
  helmOf,
  liveHelms,
  loadConfig,
  trapBySession,
  trapLabel,
  TITLE_REMINDERS,
  type Grounds,
  type HelmRegistration,
} from '@lobstah/core';
import { charter } from './charter.js';
import { inspectSoakSite } from './soak-site.js';
import { buildTendReport } from './tend.js';
import { glassPort, glassUrl, probeGlass } from './glass-lifecycle.js';

const SOAK_WHERE = '(in a linked worktree; from a primary checkout it creates one)';

/**
 * The sign-on offer for a session that holds no helm and is not soaking:
 * the two copy-paste commands with the id filled in. With a live helm on
 * the session's grounds, taking it is displacement, so only the deliberate
 * `--take` path is offered, labelled as such. At most four lines.
 */
export function signOnHelp(sessionId: string, opts: { holder?: HelmRegistration; groundsFlag?: string } = {}): string {
  const soak = `to work as a trap:   lobstah soak --session ${sessionId}     ${SOAK_WHERE}`;
  const cfg = loadConfig();
  const g = opts.groundsFlag ? ` --grounds ${displayGrounds(opts.groundsFlag, cfg)}` : '';
  if (opts.holder) {
    return [
      `the helm for grounds "${displayGrounds(opts.holder.grounds, cfg)}" is held by ${helmLabel(opts.holder)} (session ${opts.holder.sessionId.slice(0, 8)}).`,
      soak,
      `to displace it deliberately:   lobstah man helm --take --session ${sessionId}${g}`,
    ].join('\n');
  }
  return [`to take the helm:    lobstah man helm --session ${sessionId}${g}`, soak].join('\n');
}

/**
 * Which grounds a fresh session belongs to: the only one configured, else
 * the one owning the repo its cwd sits in. Undefined when ambiguous — the
 * helm line then names the choices as a --grounds placeholder.
 */
function sessionGrounds(cwd: string | undefined): { grounds?: Grounds; placeholder?: string } {
  const cfg = loadConfig();
  const all = groundsList(cfg);
  if (all.length === 1) return { grounds: all[0] };
  const repoKey = cwd ? inspectSoakSite(cwd, cfg.repos)?.repoKey : undefined;
  const owned = repoKey !== undefined ? all.find((g) => g.repos.includes(repoKey)) : undefined;
  if (owned) return { grounds: owned };
  return { placeholder: `<${all.map((g) => g.name).join('|')}>` };
}

/**
 * The SessionStart brief's additionalContext: the session id, a one-line
 * fleet state, and what this session is — a helm (charter re-injected, so
 * the persona survives restarts and compaction; the start counts as a
 * heartbeat), a trap, or neither (offered the two sign-ons).
 */
/** The reminder SessionStart and Stop give a trap that has not confirmed its sign-on title. */
export function titleReminder(title: string, last = false): string {
  return (
    `lobstah: sign-on is not complete. Apply this title: ${title} (skip this if you have no tool that sets the session title). ` +
    `Then run \`lobstah soak title-set\`.` +
    (last ? ' This is the last reminder: if the command cannot run here, carry on; lobstah stops asking.' : '')
  );
}

export async function buildBriefContext(sessionId: string, cwd?: string): Promise<string> {
  let fleet = '';
  let glass = '';
  try {
    const r = buildTendReport();
    const waiting = r.attention.filter((a) => a.kind === 'question' || a.kind === 'watch').length;
    const toLook = r.attention.length - waiting;
    fleet =
      ` Fleet: ${r.verdict} (${r.counts.queued} queued, ${r.counts.active} active` +
      (waiting > 0 ? `, ${waiting} awaiting a human` : '') +
      (toLook > 0 ? `, ${toLook} to look at` : '') +
      ') — `lobstah` for the live view.';
  } catch {
    // a brief must never fail the session start
  }
  try {
    const port = glassPort();
    if (await probeGlass(port)) glass = ` Glass: ${glassUrl(port)}.`;
  } catch {
    // a brief must never fail the session start
  }
  fleet += glass;
  const helmReg = helmOf(sessionId);
  if (helmReg) {
    heartbeatHelm(helmReg.sessionId);
    return (
      `lobstah: session id ${sessionId} — you hold the helm for grounds "${displayGrounds(helmReg.grounds, loadConfig())}" ` +
      `(\`lobstah man relieve --session ${sessionId}\` steps down).${fleet}\n\n` +
      charter({ name: helmReg.grounds, repos: helmReg.repos })
    );
  }
  const workerTrap = trapBySession(sessionId);
  if (workerTrap) {
    const title =
      workerTrap.titlePending && (workerTrap.titleReminders ?? 0) < TITLE_REMINDERS ? `\n${titleReminder(workerTrap.titlePending)}` : '';
    return `lobstah: session id ${sessionId} — this session mans trap ${trapLabel(workerTrap)} (it takes assigned work at turn end) and works in ${workerTrap.worktree}; \`lobstah stow\` signs it off.${fleet}${title}`;
  }
  let help: string;
  try {
    const { grounds, placeholder } = sessionGrounds(cwd);
    const holder = grounds
      ? liveHelms(loadConfig().helm.ttlSecs * 1000).find((h) => h.grounds === grounds.name)
      : undefined;
    help = signOnHelp(sessionId, { holder, groundsFlag: placeholder });
  } catch {
    help = signOnHelp(sessionId);
  }
  return `lobstah: session id ${sessionId}.${fleet}\n\n${help}`;
}
