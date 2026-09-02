#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  acknowledge,
  appendStatus,
  readEvidence,
  loadConfig,
  lobstahHome,
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
  toonKV,
  toonTable,
  VERBS,
} from '@lobstah/core';
import type { Descriptor, Lane } from '@lobstah/core';
import { attentionNow, captureWaitBaseline, daemon, freshWakeEvents, killGroup, pidAlive } from '@lobstah/supervisor';
import { runPickup } from '@lobstah/pick';
import { mergeHaulHook } from './hooks.js';
import { buildTendReport, renderTend } from './tend.js';
import { applyCull, planCull } from './cull.js';
import { MANUAL } from './manual.js';

const HELP = `lobstah — supervision framework for coding agents

work (humans and agents):
  dispatch --repo <key> (--brief <file> | --brief-text <text>)   (alias: set --bait)
           [--harness claude|codex] [--model <m>] [--effort <e>]
           [--follow-up <uuid>] [--chore] [--id <uuid>]
                                  queue a supervised dispatch; prints the id
  ls [--all]                      queue, active, recent done      (alias: buoys)
  status [<uuid>]                 reconciled state                (alias: buoy)
  logs <uuid> [--follow]          the normalized event stream
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

host processes (run under launchd/systemd/pm2):
  daemon [--interval <ms>]        the supervisor: claims, worktrees, liveness,
                                  restart ladder, notifyCommand. One per home.
  pick [once]                     tracker loops: poll Linear/GitHub, dispatch
                                  assigned work, report back, reconcile, merge

lobsterman (orchestrator sessions — bare \`lobstah man\` prints the manual):
  man tend [--json]               tend the whole string: fleet verdict (daemon
                                  up, stalled vs idle), unanswered questions
                                  with ages, each work item's dispatch chain,
                                  PR, and merge-gate status from pick's last
                                  observation. Pure disk read — no forge calls.
  man wait [--timeout <secs>] [--peek]
                                  block until a dispatch needs attention, then
                                  print the event and what to do next; exit 2
                                  on timeout. Unanswered questions re-fire
                                  every remindSecs until answered.
  man init [--shared] [--marker]  install the haul Stop hook into this
                                  project's .claude/settings.local.json
                                  (--shared: settings.json); --marker touches
                                  .lobstah-man. Idempotent.
  man haul [--timeout <secs>]     Stop-hook entry point: park the session while
                                  work is in flight; prints hook-decision JSON
                                  on an event, silent exit 0 otherwise. Gate:
                                  LOBSTAH_MAN=1 or a .lobstah-man file.

workers (dispatched agents; injected into every brief):
  report <uuid> <verb> [note] [--pr <url>]
                                  the validated status write path
                                  (${VERBS.join(' | ')})

setup:
  init                            create ~/.lobstah + example config

Everything except daemon and pick works with both stopped: writes are files,
reads are files. Output is TOON; agents can drive this CLI directly.
Home: $LOBSTAH_HOME (default ~/.lobstah) — one daemon per home, enforced.`;

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
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
    cmd = args.length > 0 ? `man:${args[0]}` : 'man:manual';
    args = args.slice(1);
  }
  ensureLayout();

  switch (cmd) {
    case 'dispatch': {
      const repo = arg(args, '--repo');
      const briefFile = arg(args, '--brief') ?? arg(args, '--bait');
      const briefText = arg(args, '--brief-text');
      if (!repo || (!briefFile && !briefText)) {
        throw new Error('dispatch requires --repo and --brief <file> (or --brief-text)');
      }
      const d: Descriptor = {
        id: arg(args, '--id') ?? randomUUID(),
        repo,
        brief: briefText ?? fs.readFileSync(briefFile!, 'utf8'),
        harness: arg(args, '--harness'),
        model: arg(args, '--model'),
        effort: arg(args, '--effort'),
        followUp: arg(args, '--follow-up'),
      };
      const lane: Lane = args.includes('--chore') ? 'chore' : 'work';
      enqueue(d, lane);
      console.log(toonKV({ id: d.id, repo, lane, queued: new Date().toISOString() }));
      break;
    }
    case 'ls': {
      const lanes: Lane[] = args.includes('--all') ? ['work', 'chore'] : ['work'];
      const rows = lanes.flatMap((lane) =>
        (['queue', 'active', 'done'] as const).flatMap((b) => rowsFor(lane, b)),
      );
      console.log(toonTable('dispatches', rows, ['id', 'lane', 'bucket', 'state', 'updated']));
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
      break;
    }
    case 'logs': {
      const id = args[0];
      if (!id) throw new Error('logs requires a dispatch id');
      const lane = findLane(id);
      const file = eventsPath(id, lane);
      if (fs.existsSync(file)) process.stdout.write(fs.readFileSync(file, 'utf8'));
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
      const prIndex = rest.indexOf('--pr');
      const prUrl = prIndex >= 0 ? rest[prIndex + 1] : undefined;
      const note = rest.filter((_, i) => i !== prIndex && i !== prIndex + 1).join(' ') || undefined;
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
      const invocation =
        harness === 'codex' ? { file: 'codex', argv: ['resume', sessionId] } : { file: 'claude', argv: ['--resume', sessionId] };
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
      const standing = attentionNow(!args.includes('--peek'), remindMs);
      if (standing.length > 0) {
        emit(standing);
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
      }
      console.log(toonKV({ timeout: true, waitedSecs: timeoutSecs }));
      process.exitCode = 2;
      break;
    }
    case 'man:init': {
      const file = path.join('.claude', args.includes('--shared') ? 'settings.json' : 'settings.local.json');
      let existing: unknown;
      try {
        existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        existing = undefined;
      }
      const { settings, changed } = mergeHaulHook(existing);
      if (changed) {
        fs.mkdirSync('.claude', { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
      }
      if (args.includes('--marker')) fs.writeFileSync('.lobstah-man', '');
      console.log(
        toonKV({
          hook: 'lobstah man haul',
          file,
          installed: changed || 'already present',
          gate: args.includes('--marker') ? '.lobstah-man (this directory)' : 'launch with LOBSTAH_MAN=1 claude',
        }),
      );
      break;
    }
    case 'man:haul': {
      // Stop-hook entry point: everything non-actionable is a silent exit 0 —
      // a hook must never break the user's stop with noise.
      try {
        if (process.env.LOBSTAH_MAN !== '1' && !fs.existsSync('.lobstah-man')) break;
        const anyActive = (['work', 'chore'] as Lane[]).some((l) =>
          fs.readdirSync(laneDirs(l).active).some((f) => !f.startsWith('.')),
        );
        if (!anyActive) break; // nothing in flight — conversational turns end free
        const timeoutSecs = Number(arg(args, '--timeout') ?? '14000');
        const deadline = Date.now() + timeoutSecs * 1000;
        const remindMs = (loadConfig().remindSecs ?? 900) * 1000;
        let evs = attentionNow(true, remindMs);
        if (evs.length === 0) {
          const baseline = captureWaitBaseline();
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 1500));
            evs = freshWakeEvents(baseline);
            if (evs.length === 0) evs = attentionNow(true, remindMs); // reminders fire mid-park too
            if (evs.length > 0) break;
          }
        }
        if (evs.length === 0) break; // timeout — allow the stop; tier 1 covers the horizon
        const lines = evs.map(
          (ev) => `- ${ev.entry.verb} ${ev.id}${ev.entry.note ? ` — ${ev.entry.note}` : ''}`,
        );
        const reason = [
          'A lobstah dispatch needs attention:',
          ...lines,
          'Check with `lobstah status <id>`; answer a needs-decision with `lobstah send <id> "<answer>"`.',
          'Handle it now. This session re-parks automatically at turn end — do not arm any watcher.',
        ].join('\n');
        console.log(JSON.stringify({ decision: 'block', reason }));
      } catch {
        // never break a stop
      }
      break;
    }
    case 'daemon': {
      const interval = Number(arg(args, '--interval') ?? '5000');
      await daemon(interval);
      break;
    }
    case 'pick': {
      await runPickup(args[0] === 'once' ? 'once' : 'daemon');
      break;
    }
    case 'init': {
      if (!fs.existsSync(configPath())) {
        fs.writeFileSync(
          configPath(),
          `# lobstah workspace definitions — the descriptor's repo key resolves here.
# Top-level keys must come before any [section].
# notifyCommand = "ntfy pub my-topic \"$LOBSTAH_VERB $LOBSTAH_ID: $LOBSTAH_NOTE\""
# notifyVerbs   = ["needs-decision", "blocked", "done", "failed"]   # the default

[repos.example]
path  = "~/src/example"
trunk = "main"
# origin = "git@github.com:you/example.git"
# setup  = ["pnpm install"]

[harness]
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
      console.log(
        toonKV({
          home: path.dirname(configPath()),
          config: configPath(),
          reference: 'docs/configuration.md',
          initialized: true,
        }),
      );
      break;
    }
    case undefined:
    case '--help':
    case 'help':
      console.log(HELP);
      break;
    default:
      throw new Error(`unknown command "${cmd}" — run lobstah help`);
  }
}

mainCli().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
