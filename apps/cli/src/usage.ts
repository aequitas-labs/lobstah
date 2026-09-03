/**
 * Concise per-command usage (axi.md P10): `lobstah <cmd> --help` prints just
 * this entry — the fallback when contextual `help[]` hints aren't enough.
 * Keys are post-alias command names; `man <sub>` maps to `man:<sub>`.
 */
export const USAGE: Record<string, string> = {
  dispatch: `lobstah dispatch --repo <key> (--brief <file> | --brief-text <text>)
  [--harness claude|codex] [--model <m>] [--effort <e>] [--follow-up <uuid>]
  [--for session:<id>] [--chore] [--id <uuid>]
Queue a supervised dispatch; prints the id. --for addresses the bait to a
soaking session instead of a fresh headless worker. Alias: set --bait.`,
  ls: `lobstah ls [--all]
Queue, active, and recent done dispatches (--all includes chores). Alias: buoys.`,
  status: `lobstah status [<uuid>]
Reconciled state for one dispatch, or all active without an id. Alias: buoy.`,
  logs: `lobstah logs <uuid> [--follow]
The dispatch's normalized event stream; --follow tails it.`,
  send: `lobstah send <uuid> <message>
Deliver an instruction to a running dispatch between its turns.`,
  inbox: `lobstah inbox <uuid>
Read and acknowledge pending messages (workers: check at natural checkpoints).`,
  attach: `lobstah attach <uuid> [--print] [--force]
Open the dispatch's own harness session in its worktree. Refused while
working unless --force; --print shows the command instead of running it.`,
  swap: `lobstah swap <uuid> [--harness claude|codex] [--model <m>] [--effort <e>]
Hand an active dispatch to a fresh session — same worktree and brief plus a
git progress note.`,
  catch: `lobstah catch <uuid>
The evidence: branch, commits, PR, session.`,
  cull: `lobstah cull [--older-than <days>] [--apply]
Sweep aged done entries, orphaned worktrees, and stale state. Dry run
without --apply (default 14 days).`,
  cancel: `lobstah cancel <uuid>
Request cancellation; the daemon (or the claiming session) winds it down.`,
  report: `lobstah report <uuid> <verb> [note] [--pr <url>]
The validated status write path: working | needs-decision | blocked |
paused | done | failed.`,
  watch: `lobstah watch [add <key> --check <cmd> [--for <uuid>] [--cursor <c>]
  [--every <s>] [--brief <template>] [--stream <cmd>] | rm <key>]
Stand watch on something external; bare \`watch\` lists. The check command
answers "anything since {cursor}?" in JSON.`,
  soak: `lobstah soak --session <id> [--one] [--harness claude|codex]
Volunteer this session as a worker: it parks at turn end and takes matching
bait. Refused from a primary checkout — soak from a worktree. --one stows
after the first catch.`,
  stow: `lobstah stow [--session <id>] [--quiet]
Sign a soaking session off; an open catch goes back to the queue.`,
  daemon: `lobstah daemon [--interval <ms>] | daemon install|uninstall
The supervisor process (claims, worktrees, liveness, restarts). install
writes + loads a launchd agent / systemd user unit.`,
  pick: `lobstah pick [once] | pick install|uninstall
Tracker loops: poll Linear/GitHub, dispatch assigned work, report back,
reconcile, merge.`,
  doctor: `lobstah doctor
Check binaries, config, repos, harnesses, and the daemon heartbeat; exit 1
on failures.`,
  repos: `lobstah repos [add <path> [--pickup] [--key <k>]]
List configured repos, or detect one and append its [repos.*] block.`,
  init: `lobstah init [--scan <dir>... [--pickup]]
Create ~/.lobstah + config; --scan appends a [repos.*] block per repo found.`,
  version: `lobstah version
The installed lobstah version.`,
  'man:tend': `lobstah man tend [--json]
The whole-fleet pass: verdict, unanswered questions, each work item's chain,
PR, and merge gate. Pure disk read.`,
  'man:wait': `lobstah man wait [--timeout <secs>] [--peek]
Block until a dispatch or watched source needs attention; exit 2 on timeout.
--peek surfaces standing events without consuming them.`,
  'man:init': `lobstah man init [--shared|--global] [--marker]
Install the haul Stop hook into Claude settings; --marker touches
.lobstah-man to arm this directory.`,
  'man:haul': `lobstah man haul [--timeout <secs>]
Stop-hook entry point: park the session while work is in flight (lobsterman
or soaking worker); prints hook-decision JSON on an event.`,
  'man:brief': `lobstah man brief
SessionStart-hook entry point: announce the session id and fleet state into
the conversation.`,
};

/** The usage entry for a resolved command, if one exists. */
export function usageFor(cmd: string): string | undefined {
  return USAGE[cmd];
}
