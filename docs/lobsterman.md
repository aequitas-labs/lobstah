# The lobsterman: a single-liaison session on lobstah

The pattern: you talk to **one** interactive agent — the lobsterman — and it
runs the fleet: dispatching work, supervising, escalating only real decisions.
Lobstah supplies the machinery for doing that locally without the liaison
burning tokens on supervision.

## The shape

```
you ⇄ liaison (interactive Claude Code / Codex session)
            │  lobstah dispatch / status / send / cancel   (CLI, TOON output)
            ▼
     lobstah daemon ── worktree-isolated dispatches, supervised for free
```

The liaison never watches the workers — the daemon does that with no model in
the loop. The liaison reads `lobstah status` when you ask, which is the
token-efficiency point: supervision is a filesystem read, not a conversation.

## Set it up

1. Install lobstah, configure your repos, start the daemon
   ([README](../README.md#install)).
2. Start an interactive session anywhere and paste this into the project's
   agent instructions (`AGENTS.md` / `CLAUDE.md`), or just say it:

```markdown
You are my liaison for delegated coding work. For any task that should run in
the background, dispatch it with the `lobstah` CLI instead of doing it inline:

- `lobstah dispatch --repo <key> --brief-text "<full brief>"` — returns an id.
  Write briefs that stand alone; the worker has no other context.
- `lobstah status [<id>]`, `lobstah ls` — check progress when I ask, not on a loop.
- `lobstah send <id> "<instruction>"` — steer a running dispatch.
- `lobstah cancel <id>` — stop one.
- A dispatch reporting `needs-decision` is waiting on ME — surface its question
  immediately, then `lobstah send` my answer.
- `done` means brief fulfilled with a branch + commits; report the evidence
  (`~/.lobstah/state/<id>.evidence`) and never merge anything yourself.
```

That's the whole integration — the CLI is self-documenting (`lobstah help`)
and its TOON output is built to be read by agents.

## Taking over a worker

Every dispatch **is** a real harness session, running under the same CLI you
use by hand. So the crew is inspectable with tools you already have:

- `lobstah attach <id>` — opens the worker's own session, in its worktree:
  `claude --resume <sessionId>` or `codex resume <threadId>` under the hood.
  Full conversation context survives — ask it "what did you do?", redirect it,
  or keep working in the worktree yourself.
- `lobstah logs <id> --follow` — the normalized event stream, live.
- Session pickers in the harness's own tooling (`claude --resume` with no id,
  the Claude/Codex desktop apps' session lists) show dispatch sessions too —
  they're stored where the harness always stores them.

Attach refuses while a dispatch is `working` (two writers, one session);
follow the logs or `send` instead, or cancel and then attach.

`lobstah swap <id> [--harness codex] [--model ...]` hands an in-flight
dispatch to a fresh session: same worktree, same brief, plus an auto-generated
progress note with the commits so far and any uncommitted changes.
Conversations do not cross harnesses. The worktree is the durable layer, so
the handoff carries everything that matters. Use swap to move work between
subscriptions, escape a rate limit, or re-roll a session that went sideways.

## Tending the string

`lobstah man tend` is the whole-fleet pass — the lobsterman working every trap
in one sweep. It prints a verdict and the story of each piece of work, from a
pure disk read: no forge calls, no tokens.

The verdict distinguishes states that look identical from the outside:

| Verdict | Meaning |
| --- | --- |
| `daemon-down` | No fresh heartbeat — nothing is being supervised. |
| `stalled` | Work queued, capacity free, daemon alive, nothing claiming — actually broken. |
| `needs-attention` | An unanswered `needs-decision`/`blocked` is standing, with its age. |
| `working` | Dispatches active or queued, nothing waiting on a human. |
| `idle` | Everything drained; the quiet is real. |

Below the verdict: counts (queued, active, chores, done/failed last 24h), the
unanswered questions with how long they have waited, and one row per work
item — tracker key, its dispatch chain (original → swaps → review follow-ups),
its PR, the PR's merge-gate status, and any external source the chain is
watching (a ume review session, a CI run). Watches join the same way the
merge view does — from disk. A man-owned watch with unconsumed events counts
as `needs-attention` with its age; a dispatch-owned one annotates its story
(the wake is machinery's job, not the human's). Gate status comes from the [merge
view](pickup.md#merge-view) pickup persists each tick, so PR state is at most
one poll interval stale without tend making a single network call. `--json`
emits the full report for dashboards and scripts to render.

### The periodic report

`lobstah man tend` is the full picture on demand; `lobstah man report` is the
**delta** since the last acknowledged report — catches landed (with their
notes and PRs), attention newly arisen, what still waits, and the fleet
verdict. It advances a "reported through" cursor when it prints — the
explicit acknowledgment — so nothing is ever reported twice, and it says
`no change` when the delta is empty rather than re-dumping state. Standing
unanswered questions appear under `still-waiting` without counting as
change — reminders (`remindSecs`) own re-firing those.

Delivery is at-least-once by construction: the carriers that might not be
read (a `man wait` timeout in a background task) only **peek** at the delta,
so a digest lost with a dead task re-surfaces on the next timeout; only
`man report` (or a hook-delivered park digest, which lands in-context by
construction) marks it handled.

Every carrier shares the cursor (per grounds, for a helm):

- **The wait loop.** A `man wait` timeout (exit 3) prints the delta when
  something changed, so a looping session gets periodic fleet reports for
  free — see the loop idiom below.
- **The park.** A helm session's Stop-hook park delivers the digest as a wake
  at `[helm].reportSecs` cadence — including the landed-then-idle case, where
  the last catches finish and nothing is left in flight to wake for.
- **Direct call.** Anything with a clock — a gateway heartbeat, a cron — runs
  `lobstah man report` and forwards the output when it is not `no change`.
  Escalating a report to a human (a phone push) is the gateway layer's job,
  not lobstah's.

The loop idiom needs no harness scheduler, because the timer is lobstah's own
blocking wait:

```
lobstah man wait --timeout 900
# exit 0 → an event printed; handle it, then loop
# exit 3 → timeout; the delta digest printed above it when something changed
```

A session running this loop reports into its own transcript whether or not a
human is watching — come back later and the transcript is the report.

## Getting woken instead of asked

Three escalation tiers, least to most invasive. All are built on
`lobstah man wait`: block until a dispatch — or a watched external source
(`lobstah watch add`, e.g. a ume review session) — needs attention, print the
event and what to do next, exit. It is **level-triggered for attention
states** — if a `needs-decision` or an unconsumed watch event is already
standing when it starts, it returns immediately — so a gap between one
watcher exiting and the next arming can never lose an event. When no pick
process is running, `man wait` runs due watch checks itself, so watching
works with every service stopped.

**Tier 1 — a push for the human.** Set the daemon's hook and forget it:

```toml
notifyCommand = "ntfy pub my-topic \"$LOBSTAH_VERB $LOBSTAH_ID: $LOBSTAH_NOTE\""
```

**Tier 2 — a background watcher in the liaison session.** The liaison runs
`lobstah man wait` as a background task; when it exits, the harness's task
notification wakes the session, and the printed `next:` line tells the agent
exactly what to do — including re-arming. One watcher per wake is inherent to
background tasks; the level-trigger makes the re-arm race harmless. Add to the
liaison instructions:

```markdown
After dispatching work, run `lobstah man wait` as a background task. When it
completes, follow its `next:` instruction, then re-arm it.
```

**Tier 3 — park the session on a Stop hook (Claude Code only).** A Stop hook
that blocks on `lobstah man wait`, so the session never
really idles — it parks for free and continues the moment something needs it.
What this buys over tier 2 is not the wake. Both wake on events, and both
cost a turn per wake. The difference: the re-arm is **structural instead of
instructed**. Tier 2 works only as long as the model remembers to re-arm the
watcher after every wake. A forgotten re-arm, a crashed watcher, or an
interrupted turn leaves the session deaf until a human speaks. The Stop hook
fires at every turn end, no matter what the model did. Supervision cannot
lapse through instruction drift, and a blind stop mid-shift is impossible.

The hook is a CLI command — `lobstah man haul` (the lobsterman hauls the
trapline; every orchestrator-facing command lives under `lobstah man`).
Install it from the project you'll run the lobsterman in:

```bash
# Easiest: the plugin ships the hooks + the lobsterman skill, no settings
# edits — /plugin marketplace add aequitas-labs/lobstah, then
# /plugin install lobstah@lobstah (Claude Code and Codex v0.114+; Codex asks
# for a one-time hook trust review). Or wire the Claude hook by hand:
lobstah man init            # merges the Stop hook into .claude/settings.local.json
lobstah man init --shared   # …or the committed .claude/settings.json
lobstah man init --global   # …or once into ~/.claude/settings.json — any
                            # directory with a .lobstah-man file then parks
lobstah man init --marker   # also touch .lobstah-man (per-directory gate)
```

Idempotent, and it only appends to `hooks.Stop` — existing hooks and settings
are preserved verbatim. What it writes:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "lobstah man haul", "timeout": 14400 }] }] } }
```

`haul` gates itself twice: only a designated session parks (launch it with
`LOBSTAH_MAN=1 claude`, or `touch .lobstah-man` for a per-directory gate), and
only while dispatches are in flight — conversational turns end free. On an
event it blocks the stop with the event as context and tells the agent the
session re-parks automatically; on timeout or any error it silently allows
the stop, leaving tier 1 as the backstop past the horizon.

Two habits worth adding to a lobsterman session's instructions: run
`lobstah man wait --peek` at session start (a wake consumed by a session that
died mid-handling is still standing state — peek resurfaces it), and treat
the haul context as the work order for that turn.

The trade-offs, honestly. While parked, the turn never ends, so the terminal
shows a running hook. Each wake appends a turn to the context, and long
shifts eventually compact. Without the gate, the hook parks every session in
the project. And parking needs a turn-end hook that
can block and inject a continuation. Claude Code's Stop hook can, and so can
Codex's since its hooks system landed (v0.114+; older Codex only has the
fire-and-forget notify hook, which cannot). Tier 2 is the right default.
Tier 3 is for a dedicated, long-lived liaison session.

**Delivery guarantee.** Attention wakes are at-least-once with backoff. An
unanswered question is reported immediately. While it still stands, it
re-fires as a reminder every `remindSecs` (top-level config, default 900). So
a wake consumed by a session that died mid-handling resurfaces on its own.
Answering ends the reminders naturally, because the answer produces a new
status entry. Set `remindSecs = 0` for pure at-most-once.

**Any-harness fallback — the wrapper loop.** Tiers 2 and 3 lean on Claude
Code features (background-task notifications, the Stop hook). For any other
harness — or no interactive session at all — an outer loop blocking on `wait`
spawns one fresh headless turn per event:

```sh
while out=$(lobstah man wait); do
  codex exec "A dispatch needs attention: $out — handle it with the lobstah CLI."
done
```

Zero tokens between events and works anywhere a shell does; the cost is that
each event gets a fresh context rather than a continuing liaison
conversation.

## The helm: signing on as the orchestrator

Soak enlists workers; `lobstah man helm` enlists the one who dispatches to
them. Sign-on prints the **charter** — the persona and scope fences, written
in Standard Technical English: triage and dispatch but never do the work,
leave running catches to the daemon, judge the catch not the keystrokes, stay
inside your grounds, report deltas not dumps. `man brief` re-injects the
charter at every session start, so it survives restarts and compaction
without anyone re-running anything. A helm registration also arms the
Stop-hook park by itself — no `.lobstah-man` marker, no env var — and gates
the park-delivered digest above.

**One helm per grounds, enforced.** A **grounds** is a named territory: the
subset of configured repos one orchestrator oversees (`[grounds.*]`; with
none configured, one implicit `fleet` grounds covers every repo). A repo
belongs to at most one grounds, so two orchestrators can never dispatch into
the same territory. The registration is one file per grounds — the data model
cannot hold two:

- Sign-on against a **live** foreign holder refuses with guidance;
  `--take` is the only force path, and it is deliberate: the displaced
  session finds a stand-down notice at its next park and stops orchestrating.
- A **stale** holder (heartbeat past `[helm].ttlSecs`) is claimable outright —
  a dead orchestrator holds nothing.
- `lobstah man relieve` steps down; a relieved session never re-takes on its
  own.
- The rule is strict: once a helm is claimed, `man wait` and `man report`
  are reserved for the helm session (identify with `--session`), and no
  other session parks as a lobsterman — those verbs consume the helm's
  wakes and cursor. A grounds-scoped call is stricter still: it belongs to
  that grounds' own helm, never a neighboring one. `man tend`/`man brief`
  stay open to everyone; a stale helm reserves nothing. Workers never run
  `man` verbs at all — their hookless park is `soak --wait`.
- An identified `man wait` heartbeats the helm while it waits (waiting is
  liveness) and defaults its digest to the helm's own grounds.
- Known caveat with multiple helms: event *consumption* in `man wait`/haul
  is fleet-global today — grounds scope the digest, not yet which wakes a
  helm's park eats. Partitioned consumption lands with the addressing
  redesign; until then, run multiple helms with the understanding that
  whoever parks first sees fleet-wide wakes.

## Soaking: a live session volunteers as a worker

Workers are usually traps lobstah sets itself — fresh headless sessions in
fresh worktrees. A **soaking** session is the inverse: an interactive thread
already in the water volunteers to take bait, keeping its warm context, its
visible terminal, and whatever authenticated tooling a headless spawn can't
get.

```bash
lobstah soak --session <id>     # from a worktree — the primary checkout is
                                # never claimable, so sign on from a linked
                                # worktree (git worktree add ../side -b side)
lobstah stow --session <id>     # sign off; an open catch requeues
```

The session id comes from the plugin's session-start brief (`lobstah man
brief` announces it into the conversation). Once soaking, the same Stop hook
that parks a lobsterman parks the worker: at turn end it waits for bait,
claims it, and wakes with the brief. While it works a catch, the park wakes
it for `lobstah send` messages and cancels instead.

Routing follows ownership: `dispatch --for session:<id>` targets one trap;
unaddressed bait for a matching repo prefers a parked trap for
`[soak].deferSecs` before the daemon spawns headless; a watch continuation
for a chain a soaking session claimed is addressed back to that session. A
registration whose heartbeat lapses past `[soak].ttlSecs` is a **ghost
trap** — swept, its catch requeued. Nobody is conscripted: only a session
that ran `soak` ever receives work.

## What the daemon gives your liaison for free

- Parallel work that can't collide — worktree per dispatch.
- A crew that survives crashes: dead runners respawn (bounded), wedged ones
  are killed and forked with a nudge, and everything reconciles from disk
  after a reboot.
- An honest six-verb status contract, validated at the write path, so the
  liaison never has to parse prose to know where things stand.
