#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acknowledge,
  addWatch,
  appendStatus,
  baitBrief,
  cancelRequested,
  claimBait,
  codexInvocation,
  hasOpenCatch,
  heartbeatSoak,
  listSoaking,
  readSoak,
  releaseCatch,
  signOnSoak,
  stowSoak,
  listWatches,
  pendingWatchEvents,
  readWatchEvents,
  readEvidence,
  removeWatch,
  runWatchCheck,
  watchDue,
  loadConfig,
  lobstahHome,
  lobstahVersion,
  mergeEvidence,
  unhandled,
  configPath,
  enqueue,
  ensureLayout,
  eventsPath,
  laneDirs,
  lastEventAt,
  readStatusLog,
  reconcile,
  requestCancel,
  sendMessage,
  toonHelp,
  toonKV,
  toonTable,
  VERBS,
} from '@lobstah/core';
import type { Descriptor, Lane, WatchAttention } from '@lobstah/core';
import { attentionNow, captureWaitBaseline, daemon, freshWakeEvents, killGroup, pidAlive } from '@lobstah/supervisor';
import { runPickup } from '@lobstah/pick';
import { mergeHaulHook } from './hooks.js';
import { buildTendReport, renderTend } from './tend.js';
import { applyCull, planCull } from './cull.js';
import { MANUAL } from './manual.js';
import { runDoctor } from './doctor.js';
import { installService, uninstallService } from './service.js';
import { appendRepoBlock, configuredRepoKeys, detectRepo, scanForRepos } from './repos.js';
import { parseReportArgs } from './report-args.js';
import { inspectSoakSite, readHookStdin } from './soak-site.js';
import { UsageError, usageFor, validateArgs } from './usage.js';

const HELP = `lobstah — supervision framework for coding agents

work (humans and agents):
  dispatch --repo <key> (--brief <file> | --brief-text <text>)   (alias: set --bait)
           [--harness claude|codex] [--model <m>] [--effort <e>]
           [--follow-up <uuid>] [--for session:<id>] [--chore] [--id <uuid>]
                                  queue a supervised dispatch; prints the id.
                                  --for addresses the bait to a soaking
                                  session instead of a fresh headless worker
  ls [--all]                      queue, active, recent done      (alias: buoys)
  status [<uuid>]                 reconciled state                (alias: buoy)
  logs <uuid> [--follow|--full]   the normalized event stream (last 50 events
                                  by default; --full for everything)
  send <uuid> <message>           deliver an instruction between agent turns
  inbox <uuid>                    read and acknowledge pending messages
                                  (workers: check at natural checkpoints)
  attach <uuid> [--print] [--force]
                                  open the dispatch's own harness session in
                                  its worktree (claude --resume / codex resume)
  swap <uuid> [--harness claude|codex] [--model <m>] [--effort <e>]
                                  hand an active dispatch to a fresh session —
                                  same worktree and brief plus a git progress
                                  note; conversations don't cross harnesses
  catch <uuid>                    the evidence: branch, commits, PR, session
  cull [--older-than <days>] [--apply]
                                  sweep aged catch and lost gear — old done/
                                  entries, orphaned worktrees, stale state.
                                  Dry run by default (14 days).
  cancel <uuid>                   request cancellation
  watch [add <key> --check <cmd> [--for <uuid>] [--cursor <c>] [--every <s>]
        [--brief <template>] [--stream <cmd>] | rm <key>]
                                  stand watch on something external: the check
                                  command answers "anything since {cursor}?"
                                  in JSON. Events wake man wait/haul (default)
                                  or fork a continuation of --for's dispatch
                                  chain. --stream holds a long-lived NDJSON
                                  child under pick for ms-latency delivery
                                  (the check stays the guarantee). Bare
                                  \`watch\` lists.

host processes:
  daemon [--interval <ms>]        the supervisor: claims, worktrees, liveness,
                                  restart ladder, notifyCommand. One per home.
  pick [once]                     tracker loops: poll Linear/GitHub, dispatch
                                  assigned work, report back, reconcile, merge
  daemon install|uninstall        write + load the launchd agent / systemd user
  pick install|uninstall          unit for this host, with resolved node and
                                  lobstah paths (launchd gets no shell env)

lobsterman (orchestrator sessions — bare \`lobstah man\` prints the manual):
  man tend [--json]               tend the whole string: fleet verdict (daemon
                                  up, stalled vs idle), unanswered questions
                                  with ages, each work item's dispatch chain,
                                  PR, and merge-gate status from pick's last
                                  observation. Pure disk read — no forge calls.
  man wait [--timeout <secs>] [--peek]
                                  block until a dispatch or watched source
                                  needs attention, then print the event and
                                  what to do next; exit 3 on timeout. Runs due
                                  watch checks itself when no pick process is.
                                  Unanswered questions re-fire every
                                  remindSecs until answered.
  man init [--shared|--global] [--marker]
                                  install the haul Stop hook: this project's
                                  .claude/settings.local.json by default,
                                  settings.json with --shared, or once into
                                  ~/.claude/settings.json with --global (any
                                  directory with a .lobstah-man file then
                                  parks); --marker touches .lobstah-man.
  man haul [--timeout <secs>]     Stop-hook entry point: park the session while
                                  work is in flight; prints hook-decision JSON
                                  on an event, silent exit 0 otherwise. Gate:
                                  LOBSTAH_MAN=1 or a .lobstah-man file.

workers (dispatched agents; injected into every brief):
  report <uuid> <verb> [note] [--pr <url>]
                                  the validated status write path
                                  (${VERBS.join(' | ')})

soaking (interactive sessions volunteering as workers):
  soak --session <id> [--one] [--harness claude|codex]
                                  put this session in the water: it parks at
                                  turn end and takes matching bait from the
                                  work queue. Refused from a primary checkout
                                  — soak from a worktree. --one stows after
                                  the first catch. The session id comes from
                                  the plugin's session-start brief.
  stow [--session <id>] [--quiet] take the trap out: sign the session off; an
                                  open catch goes back to the queue. A stale
                                  registration (ghost trap) is swept
                                  automatically after [soak].ttlSecs.

setup:
  init [--scan <dir>... [--pickup]]
                                  create ~/.lobstah + example config; --scan
                                  detects git repos under the given roots and
                                  appends a [repos.*] block per repo (--pickup
                                  marks them pickable by [pickup.github])
  repos [add <path> [--pickup] [--key <k>]]
                                  list configured repos, or detect + append one
  doctor                          check binaries, config, repos, harnesses, and
                                  the daemon heartbeat; exit 1 on failures
  version | --version             the installed lobstah version

Everything except daemon and pick works with both stopped: writes are files,
reads are files. Output is TOON; agents can drive this CLI directly.
Home: $LOBSTAH_HOME (default ~/.lobstah) — one daemon per home, enforced.`;

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Inline watch cadence when no pick process is stamping checks; pick's own
// cadence is [pickup].pollSecs. Whoever polls first stamps lastCheckedAt, so
// the two never double-poll a watch inside one window.
const WATCH_EVERY_SECS = 45;

/**
 * The soak side of the Stop-hook park: heartbeat, then wait for something to
 * act on. An idle trap waits for bait; a trap with an open catch waits for a
 * cancel or a `lobstah send` message about it. Both wake with hook-decision
 * JSON; a timeout allows the stop silently — the next turn end re-parks.
 */
async function soakPark(sessionId: string, args: string[]): Promise<void> {
  const timeoutSecs = Number(arg(args, '--timeout') ?? '14000');
  const deadline = Date.now() + timeoutSecs * 1000;
  const block = (reason: string) => console.log(JSON.stringify({ decision: 'block', reason }));
  while (true) {
    const reg = heartbeatSoak(sessionId);
    if (!reg) return; // stowed while parked
    if (hasOpenCatch(reg)) {
      const id = reg.claimed!;
      if (cancelRequested(id, 'work')) {
        block(
          `Your catch ${id} was cancelled. Stop working it, leave the worktree as it is, ` +
            `and run \`lobstah report ${id} failed "cancelled by request"\`.`,
        );
        return;
      }
      if (unhandled(id, 'work').length > 0) {
        block(`New instruction for your catch ${id} — read it with \`lobstah inbox ${id}\`, act on it, and keep reporting.`);
        return;
      }
    } else {
      if (reg.one && reg.claimed) {
        stowSoak(sessionId);
        return; // one catch was the deal — the trap comes out of the water
      }
      const caught = claimBait(reg);
      if (caught) {
        block(baitBrief(caught.id, caught.descriptor));
        return;
      }
    }
    if (Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function runDueManWatches(): void {
  for (const w of listWatches()) {
    if (w.owner === 'man' && watchDue(w, WATCH_EVERY_SECS)) runWatchCheck(w);
  }
}

function emitWatchAttention(attns: WatchAttention[]): void {
  for (const a of attns) {
    for (const e of a.events) {
      console.log(toonKV({ watch: a.watch.key, seq: e.seq, summary: e.summary }));
    }
  }
  console.log(
    'next: handle the watched update now (a review round, a finished run — `lobstah watch ls` for context), then re-arm a background `lobstah man wait`.',
  );
}

function findLane(id: string): Lane {
  for (const lane of ['work', 'chore'] as Lane[]) {
    const d = laneDirs(lane);
    if (
      fs.existsSync(path.join(d.active, id)) ||
      fs.existsSync(path.join(d.queue, `${id}.json`)) ||
      fs.existsSync(path.join(d.done, id)) ||
      fs.existsSync(path.join(d.state, `${id}.status`))
    ) {
      return lane;
    }
  }
  throw new Error(`unknown dispatch ${id}`);
}

function rowsFor(lane: Lane, bucket: 'queue' | 'active' | 'done'): Array<Record<string, unknown>> {
  const dir = laneDirs(lane)[bucket];
  const entries = fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const sliced = bucket === 'done' ? entries.slice(0, 10) : entries;
  return sliced.map(({ f, m }) => {
    const id = f.replace(/\.json$/, '');
    const state = reconcile({ log: readStatusLog(id, lane), lastEventAt: lastEventAt(id, lane) });
    return { id, lane, bucket, state, updated: new Date(m).toISOString() };
  });
}

async function mainCli(): Promise<void> {
  let [cmd, ...args] = process.argv.slice(2);
  const ALIASES: Record<string, string> = { set: 'dispatch', buoys: 'ls', buoy: 'status' };
  cmd = cmd !== undefined ? (ALIASES[cmd] ?? cmd) : cmd;
  // Lobsterman (orchestrator) commands live under their own namespace;
  // bare `lobstah man` prints the lobsterman's manual.
  if (cmd === 'man') {
    cmd = args.length > 0 && args[0] !== '--help' ? `man:${args[0]}` : 'man:manual';
    args = args.slice(1);
  }
  ensureLayout();

  // Registry validation (axi.md P6/P10): unknown flags and subverbs fail
  // loudly with the usage card (exit 2); `--help` prints it. Validation
  // stops at a command's free-text tail, so a note or message may contain
  // anything — including the literal strings above.
  if (cmd !== undefined) {
    const v = validateArgs(cmd, args);
    if (v?.help) {
      console.log(usageFor(cmd)!);
      return;
    }
    if (v?.error) throw new UsageError(`${v.error}\n\n${usageFor(cmd)!}`);
  }

  switch (cmd) {
    case 'dispatch': {
      const repo = arg(args, '--repo');
      const briefFile = arg(args, '--brief') ?? arg(args, '--bait');
      const briefText = arg(args, '--brief-text');
      if (!repo || (!briefFile && !briefText)) {
        throw new Error('dispatch requires --repo and --brief <file> (or --brief-text)');
      }
      const address = arg(args, '--for');
      if (address && !address.startsWith('session:')) {
        throw new Error('dispatch --for takes a session address: --for session:<id>');
      }
      const d: Descriptor = {
        id: arg(args, '--id') ?? randomUUID(),
        repo,
        brief: briefText ?? fs.readFileSync(briefFile!, 'utf8'),
        harness: arg(args, '--harness'),
        model: arg(args, '--model'),
        effort: arg(args, '--effort'),
        followUp: arg(args, '--follow-up'),
        for: address,
      };
      const lane: Lane = args.includes('--chore') ? 'chore' : 'work';
      enqueue(d, lane);
      console.log(toonKV({ id: d.id, repo, lane, queued: new Date().toISOString() }));
      console.log(
        toonHelp([
          `lobstah status ${d.id}`,
          `lobstah send ${d.id} "<instruction>"`,
          'lobstah man wait   (block until something needs you)',
        ]),
      );
      break;
    }
    case 'ls': {
      const lanes: Lane[] = args.includes('--all') ? ['work', 'chore'] : ['work'];
      const rows = lanes.flatMap((lane) =>
        (['queue', 'active', 'done'] as const).flatMap((b) => rowsFor(lane, b)),
      );
      console.log(toonTable('dispatches', rows, ['id', 'lane', 'bucket', 'state', 'updated']));
      console.log(toonHelp(['lobstah status <id>', 'lobstah man tend   (verdict + stories + gates)']));
      break;
    }
    case 'status': {
      const id = args[0];
      if (!id) {
        const rows = (['work', 'chore'] as Lane[]).flatMap((lane) => rowsFor(lane, 'active'));
        console.log(toonTable('active', rows, ['id', 'lane', 'state', 'updated']));
        break;
      }
      const lane = findLane(id);
      const log = readStatusLog(id, lane);
      const state = reconcile({ log, lastEventAt: lastEventAt(id, lane) });
      console.log(toonKV({ id, lane, state, lastNote: log.at(-1)?.note, entries: log.length }));
      console.log(
        toonHelp(
          state === 'needs-decision' || state === 'blocked'
            ? [`lobstah send ${id} "<answer>"`, `lobstah logs ${id} --follow`]
            : state === 'done' || state === 'failed'
              ? [`lobstah catch ${id}   (branch, commits, PR)`]
              : [`lobstah logs ${id} --follow`, `lobstah send ${id} "<instruction>"`],
        ),
      );
      break;
    }
    case 'logs': {
      const id = args[0];
      if (!id) throw new Error('logs requires a dispatch id');
      const lane = findLane(id);
      const file = eventsPath(id, lane);
      if (fs.existsSync(file)) {
        // Truncate by default (axi.md P3) — a long-running dispatch's stream
        // can be huge, and the reader is usually an agent on a token budget.
        const raw = fs.readFileSync(file, 'utf8');
        const lines = raw.split('\n').filter((l) => l.length > 0);
        const LIMIT = 50;
        if (!args.includes('--full') && lines.length > LIMIT) {
          console.log(
            `(truncated: last ${LIMIT} of ${lines.length} events — \`lobstah logs ${id} --full\` for all)`,
          );
          for (const l of lines.slice(-LIMIT)) console.log(l);
        } else {
          process.stdout.write(raw);
        }
      }
      if (args.includes('--follow')) {
        let size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        setInterval(() => {
          if (!fs.existsSync(file)) return;
          const now = fs.statSync(file).size;
          if (now > size) {
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(now - size);
            fs.readSync(fd, buf, 0, buf.length, size);
            fs.closeSync(fd);
            process.stdout.write(buf.toString('utf8'));
            size = now;
          }
        }, 1000);
        await new Promise(() => {});
      }
      break;
    }
    case 'send': {
      const [id, ...rest] = args;
      if (!id || rest.length === 0) throw new Error('send requires an id and a message');
      const name = sendMessage(id, findLane(id), rest.join(' '));
      console.log(toonKV({ id, queued: name }));
      break;
    }
    case 'report': {
      const [id, verb, ...rest] = args;
      if (!id || !verb) throw new Error(`report requires an id and a verb (${VERBS.join('|')})`);
      const lane = findLane(id);
      const { note, prUrl } = parseReportArgs(rest);
      const entry = appendStatus(id, lane, verb, note);
      if (prUrl) mergeEvidence(id, lane, { prUrl });
      console.log(toonKV({ id, verb: entry.verb, at: entry.at, ...(prUrl ? { prUrl } : {}) }));
      break;
    }
    case 'inbox': {
      const id = args[0];
      if (!id) throw new Error('inbox requires a dispatch id');
      const lane = findLane(id);
      const msgs = unhandled(id, lane);
      if (msgs.length === 0) {
        console.log(toonKV({ id, inbox: 'empty' }));
        break;
      }
      for (const m of msgs) {
        console.log(`--- message ${m.file}`);
        console.log(m.text);
        acknowledge(id, lane, m.file);
      }
      break;
    }
    case 'attach': {
      const id = args[0];
      if (!id) throw new Error('attach requires a dispatch id');
      const lane = findLane(id);
      const state = reconcile({ log: readStatusLog(id, lane), lastEventAt: lastEventAt(id, lane) });
      if (state === 'working' && !args.includes('--force')) {
        throw new Error(
          `${id} is still working — attaching would put two writers on one session. ` +
            `Follow it with \`lobstah logs ${id} --follow\`, steer it with \`lobstah send\`, ` +
            `or pass --force after cancelling.`,
        );
      }
      const dirs = laneDirs(lane);
      const descriptorFile = ['active', 'done']
        .map((b) => path.join(dirs[b as 'active' | 'done'], id, 'descriptor.json'))
        .find((f) => fs.existsSync(f));
      const harness = descriptorFile
        ? ((JSON.parse(fs.readFileSync(descriptorFile, 'utf8')) as Descriptor).harness ?? 'claude')
        : 'claude';
      let sessionId: string | undefined;
      try {
        sessionId = (
          JSON.parse(fs.readFileSync(path.join(dirs.state, `${id}.evidence`), 'utf8')) as { sessionId?: string }
        ).sessionId;
      } catch {
        // no evidence yet
      }
      if (!sessionId) throw new Error(`${id} has no recorded harness session to attach to`);
      const worktree = path.join(lobstahHome(), 'worktrees', id);
      const cwd = fs.existsSync(worktree) ? worktree : process.cwd();
      // codex may exist only as the SDK's vendored CLI, never on PATH.
      const invocation =
        harness === 'codex' ? codexInvocation(['resume', sessionId]) : { file: 'claude', argv: ['--resume', sessionId] };
      if (!invocation) throw new Error('no codex CLI found — neither on PATH nor vendored by @openai/codex-sdk');
      if (args.includes('--print')) {
        console.log(toonKV({ id, harness, sessionId, cwd, command: `${invocation.file} ${invocation.argv.join(' ')}` }));
        break;
      }
      const res = spawnSync(invocation.file, invocation.argv, { cwd, stdio: 'inherit' });
      if (res.error) throw new Error(`could not launch ${invocation.file}: ${res.error.message}`);
      break;
    }
    case 'swap': {
      const id = args[0];
      if (!id) throw new Error('swap requires a dispatch id');
      const lane = findLane(id);
      const activeDir = path.join(laneDirs(lane).active, id);
      if (!fs.existsSync(activeDir)) throw new Error(`${id} is not active — swap only applies to in-flight dispatches`);

      const descFile = path.join(activeDir, 'descriptor.json');
      const descriptor = JSON.parse(fs.readFileSync(descFile, 'utf8')) as Descriptor;
      const fromHarness = descriptor.harness ?? 'default';
      for (const key of ['harness', 'model', 'effort'] as const) {
        const v = arg(args, `--${key}`);
        if (v) descriptor[key] = v;
      }
      fs.writeFileSync(descFile, JSON.stringify(descriptor, null, 2));

      // Progress note: the conversation cannot cross harnesses, so the next
      // incarnation gets brief + committed state + working-tree status.
      const worktree = path.join(lobstahHome(), 'worktrees', id);
      let progress = 'No worktree progress recorded.';
      if (fs.existsSync(worktree)) {
        const git = (...a: string[]) => spawnSync('git', a, { cwd: worktree, encoding: 'utf8' }).stdout?.trim() ?? '';
        const commits = git('log', '--oneline', '-15');
        const status = git('status', '--short');
        progress = `Commits so far:
${commits || '(none)'}

Uncommitted changes:
${status || '(clean)'}`;
      }
      fs.writeFileSync(
        path.join(activeDir, 'handoff'),
        `You are taking over this dispatch from a previous agent session (harness: ${fromHarness}). ` +
          `Its conversation is not available — the worktree state below is the ground truth. ` +
          `Review it, then continue the brief from where it stops.

${progress}`,
      );

      // Kill the old incarnation and clear runner state; the daemon observes
      // an unclaimed active dispatch and spawns fresh with the handoff note.
      const runnerFile = path.join(activeDir, 'runner.json');
      if (fs.existsSync(runnerFile)) {
        const runner = JSON.parse(fs.readFileSync(runnerFile, 'utf8')) as { pid: number; processStartTime?: string };
        if (pidAlive(runner.pid, runner.processStartTime)) killGroup(runner.pid, 'SIGKILL');
        fs.unlinkSync(runnerFile);
      }
      appendStatus(id, lane, 'working', `swapped to ${descriptor.harness ?? 'default'} — awaiting respawn`);
      console.log(toonKV({ id, harness: descriptor.harness ?? 'default', model: descriptor.model, swapped: true }));
      break;
    }
    case 'catch': {
      const id = args[0];
      if (!id) throw new Error('catch requires a dispatch id');
      const lane = findLane(id);
      const log = readStatusLog(id, lane);
      const ev = readEvidence(id, lane);
      console.log(
        toonKV({
          id,
          state: reconcile({ log, lastEventAt: lastEventAt(id, lane) }),
          branch: ev.branch,
          prUrl: ev.prUrl,
          sessionId: ev.sessionId,
          note: log.at(-1)?.note,
        }),
      );
      if (ev.commits?.length) {
        console.log(`commits[${ev.commits.length}]:`);
        for (const c of ev.commits) console.log(`  ${c}`);
      }
      break;
    }
    case 'cull': {
      const days = Number(arg(args, '--older-than') ?? '14');
      const plan = planCull(days);
      console.log(
        toonTable(
          'cull',
          plan.map((i) => ({ kind: i.kind, id: i.id, ageDays: i.ageDays })),
          ['kind', 'id', 'ageDays'],
        ),
      );
      if (plan.length === 0) break;
      if (args.includes('--apply')) {
        applyCull(plan);
        console.log(`applied: ${plan.length} removed`);
      } else {
        console.log('dry run — pass --apply to remove');
      }
      break;
    }
    case 'man:manual': {
      console.log(MANUAL);
      break;
    }
    case 'man:tend': {
      const report = buildTendReport();
      console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderTend(report));
      break;
    }
    case 'cancel': {
      const id = args[0];
      if (!id) throw new Error('cancel requires a dispatch id');
      requestCancel(id, findLane(id));
      console.log(toonKV({ id, cancel: 'requested' }));
      break;
    }
    case 'man:wait': {
      const timeoutSecs = Number(arg(args, '--timeout') ?? '0');
      const deadline = timeoutSecs > 0 ? Date.now() + timeoutSecs * 1000 : Number.POSITIVE_INFINITY;
      const emit = (evs: ReturnType<typeof attentionNow>) => {
        for (const e of evs) {
          console.log(toonKV({ id: e.id, lane: e.lane, verb: e.entry.verb, note: e.entry.note, at: e.entry.at }));
        }
        const ev = evs[0]!;
        console.log(
          `next: run \`lobstah status ${ev.id}\` for full state` +
            (ev.entry.verb === 'needs-decision' || ev.entry.verb === 'blocked'
              ? `, answer with \`lobstah send ${ev.id} "<answer>"\``
              : ', collect the evidence and report the outcome') +
            ', then re-arm a background `lobstah man wait`.',
        );
      };
      const remindMs = (loadConfig().remindSecs ?? 900) * 1000;
      const consume = !args.includes('--peek');
      runDueManWatches();
      const standing = attentionNow(consume, remindMs);
      const standingWatches = pendingWatchEvents(consume);
      if (standing.length > 0 || standingWatches.length > 0) {
        if (standing.length > 0) emit(standing);
        if (standingWatches.length > 0) emitWatchAttention(standingWatches);
        break;
      }
      const baseline = captureWaitBaseline();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const fresh = freshWakeEvents(baseline);
        if (fresh.length > 0) {
          emit(fresh);
          return;
        }
        runDueManWatches(); // no pick running? this loop is the poller
        const watched = pendingWatchEvents(true);
        if (watched.length > 0) {
          emitWatchAttention(watched);
          return;
        }
      }
      console.log(toonKV({ timeout: true, waitedSecs: timeoutSecs }));
      process.exitCode = 3; // 2 means a usage mistake; timeout gets its own code
      break;
    }
    case 'man:init': {
      // --global installs once into the user's Claude settings; the haul hook
      // still gates per directory (marker file or LOBSTAH_MAN=1), so a global
      // install parks nothing until a project opts in.
      const file = args.includes('--global')
        ? path.join(os.homedir(), '.claude', 'settings.json')
        : path.join('.claude', args.includes('--shared') ? 'settings.json' : 'settings.local.json');
      let existing: unknown;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = undefined;
      }
      const { settings, changed } = mergeHaulHook(existing);
      if (changed) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
      }
      if (args.includes('--marker')) fs.writeFileSync('.lobstah-man', '');
      console.log(
        toonKV({
          hook: 'lobstah man haul',
          file,
          installed: changed || 'already present',
          gate: args.includes('--marker')
            ? '.lobstah-man (this directory)'
            : args.includes('--global')
              ? 'touch .lobstah-man in a project (or LOBSTAH_MAN=1) to arm it there'
              : 'launch with LOBSTAH_MAN=1 claude',
        }),
      );
      break;
    }
    case 'man:haul': {
      // Stop-hook entry point: everything non-actionable is a silent exit 0 —
      // a hook must never break the user's stop with noise. A session that is
      // soaking parks as a worker (waits for bait); otherwise the lobsterman
      // gate applies (marker file or env).
      try {
        const hook = readHookStdin();
        const soakReg = hook?.session_id ? readSoak(hook.session_id) : undefined;
        if (soakReg) {
          await soakPark(soakReg.sessionId, args);
          break;
        }
        if (process.env.LOBSTAH_MAN !== '1' && !fs.existsSync('.lobstah-man')) break;
        const anyActive = (['work', 'chore'] as Lane[]).some((l) =>
          fs.readdirSync(laneDirs(l).active).some((f) => !f.startsWith('.')),
        );
        // A registered session-owned watch is in-flight work too — a ume
        // review can be the only thing standing between this turn and done.
        const anyWatch = listWatches().some((w) => w.owner === 'man');
        if (!anyActive && !anyWatch) break; // nothing in flight — conversational turns end free
        const timeoutSecs = Number(arg(args, '--timeout') ?? '14000');
        const deadline = Date.now() + timeoutSecs * 1000;
        const remindMs = (loadConfig().remindSecs ?? 900) * 1000;
        runDueManWatches();
        let evs = attentionNow(true, remindMs);
        let watched = pendingWatchEvents(true);
        if (evs.length === 0 && watched.length === 0) {
          const baseline = captureWaitBaseline();
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            evs = freshWakeEvents(baseline);
            if (evs.length === 0) evs = attentionNow(true, remindMs); // reminders fire mid-park too
            runDueManWatches();
            watched = pendingWatchEvents(true);
            if (evs.length > 0 || watched.length > 0) break;
          }
        }
        if (evs.length === 0 && watched.length === 0) break; // timeout — allow the stop; tier 1 covers the horizon
        const lines = [
          ...evs.map((ev) => `- ${ev.entry.verb} ${ev.id}${ev.entry.note ? ` — ${ev.entry.note}` : ''}`),
          ...watched.flatMap((a) =>
            a.events.map((e) => `- watch ${a.watch.key}${e.summary ? ` — ${e.summary}` : ` (seq ${e.seq})`}`),
          ),
        ];
        const reason = [
          'A lobstah dispatch or watched source needs attention:',
          ...lines,
          'Check a dispatch with `lobstah status <id>`; answer a needs-decision with `lobstah send <id> "<answer>"`.',
          'A watch line means an external source updated (e.g. a review round) — handle it directly.',
          'Handle it now. This session re-parks automatically at turn end — do not arm any watcher.',
        ].join('\n');
        console.log(JSON.stringify({ decision: 'block', reason }));
      } catch {
        // never break a stop
      }
      break;
    }
    case 'man:brief': {
      // SessionStart-hook entry point: ambient context (axi.md P7) — the
      // session id plus a one-line fleet state, so every conversation starts
      // knowing where things stand. Silent without hook input.
      const hook = readHookStdin();
      if (!hook?.session_id) break;
      let fleet = '';
      try {
        const r = buildTendReport();
        fleet =
          ` Fleet: ${r.verdict} (${r.counts.queued} queued, ${r.counts.active} active` +
          (r.attention.length > 0 ? `, ${r.attention.length} awaiting a human` : '') +
          ') — `lobstah` for the live view.';
      } catch {
        // a brief must never fail the session start
      }
      const soaking = readSoak(hook.session_id) !== undefined;
      const context = soaking
        ? `lobstah: session id ${hook.session_id} — this session is soaking (a volunteered worker); \`lobstah stow --session ${hook.session_id}\` signs it off.${fleet}`
        : `lobstah: session id ${hook.session_id} (for \`lobstah soak|stow --session <id>\`).${fleet}`;
      console.log(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }),
      );
      break;
    }
    case 'soak': {
      const sessionId = arg(args, '--session');
      if (!sessionId) {
        throw new Error(
          'soak requires --session <id> — the harness session id, announced at session start ' +
            'by the lobstah plugin (`lobstah man brief`)',
        );
      }
      const cfg = loadConfig();
      const site = inspectSoakSite(process.cwd(), cfg.repos);
      if (!site) throw new Error('soak must run inside a git checkout — the trap is the worktree');
      if (site.primary) {
        throw new Error(
          'this is the repo\'s primary checkout — never claimable. Create a worktree ' +
            '(`git worktree add ../<name> -b <branch>`) and soak from there.',
        );
      }
      const rival = listSoaking().find((r) => r.sessionId !== sessionId && r.worktree === site.worktree);
      if (rival) {
        throw new Error(
          `session ${rival.sessionId.slice(0, 8)} already soaks this worktree — one trap per worktree. ` +
            `Stow it first (\`lobstah stow --session ${rival.sessionId}\`) or soak from another worktree.`,
        );
      }
      const reg = signOnSoak({
        sessionId,
        harness: arg(args, '--harness') ?? 'claude',
        repo: site.repoKey,
        worktree: site.worktree,
        cwd: process.cwd(),
        one: args.includes('--one') || undefined,
      });
      console.log(
        toonKV({
          soaking: sessionId,
          repo: reg.repo ?? '(none configured — addressed bait only)',
          worktree: reg.worktree,
          ...(reg.one ? { one: true } : {}),
          note: 'parks at turn end via the Stop hook (lobstah plugin or `man init --global`); bait arrives as a wake',
        }),
      );
      console.log(toonHelp([`lobstah stow --session ${sessionId}   (sign off)`]));
      break;
    }
    case 'stow': {
      const sessionId = arg(args, '--session') ?? readHookStdin()?.session_id;
      const quiet = args.includes('--quiet');
      if (!sessionId) {
        if (quiet) break;
        throw new Error('stow requires --session <id> (or hook input on stdin)');
      }
      const reg = stowSoak(sessionId);
      if (!reg) {
        if (!quiet) console.log(toonKV({ session: sessionId, soaking: false }));
        break;
      }
      const released = releaseCatch(reg);
      if (!quiet) {
        console.log(
          toonKV({
            stowed: sessionId,
            ...(released.requeued ? { requeued: released.requeued } : {}),
            ...(released.finalized ? { finalized: released.finalized } : {}),
          }),
        );
      }
      break;
    }
    case 'daemon':
    case 'pick': {
      const kind = cmd as 'daemon' | 'pick';
      if (args[0] === 'install') {
        const res = installService(kind);
        console.log(toonKV({ service: kind, file: res.file, loaded: res.loaded, detail: res.detail }));
        break;
      }
      if (args[0] === 'uninstall') {
        const res = uninstallService(kind);
        console.log(toonKV({ service: kind, file: res.file, removed: res.removed }));
        break;
      }
      if (kind === 'daemon') await daemon(Number(arg(args, '--interval') ?? '5000'));
      else await runPickup(args[0] === 'once' ? 'once' : 'daemon');
      break;
    }
    case 'doctor': {
      const rows = runDoctor();
      console.log(toonTable('doctor', rows as unknown as Array<Record<string, unknown>>, ['check', 'status', 'detail']));
      if (rows.some((r) => r.status === 'fail')) process.exitCode = 1;
      break;
    }
    case 'repos': {
      if (args[0] === 'add') {
        const target = args[1];
        if (!target) throw new Error('repos add requires a path');
        const detected = detectRepo(target);
        if (!detected) throw new Error(`${target} is not the root of a git repository`);
        const key = arg(args, '--key') ?? detected.key;
        if (configuredRepoKeys().has(key)) throw new Error(`repos.${key} already configured — edit ${configPath()} directly`);
        appendRepoBlock({ ...detected, key }, { pickup: args.includes('--pickup') });
        console.log(toonKV({ key, path: detected.path, trunk: detected.trunk, origin: detected.origin, pickup: args.includes('--pickup') }));
        break;
      }
      const repos = loadConfig().repos;
      const rows = Object.entries(repos).map(([key, r]) => ({
        key,
        path: r.path,
        trunk: r.trunk,
        pickup: r.pickup ?? false,
        exists: fs.existsSync(r.path),
      }));
      console.log(toonTable('repos', rows, ['key', 'path', 'trunk', 'pickup', 'exists']));
      break;
    }
    case 'version': {
      console.log(lobstahVersion());
      break;
    }
    case 'watch': {
      const sub = args[0];
      if (sub === 'add') {
        const key = args[1];
        const check = arg(args, '--check');
        if (!key || key.startsWith('--') || !check) throw new Error('watch add requires a key and --check <command>');
        const forId = arg(args, '--for');
        const every = arg(args, '--every');
        const w = addWatch(key, check, {
          owner: forId ? `dispatch:${forId}` : 'man',
          cursor: arg(args, '--cursor'),
          everySecs: every ? Number(every) : undefined,
          brief: arg(args, '--brief'),
          stream: arg(args, '--stream'),
        });
        console.log(toonKV({ key: w.key, owner: w.owner, cursor: w.cursor, registered: true }));
        console.log(
          toonHelp(
            w.owner === 'man'
              ? ['lobstah man wait   (its events wake you)', 'lobstah watch   (list watches)']
              : ['lobstah watch   (list watches; events fork the owning chain)'],
          ),
        );
        break;
      }
      if (sub === 'rm') {
        const key = args[1];
        if (!key) throw new Error('watch rm requires a key');
        console.log(toonKV({ key, removed: removeWatch(key) }));
        break;
      }
      const rows = listWatches().map((w) => ({
        key: w.key,
        owner: w.owner,
        cursor: w.cursor,
        pending: readWatchEvents(w.key).length - w.seen,
        lastChecked: w.lastCheckedAt ?? '-',
        error: w.lastError ?? '',
      }));
      console.log(toonTable('watches', rows, ['key', 'owner', 'cursor', 'pending', 'lastChecked', 'error']));
      break;
    }
    case 'init': {
      if (!fs.existsSync(configPath())) {
        // --scan fills [repos.*] with real repos; only a bare init needs the
        // placeholder to show the shape (doctor would flag its fake path).
        const exampleRepo = args.includes('--scan')
          ? ''
          : `[repos.example]
path  = "~/src/example"
trunk = "main"
# origin = "git@github.com:you/example.git"
# setup  = ["pnpm install"]
# pickup = true   # opt into [pickup.github] multi-repo tracker pickup

`;
        fs.writeFileSync(
          configPath(),
          `# lobstah workspace definitions — the descriptor's repo key resolves here.
# Top-level keys must come before any [section].
# notifyCommand = "ntfy pub my-topic \"$LOBSTAH_VERB $LOBSTAH_ID: $LOBSTAH_NOTE\""
# notifyVerbs   = ["needs-decision", "blocked", "done", "failed"]   # the default

${exampleRepo}[harness]
default = "claude"

[limits]
maxConcurrent      = 2
choreConcurrent    = 1
wedgeThresholdSecs = 600
maxRestartAttempts = 2
wallClockSecs      = 3600
`,
        );
      }
      const scanIdx = args.indexOf('--scan');
      const added: string[] = [];
      const unmarked: string[] = [];
      if (scanIdx >= 0) {
        const roots = args.slice(scanIdx + 1).filter((a) => !a.startsWith('--'));
        if (roots.length === 0) throw new Error('--scan requires at least one directory');
        const known = configuredRepoKeys();
        const pickup = args.includes('--pickup');
        for (const repo of scanForRepos(roots)) {
          if (known.has(repo.key)) continue;
          known.add(repo.key);
          appendRepoBlock(repo, { pickup });
          added.push(repo.key);
          if (!pickup) unmarked.push(repo.key);
        }
      }
      // The npm package ships docs/ next to dist/; running from source falls
      // back to the canonical URL rather than printing a path that isn't there.
      let reference = 'https://github.com/aequitas-labs/lobstah/blob/main/docs/configuration.md';
      try {
        const local = fileURLToPath(new URL('../docs/configuration.md', import.meta.url));
        if (fs.existsSync(local)) reference = local;
      } catch {
        // keep the URL
      }
      console.log(
        toonKV({
          home: path.dirname(configPath()),
          config: configPath(),
          ...(added.length > 0 ? { added: added.join(', ') } : {}),
          ...(unmarked.length > 0
            ? { note: `none marked pickable — set pickup = true per [repos.*] (or rerun with --pickup)` }
            : {}),
          reference,
          initialized: true,
        }),
      );
      break;
    }
    case '--version':
    case '-v':
      console.log(lobstahVersion());
      break;
    case undefined: {
      // Content first (axi.md P8): bare `lobstah` shows the live fleet, not
      // help text. `lobstah help` remains the full reference.
      console.log(`lobstah ${lobstahVersion()} — supervision for coding agents (home: ${lobstahHome()})`);
      console.log('');
      console.log(renderTend(buildTendReport()));
      console.log('');
      console.log(
        toonHelp([
          'lobstah dispatch --repo <key> --brief-text "<brief>"   queue work',
          'lobstah status <id>                                    one dispatch',
          'lobstah man tend                                       full fleet pass',
          'lobstah help                                           every command',
        ]),
      );
      break;
    }
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    default:
      throw new UsageError(`unknown command "${cmd}" — run \`lobstah help\``);
  }
}

mainCli().catch((err) => {
  // Structured errors on stdout (axi.md P6) — the reader is usually an
  // agent, and stderr interleaves unpredictably in harness transcripts.
  // Exit 2 marks a usage mistake (unknown command, flag, or subverb); 1 is
  // every other error. A usage message carries its card on the lines below
  // the error, printed raw so it stays readable.
  const msg = err instanceof Error ? err.message : String(err);
  const [first, ...rest] = msg.split('\n');
  console.log(toonKV({ error: first }));
  if (rest.length > 0) console.log(rest.join('\n').trimStart());
  process.exit(err instanceof UsageError ? 2 : 1);
});
