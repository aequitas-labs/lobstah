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

**The helm is harness-agnostic: drive the fleet from whichever session you
prefer.** The contract is the CLI, not the harness — a Claude Code session,
a Codex session (hooks since v0.114), or anything with a terminal via the
foreground loop (`man wait` for the lobsterman, `soak --wait` for workers)
holds the same seat with the same verbs. Workers are equally mixed:
dispatches pick their harness per item (`--harness claude|codex`), so a
Codex helm can run Claude workers and the reverse. Sign-on records which
harness took the helm, and `swap` moves an in-flight dispatch across
harnesses mid-stream — the worktree, not the conversation, is the durable
layer.

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

### PR state after done

A dispatch reports `done` when its PR opens; `report done --pr <url>`
registers a `pr:` watch for the chain so the PR stays observed (see the
PR preset in [vocabulary.md](vocabulary.md#the-pr-preset); `--no-watch`
opts out). What you get depends on what runs:

- **Only the helm park or `man wait`** (no service): PR state badges in
  `man tend`, `lobstah catch`, and the glass (`merged`, `draft`, `review`,
  `checks 1/2 failed`, `green`), and a `pr-merged` / `pr-closed` notice
  when the PR lands. The inline poller observes at `[pickup].pollSecs`
  (default 45 s), one `gh pr view` per PR per cycle, and forks nothing.
- **With `lobstah pick`** (watch-only mode needs no tracker; `lobstah pick
  install` runs it as a service for a steady cadence): all of the above,
  plus CI-fix continuations — a failing check forks the chain with a brief
  naming the PR, the check, its details URL, and the head sha — and
  review-decision continuations for repos `[pickup.github]` doesn't cover.

`gh` must be on PATH and authenticated; if it isn't, the done report still
succeeds and the watch's check records `lastError`.

Watching a PR nobody dispatched — `lobstah watch add pr:<owner>/<repo>#<n>`
with no `--for` — is how a helm follows a human's PR, or one whose
dispatch chain was culled. Every observation lands in a PR record keyed by
the PR, so it shows in the glass PRs tab and stacks and in tend's `pr:*`
attention kinds exactly like a dispatched PR (its dispatch chain column is
empty). It stays quiet while it's fine: only a failing check or a changes
request surfaces as a watch event; a merge or close arrives as a notice.

An observed PR joins tend's attention list by kind — `pr:draft`,
`pr:review` (unresolved threads or changes requested), `pr:checks` (a red
head), `pr:ready` (approved or all green) — so it crawls in the glass and
the desktop pet until its clear condition holds; clicking it opens the PR.
`pr:review` and `pr:checks` stay off the screen while a worker already owns
them (a pickup feedback round or the watch's fix continuation in flight).
`attentionKinds` in `config.toml` picks the kinds; `landed` is opt-in. See
the [attention contract](vocabulary.md#attention-contract). A PR is
something to look at, not a stall: it never flips the verdict to
`needs-attention` and stays out of the digest.

### The spyglass

`lobstah glass [--port <n>]` serves tend as a live web page on 127.0.0.1
(default port 4949): the fleet verdict and attention questions, every
dispatch with its full brief, status log, inbox, and evidence, each trap
with its lifecycle notices, message history, and catches, the notices
tail, the merge view, and watches — with filters, a table/cards toggle,
and the helm identified by name. It is strictly read-only and consumes no
cursor: looking through the glass changes nothing, so it needs no helm and
threatens nothing. Links out are copyable commands (`lobstah attach`,
`claude --resume`), never click-to-exec — localhost HTTP is reachable by
any webpage, so the glass exposes no endpoint that acts. The ⚙ popover's two
preferences — table or cards, and whether lobsters crawl the page — are
per-browser, kept in that browser's localStorage and never on disk.

This is where "is the agent alive?" belongs: the helm's heartbeat age on a
page, not periodic proof-of-life turns in a transcript.

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
- **The blocking park.** A helm session's Stop-hook park delivers the digest as a wake
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

After `man helm`, run `lobstah man wait --session <id> --timeout 900` as a
background task and re-arm it after each completion. The wait registers a
heartbeating watcher for the session and exits with an event or a timeout
(exit 3). At turn end, `man haul` blocks with standing attention; in arm mode,
work in flight allows a stop with a live watcher and otherwise blocks with
the arm command. `man haul --park` or `[helm].park = "block"` makes the hook
wait for attention itself. Without a Stop hook, run `man wait` in the foreground.

The hook is a CLI command — `lobstah man haul` (the lobsterman hauls the
trapline; every orchestrator-facing command lives under `lobstah man`).
Install it from the project you'll run the lobsterman in:

```bash
# Easiest: the plugin ships the hooks + the lobsterman and trap skills, no settings
# edits — /plugin marketplace add aequitas-labs/lobstah, then
# /plugin install lobstah@lobstah (Claude Code and Codex v0.114+; Codex asks
# for a one-time hook trust review). Or wire the Claude hook by hand:
lobstah man init            # merges the Stop hook into .claude/settings.local.json
lobstah man init --shared   # …or the committed .claude/settings.json
lobstah man init --global   # …or once into ~/.claude/settings.json — any
                            # directory with a .lobstah-man file then uses the hook
lobstah man init --marker   # also touch .lobstah-man (per-directory gate)
```

Idempotent, and it only appends to `hooks.Stop` — existing hooks and settings
are preserved verbatim. What it writes:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "lobstah man haul", "timeout": 14400 }] }] } }
```

`haul` applies to a signed-on helm or trap, or a session opted in with
`LOBSTAH_MAN=1` or `.lobstah-man`. Queued dispatches count as work in flight.

**Delivery guarantee.** Attention wakes are at-least-once with backoff. An
unanswered question is reported immediately. While it still stands, it
re-fires as a reminder every `remindSecs` (top-level config, default 900). So
a wake consumed by a session that died mid-handling resurfaces on its own.
Answering ends the reminders: a message to the dispatch newer than its
question — `lobstah send`, a forwarded tracker comment, anything written
through the inbox with provenance — means the question no longer stands, even
before the worker reads it; `man tend` then shows the dispatch as
`needs-decision (answered <n>m ago)` instead of listing it under attention.
A newer `needs-decision` from the worker stands again. Set `remindSecs = 0`
for pure at-most-once.

**Acknowledging, display-only.** Clicking a desktop pet opens its target and
runs `lobstah attention ack <item-key> --by pet`, so that pet stops walking
the item until its state changes (a new status entry, head, failed check, or
thread count). The ack changes only what the pet and the glass lobs display:
`man tend --json` still lists the item (marked `acked`), and `man wait`, the
park, and reminders ignore acks entirely — a human having seen a question
must never hide it from the orchestrator that has to answer it. The glass,
which has no write endpoint, hides a clicked lob per browser in localStorage
instead.

**Wrapper loop.** An outer loop blocking on `wait` can spawn one fresh
headless turn per event:

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
without anyone re-running anything. A helm registration enables the
Stop hook by itself — no `.lobstah-man` marker, no env var — and
gates the digest above.

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
  are reserved for the helm session (identified by `--session`, else hook
  stdin, else `$CLAUDE_CODE_SESSION_ID` — inside Claude Code no flag is
  needed; a refusal names the id it resolved and from where), and no
  other session parks as a lobsterman — those verbs consume the helm's
  wakes and cursor. A grounds-scoped call is stricter still: it belongs to
  that grounds' own helm, never a neighboring one. `man tend`/`man brief`
  stay open to everyone; a stale helm reserves nothing. Workers never run
  `man` verbs at all — their hookless park is `soak --wait`.
- An identified `man wait` heartbeats the helm while it waits (waiting is
  liveness) and defaults its digest to the helm's own grounds.
- Consumption is grounds-partitioned: a helm's `man wait` and park consume
  only events and notices for its own grounds' repos (events whose repo is
  unknowable stay visible to all helms). Two helms never eat each other's
  wakes.

## Soaking: a live session volunteers as a worker

Workers are usually traps lobstah sets itself — fresh headless sessions in
fresh worktrees. A **soaking** session is the inverse: an interactive thread
already in the water volunteers to take bait, keeping its warm context, its
visible terminal, and whatever authenticated tooling a headless spawn can't
get.

```bash
lobstah soak                    # from a worktree — the primary checkout is
                                # never claimable, so sign on from a linked
                                # worktree (git worktree add ../side -b side)
                                # (the id: --session, else hook stdin, else
                                # $CLAUDE_CODE_SESSION_ID)
lobstah soak --wait             # hookless sessions: listen in the foreground
                                # (re-runs need no flags — identity is the
                                # worktree); exit 3 = quiet, run it again
lobstah stow                    # sign off; an open catch requeues, unread
                                # messages bounce back to the helm
```

**Identity is the worktree.** Sign-on anchors a short trap id in
`.lobstah-trap` and prints the trap's address (`wt:<id>`); the address
survives session restarts — a new session in the same worktree resumes the
same trap (a *live* foreign session is refused: the session lock). The
session id (from the plugin's session-start brief) lives inside the
registration as the liveness principal. The harness (claude or codex) is
inferred — from `CLAUDE*` / `CODEX*` in the environment, and when both are
set (one harness launched inside the other) from the session id's format:
Codex thread ids are UUIDv7, Claude Code session ids UUIDv4 — and
`--harness` overrides; an undecidable case refuses rather than guessing.
Once soaking, the same Stop hook
that parks a lobsterman parks the worker: at turn end it delivers messages
first, then claims bait and wakes with the brief. While it works a catch,
the park wakes it for `lobstah send` messages and cancels instead.

Routing follows ownership, and **addressed work is sticky**:
`dispatch --for wt:<trap>` waits for that trap and never falls back to a
headless spawn — if the trap ghosts, the orphan surfaces as a helm notice
(re-address, release, or cancel; `cancel` finalizes unclaimed queue items
with an audit record). Delivery stamps a receipt into evidence. Unaddressed
bait for a matching repo prefers a parked trap for `[soak].deferSecs`, then
the daemon spawns headless. Conversational steering goes through
`send wt:<trap> "..."` — a message, not bait: no branch, no catch, sender
stamped, bounced to the helm when undeliverable.

Liveness has two failure shapes with two remedies: a registration that
parked before and went quiet past `[soak].ttlSecs` is a **ghost trap** —
swept, catch requeued, noticed; one that **never parked** is a **defective
enlistment** — noticed with its diagnosis (usually a missing Stop hook →
`soak --wait`) and left standing so the address keeps protecting its work.
Nobody is conscripted: only a worktree whose session ran `soak` ever
receives work.

## What the daemon gives your liaison for free

- Parallel work that can't collide — worktree per dispatch.
- A crew that survives crashes: dead runners respawn (bounded), wedged ones
  are killed and forked with a nudge, and everything reconciles from disk
  after a reboot.
- An honest six-verb status contract, validated at the write path, so the
  liaison never has to parse prose to know where things stand.
