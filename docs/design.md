# Lobstah — design

**Local executor for coding agents.**

Lobstah takes a dispatch descriptor and a brief, allocates an isolated worktree,
runs a coding agent, supervises it until it finishes or dies, and writes status
and evidence to disk.

It has no network interface, no credentials, and no knowledge of any tracker.

---

## Problem

Teams delegating work to coding agents have two bad options.

**Cloud sandboxes** — the hosted coding-agent services — cannot
reach a private toolchain, unpushed branches, local services, or credentials that
never leave a laptop. Work that needs the developer's actual environment cannot
run there.

**Running agents locally by hand** works, and nobody knows what is happening. A
Claude Code session in a terminal gives no answer to "is it still working, is it
stuck, or did it die." The failure mode is a session wedged for forty minutes on
a question nobody saw.

Lobstah is the supervision layer for the second option.

---

## Goals

- Run coding agents on a machine the developer controls
- Report liveness accurately, without screen scraping
- Distinguish a dead process from a wedged one and treat them differently
- Isolate concurrent work so parallel tasks cannot collide
- Recover from crashes without human intervention, within bounds
- Work standalone, with no knowledge of any particular dispatcher

## Non-goals

Lobstah must stay uninteresting past its job. It has:

- No network listener, no outbound HTTP, no OAuth
- No Linear, Slack, GitHub, or tracker integration
- No verdicts, review UI, or artifact rendering
- No decomposition, claims, or intent model
- No merge decisions
- No hosted service

The moment Lobstah grows something that makes a team feel covered, it stops
being a component and starts competing with the thing it feeds.

---

## Architecture

TypeScript daemon, one repository, packages factored so a new harness does not
touch supervision.

```
lobstah/
  packages/
    core/            queue contract, state machine, types
    supervisor/      process liveness, wedge detection, restart ladder
    worktree/        allocation, isolation, cleanup
    runner/          per-dispatch child process; drives an adapter
    adapters/
      claude/        @anthropic-ai/claude-agent-sdk
      codex/         @openai/codex-sdk
  apps/
    cli/             lobstah dispatch | status | cancel | daemon
    node/            OpenClaw node plugin
```

**Why not shell.** A bash fleet is the right shape when the supervisor is an
LLM — the scripts are a tool surface for a model. Lobstah's consumer is a program
reading files, so the CLI wrapper earns nothing, and the delicate parts —
generation-token validation under a lock, atomic sequence allocation, three-source
state reconciliation — are straightforward in a typed language and fragile in
shell.

### The two-process split

The daemon does not run agents in-process. Every SDK in this category spawns its
harness CLI as a subprocess of the calling process, so an in-process session dies
with the daemon and is invisible to anything else.

```
daemon  ──spawn──>  runner (one per dispatch)  ──SDK──>  harness CLI
   │                    │
   │                    └── writes state/<uuid>.*
   └── supervises runner by pid, reconciles from state files
```

- Daemon crash leaves runners alive and state files intact. It reconciles on
  restart.
- Runner crash is visible through ordinary process supervision, and the state
  files record how far it got.
- The SDK improves what happens inside the runner. It is not the durability
  layer.

**Lobstah persists no conversation state.** Every harness already writes its own
transcript — Claude Code under `~/.claude/projects/`, Codex per thread. State
files track the dispatch: work item, worktree, verb, evidence. On resume, fork
the harness's own session rather than replaying a transcript into a new one.

### Adapters

Day 1 is Claude Code and Codex. Two implementations is the minimum that
validates the interface rather than shaping it around one harness, and between
them they cover most of the installed base.

Both expose the same conceptual API, which is what makes the abstraction real:

| | Claude Agent SDK | Codex SDK |
|---|---|---|
| Start | `query()` | `codex.startThread()` |
| Turn | async message generator | `thread.run()` |
| Stream | messages + hooks | `thread.runStreamed()` |
| Continue | resume by session id | `run()` again on the thread |
| Providers | Anthropic, Bedrock, Vertex, Foundry | OpenAI |

The adapter interface normalizes to: `start`, `run`, `resume`, `cancel`, and a
typed event stream carrying turn boundaries and tool-call boundaries.

**Tool-call granularity differs and both are usable.** Codex emits `item.started`
and `item.completed` around each `command_execution` or `mcp_tool_call`, so a
hanging call is an open interval you can name. Claude's `PostToolUse` fires after
completion, so a hang shows as silence. The adapter maps both to "last tool
activity at T," and the wedge threshold stays global.

Claude has the richer intervention surface — `PreToolUse` interception,
`SubagentStart` and `SubagentStop`, and 12+ hooks against Codex's six event
types. Anything relying on interception is Claude-only and must degrade rather
than fail on Codex.

Normalize cancellation explicitly. The Codex SDK's own ports document divergence
here — the Go port sends SIGTERM with a 2s grace then SIGKILL where the
TypeScript SDK sends a single SIGTERM. Differences like that leak into restart
behavior if the adapter layer does not absorb them.

OpenCode is the Day 2 candidate. It has a TypeScript SDK, a client/server
architecture that may be easier to supervise than subprocess spawning, and 75+
providers including local models, which makes agent-agnosticism true rather than
aspirational.

### Auth boundary

Anthropic does not permit third-party developers to offer claude.ai Pro or Max
login or subscription rate limits for products built on the Agent SDK.
Subscription usage of the SDK and `claude -p` is metered against the signed-in
plan's limits.

So Lobstah never handles a harness login. The user authenticates their own CLI
on their own machine; Lobstah invokes the authenticated binary and nothing else.
No reading, persisting, refreshing, or forwarding of harness tokens — a
non-secret route marker at most, with the harness owning its token lifecycle.

For shared automation the operator supplies an API key through repo config, which
is per-machine rather than brokered.

---

## OpenClaw node plugin

OpenClaw already solves the undifferentiated parts of remote dispatch. It has
a WebSocket control plane. Nodes declare `role: node` with explicit caps and
commands. Device pairing needs identity plus approval plus token. Auth fails
closed. Each node has an exec allowlist. Transport is Tailscale or SSH, not
public exposure.

Lobstah ships a node plugin that advertises a run capability and translates
inbound commands into queue descriptors. The core does not know OpenClaw exists.

```
OpenClaw Gateway  ──WS──>  lobstah node plugin  ──writes──>  queue/
                  <──                          <──reads──    state/
```

What the plugin adds over OpenClaw's own Claude session continuation, which is
one-shot, rejects attachments, and has no workspace isolation:

- Per-work-item worktree allocation branched from trunk
- Dead-versus-wedged classification and the restart ladder
- Dispatch queue semantics with a concurrency ceiling
- Work-item-shaped evidence collection

Two independent integration surfaces driving one core is the test of whether
the queue contract is a real interface. If both drive it without the core knowing
which, it holds.

Depending on any gateway means inheriting its release cadence and its security
surface. The plugin is therefore additive. The file queue and CLI remain the primary path, and
nothing in `core` may import from `apps/node`.

---

## Queue contract

The dispatch surface is a directory. No port, no protocol, no authentication.

```
~/.lobstah/
  queue/         <uuid>.json          pending descriptors
  active/        <uuid>/              claimed, in flight
  done/          <uuid>/
  state/         <uuid>.status        append-only, six verbs
                 <uuid>.evidence      branch, commits, PRs, CI refs
                 <uuid>.events        hook telemetry
  inbox/         <uuid>/NNN.msg       instructions to a running agent
                 <uuid>/handled/      acknowledgement by rename
  chores/        queue/ active/ done/ state/    second lane: internal dispatches
  executor.json  capabilities + heartbeat
```

### Descriptor

```json
{
  "id": "6f3a...",
  "repo": "myapp",
  "brief": "...",

  "harness": "claude",
  "model": "opus",
  "effort": "high",
  "limits": { "maxTurns": 200, "maxBudgetUsd": 5, "wallClockSecs": 3600 },
  "flags": ["--add-dir", "../shared"],
  "env": { "NODE_ENV": "test" },
  "followUp": "9c41..."
}
```

`id`, `repo`, and `brief` are required. Everything below the break is optional
and resolves through a precedence chain:

```
descriptor  >  repo config  >  global config  >  adapter default
```

**Structured fields are cross-harness concepts.** `model`, `effort`, and `limits`
mean something in every harness and translate differently in each. Claude takes a
thinking budget, Codex takes a reasoning effort level, others take neither. The
adapter owns the translation, and an unsupported value is dropped with a warning
rather than failing the dispatch.

**`flags` is the escape hatch**, appended verbatim to the harness invocation. It
couples the descriptor to one harness, so it should be rare. A descriptor using
only structured fields routes to any machine; one using `flags` routes only to
machines running that harness.

**`env` is per-dispatch environment**, merged over the repo's own environment.

**`followUp` forks an earlier dispatch's harness session** instead of starting
cold — the restart ladder's first rung, exposed to callers. The runner resumes
by the prior dispatch's session identity (Claude by session id, Codex by
thread id) and the original transcript survives untouched. Use it when the
follow-up is about choices that session made, as review feedback is. Skip it
when the follow-up is about the world changing after the session exited — a
rebase conflict is about commits the session never saw, so its transcript is
replay cost without signal.

**`id` is the only correlation handle.** Lobstah uses it as a directory name and
a status filename. Whoever dispatched holds the mapping from UUID to work item,
claims, and tracker — the dispatcher holds that table. Standalone, the human
knows what they dispatched. Nothing on device needs to reconstruct it, and an on-device
model to hold a mapping is more machinery than a lookup.

**`repo` must be structured, not prose.** Worktree allocation happens before the
agent starts, so the repo cannot be something the agent reads out of the brief
later. Parsing it from prose would put an LLM in the allocation path, which is
the failure it exists to avoid.

It is an opaque key, not a URL or a path. The key names a **workspace
definition** in local config: a git repository plus the execution context around
it — trunk branch, setup commands, environment, harness defaults. The dispatcher
names the key; resolution is local.

That keeps the descriptor free of machine-specific detail and lets the same
descriptor route to any machine advertising the key. It also allows one git
repository to back several keys — `myapp` and `myapp-perf` pointing at the same
checkout with different setup and limits.

If a key carries an `origin`, Lobstah clones on first use. Without one, an
unresolvable key fails the dispatch immediately rather than at agent start.

### Claiming

Atomic rename from `queue/` to `active/`. That is what makes concurrent writers
safe without a lock.

**Lobstah decides how many to claim.** The queue holds descriptors and has no
concept of capacity. Concurrency limits live in Lobstah's config, so a writer
draining a backlog into the directory cannot over-fill the machine.

### Watching

Watch as an optimization, poll as the guarantee. `fsevents` and `inotify` both
drop events under load and across network mounts. A directory scan every few
seconds is the contract; the watcher only reduces latency.

### Cancellation

A `cancel` file in `active/<uuid>/`, checked by the supervisor loop between
polls. Latency equals the loop interval, which is acceptable for a task measured
in minutes.

### Capabilities

`executor.json` advertises what this machine can serve and when it was last
alive:

```json
{
  "machineId": "chris-mbp",
  "repos": ["myapp", "lobstah"],
  "harnesses": ["claude", "codex"],
  "maxConcurrent": 2,
  "version": "0.4.1",
  "heartbeat": "2026-09-01T14:22:03Z"
}
```

A dispatcher reads this to route. A stale heartbeat is how it knows the machine
is offline. Lobstah writes it and never reads anything back.

### The chore lane

`chores/` mirrors the primary lane — same descriptor schema, same claiming,
same supervision, its own `queue/`, `active/`, `done/`, and `state/`.

A chore is an agent run the system originates for its own operation —
judgment applied to mechanics, with no human request behind it. The lane is
bounded on both sides. Anything deterministic never becomes a dispatch at all
— that is daemon or caller code. Anything a human asked for, or that changes
what a human will review beyond mechanics, is work in the primary lane. A rebase to unblock a merge is the founding case; restacking a stack's
descendants after a squash-merge is the same shape. Chores have their own
concurrency ceiling (default 1; `maxConcurrent` governs the primary lane
only), are hidden from `ls` and `status` unless asked for, and age out of
`done/` on a short retention. The daemon treats the two lanes identically past
admission; the split is queue hygiene, not a second contract.

### Inbox delivery

Writing to `inbox/<uuid>/` queues a message. Delivery is a separate question, and
headless execution shapes the answer.

A multiplexer-based fleet can type a doorbell into a tmux pane because its
workers are interactive TUIs sitting at a prompt. A Lobstah agent runs as `claude -p` with stdout
redirected, so there is no composer to type into and no prompt to interrupt. The
process runs many internal turns and exits once.

Three delivery points, in ascending cost:

**Between turns.** The runner drains the inbox into the next `run()` on the same
thread. Deterministic — guaranteed delivered and guaranteed read. Latency is the
remainder of the current turn. Works identically on both adapters, so this is the
default.

**Mid-turn pull, through the CLI.** The agent runs `lobstah inbox <id>` at its
own checkpoints, instructed by the injected contract. One transport for every
harness, and cheaper than MCP tools — tool schemas ride in the context every
turn, a CLI call costs the command string. It depends on the agent choosing
to look.

**Mid-turn push, through hooks.** Claude's `PreToolUse` can return additional
context, injecting the message before the next tool call. No agent cooperation
and one tool call of latency. Claude-only — Codex exposes events without
interception — so it must degrade to pull rather than fail.

Start with between-runs delivery. Mid-run steering matters less for a headless
fleet, because a headless run that needs redirecting is usually better
cancelled and re-dispatched with a corrected brief.

Acknowledgement stays the same regardless: a move into `handled/`, which is a
side effect that cannot be faked.

---

## CLI

The CLI never talks to the daemon. Writes are files; reads are files. That is the
main practical benefit of the directory contract.

| Command | Action |
|---|---|
| `lobstah dispatch --repo myapp --brief ./b.md` | Writes a descriptor to `queue/` |
| `lobstah status [uuid]` | Reads and reconciles from `state/` |
| `lobstah logs <uuid> [--follow]` | Tails `state/<uuid>.events` |
| `lobstah send <uuid> "<msg>"` | Writes an inbox record |
| `lobstah cancel <uuid>` | Writes a cancel marker to `active/<uuid>/` |
| `lobstah ls` | Lists queue, active, and recent done |
| `lobstah daemon` | Starts the supervisor loop |

`status` performs the same three-source reconciliation the supervisor does —
CI run state, then busy state, then the status log — so a human and the bridge
see the same answer.

Every command except `daemon` works with the daemon stopped. Dispatches written
while it is down are claimed when it comes back.

It should also utilize TOON for any output and also be self-documenting for any agent to utilize it.

---

## Callers

Five, all writing the same descriptor into the same directory.

| Caller | Path |
|---|---|
| CLI | `lobstah dispatch --repo myapp --brief ./b.md` |
| Remote bridge | drains a remote dispatcher's queue, writes descriptors, posts state back |
| OpenClaw node plugin | translates gateway commands into descriptors |
| Pickup add-on | polls Linear/GitHub, no webhooks — see [pickup.md](pickup.md) |
| Anything else | a cron job, a shell script, a different tracker |

The bridge and the node plugin are the only pieces holding credentials, and
neither lives in `core`. Anyone can write a third without touching Lobstah, which
is what makes the separation real rather than nominal.

---

## Lifecycle

### 1. Claim

Rename the descriptor into `active/<uuid>/`. Write the brief to
`active/<uuid>/brief.md` and treat that file as the durable instruction. Never
the session transcript.

### 2. Worktree allocation

One worktree per dispatch, branched from trunk. Never reuse a worktree across
dispatches, and never allocate a second worktree for a UUID whose first is
unaccounted for.

This prevents convenience stacking, where an agent finishing one task and
starting the next in the same worktree produces a branch containing the previous
task's diff. That contaminates evidence and falsely serializes merges.

### 3. Spawn the runner

The daemon spawns one runner per dispatch with `setsid`, then records its pid and
process start time. The runner drives the adapter; the daemon supervises the
runner and never touches the harness directly.

```ts
// inside the runner
const thread = await adapter.start({
  id: uuid, cwd: worktree, brief, model, effort, limits, flags, env,
});
for await (const ev of thread.stream()) {
  appendEvent(ev);        // state/<uuid>.events
}
```

- **The dispatch UUID is the session identity.** Claude takes it as
  `--session-id`; Codex issues a thread id the adapter records on
  `thread.started`. Either way the handle exists before the first token.
- **`setsid`** so the whole group is killable. Harnesses spawn children — bash
  calls, MCP servers — that a bare `kill` orphans.
- **Process start time** defeats pid reuse.
- **Limits** map to `maxBudgetUsd` and turn caps through the adapter, plus a
  Lobstah-owned wall-clock ceiling the SDKs do not provide.

### 4. Supervise

Three signal levels, kept separate. None derived from another.

| Level | Source | Question |
|---|---|---|
| Runner liveness | pid + start time | Does the process exist |
| Agent activity | SDK event stream | Is a turn or tool call in flight |
| Task state | agent-declared status | What is the work doing |

**Events, not scraping.** The adapter writes normalized events to
`state/<uuid>.events` from the SDK's typed stream. No JSONL parsing and no shell
hooks for telemetry.

Tool-call granularity differs by harness and both are usable:

| | Claude | Codex |
|---|---|---|
| Turn boundary | message stream + `Stop` | `turn.started` / `turn.completed` |
| Tool start | not surfaced | `item.started` |
| Tool end | `PostToolUse` | `item.completed` |
| Hang appears as | silence | an open interval |

Codex names the hanging call; Claude only shows absence. The adapter normalizes
both to `lastToolActivityAt`, so the wedge threshold stays global.

**Classification rule.** Missing, malformed, stale, or unverified data is
`unknown`, never `idle`. Absence of signal never means done.

**Progress signals**, descending strength: tool-activity timestamp, event-file
growth, worktree mtime. Codex's `file_change` items give the third signal
directly; for Claude it stays a filesystem check, which is what covers a long
build that completes no tool call.

### 5. Report

**Status** is append-only, six verbs, nothing else:

```
working | needs-decision | blocked | paused | done | failed
```

The consumer is a program, not a model. An LLM-supervised fleet tolerates odd
status lines because an LLM reads them; a bridge cannot. **The verb is validated at the write
path and anything outside the set is rejected**, rather than relying on the brief
to hold.

The agent learns the contract the way every dispatch learns everything: the
runner injects the status and inbox protocol into the prompt it composes.
Nothing is installed repo-side, and the contract versions with the daemon
instead of drifting per repo.

The log is an event log, not a state field. An agent that resumes silently writes
nothing, so the last line goes stale. Current state is reconciled in precedence
order: CI run state, then busy state, then the status log as a last resort.

**Instructions** flow the other way through `inbox/<uuid>/`. Sequenced records
written by atomic rename, acknowledged by moving into `handled/`. The
acknowledgement is a side effect the agent had to perform anyway, so it cannot be
faked. Notification is best-effort and retryable; the record is the delivery.

### 6. Complete

Collect evidence into `state/<uuid>.evidence` — branch, commits, PR URL if
opened, CI references, transcript path — then move `active/<uuid>/` to `done/`.

`done` means the brief is fulfilled — not that the work item is finished. A PR
still faces review, feedback rounds, and merge, and "merged" is a forge
concept core is forbidden to know. A work item therefore spans dispatches —
implementation, feedback follow-ups, a rebase chore — correlated by whoever
dispatched them. **The dispatch is the unit of supervision, not the unit of
work.** Work-item completion belongs to the dispatcher's ledger and the
tracker's own lifecycle.

---

## Restart policy

Dead and wedged get opposite treatment.

**Dead.** Process gone, or the foreground group contains only shells.
Auto-restart, unattended. Preconditions, all hard:

- The endpoint is *positively* agent-free. Ambiguous and unreadable never qualify.
- The worktree is intact and still the recorded one.
- The prior runner's event stream is closed and its generation retired before
  the replacement is armed, so a late write cannot land in the new incarnation.

**Wedged.** Alive, no tool event past threshold. Never restart automatically.
Bound it, then work a ladder:

1. Resume the harness's own session with a nudge — Claude by session id, Codex
   by thread id. Worktree plus conversation is the cheapest recovery. Fork rather
   than mutate, so the original transcript survives for postmortem.
2. Fresh session with the original brief plus a progress note from
   `git log --oneline` and `git status --short`. A wedge caused by the
   conversation will re-wedge on resume.
3. Stop. Report `failed` with preserved work.

Bounded attempt count per dispatch. A silently re-restarting session against a
task nobody is watching is the failure mode that costs real money.

Never kill a process that already exited, and never race a restart against a
completed run. Two branches, kept separate in code.

---

## Load-bearing mechanisms

Hard-won, language-independent patterns from the fleet supervisors that came
before, reimplemented rather than ported.

| Mechanism | Purpose |
|---|---|
| Atomic rename for claim and sequence | Concurrency safety without locks |
| Acknowledgement by required side effect | An ack that cannot be faked |
| Generation tokens on hooks | A hook outliving its incarnation fails closed |
| Three-level state, strict precedence | `unknown` never collapses to `idle` |
| Positively-agent-free precondition | A false `dead` verdict launches a duplicate |
| Durable record, retryable notification | Delivery survives a lost notification |

Package factoring keeps adapters per harness and transport separated from
decisions — per-harness `case` statements scattered across call sites are the
cost of not doing this.

---

## Authentication and routing

Subscription authentication is individual. A shared host running a team's work on
one seat routes other people's requests through one person's seat.

**Consequence:** Lobstah is per-user. One daemon, one machine, one seat.

A shared orchestrator dispatches to per-user machines through their bridges.
Online and offline become routing conditions rather than edge cases, resolved
from `executor.json` heartbeats.

Lobstah holds no credentials for anything. The bridge, the node plugin, and the
operator's own repo config hold them.

*Anthropic's position has moved twice this year. Verify against current terms
before this becomes load-bearing.*

---

## Configuration

Local file. Version-controllable, greppable, no network dependency.

```toml
[repos.myapp]
path   = "~/src/myapp"
origin = "git@github.com:you/myapp.git"      # optional; enables clone on first use
trunk  = "main"
setup  = ["pnpm install"]
env    = { TURBO_TELEMETRY_DISABLED = "1" }

[repos.myapp.harness]
default = "claude"
model   = "opus"
effort  = "high"

[harness]                        # global fallback
default = "claude"
model   = "sonnet"

[limits]
maxConcurrent      = 2
wedgeThresholdSecs = 600
maxRestartAttempts = 2
wallClockSecs      = 3600
```

Harness settings appear at both levels. A descriptor overrides the repo, which
overrides the global, which overrides the adapter default.

---

## Distribution

MIT. Standalone-installable, useful with nothing else installed.

Positioning is "open source supervisor for local coding agents." The README has
to stand alone; if that README cannot be written, the component is not ready to
ship.

Two distribution paths off one core:

| Path | Surface |
|---|---|
| Standalone | `npm i -g lobstah`, file queue, CLI |
| OpenClaw plugin | agent tools + a chat command, installed into an existing gateway |

A remote dispatcher integrates the same way anything does: by writing
descriptors and reading state.

Support posture: issues accepted, no response-time commitment, no roadmap input,
contributions merged on the maintainer's schedule. Security reports and
dependency CVEs answered regardless.

---