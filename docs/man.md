# The lobstah man: a single-liaison session on lobstah

The pattern: you talk to **one** interactive agent — the lobstah man — and it
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
Headless runners preserve new-chain committed work on `origin` as HEAD moves
and open one draft PR when `gh` is available. On a nonterminal stop they
checkpoint eligible worktree files and push once more. A follow-up whose
chain already has a PR keeps that PR and its watch. It does not push or open
a second PR automatically; its worker pushes to the existing PR's head
branch. The final status note names the saved branch, commit, and PR, so the
lobstah man can send a continuation without losing work.

**The helm is harness-agnostic: drive the fleet from whichever session you
prefer.** The contract is the CLI, not the harness — a Claude Code session,
a Codex session (hooks since v0.114), or anything with a terminal via the
foreground loop (`man wait` for the lobstah man, `soak --wait` for workers)
holds the same seat with the same verbs. Workers are equally mixed:
dispatches pick their harness per item (`--harness claude|codex`), so a
Codex helm can run Claude workers and the reverse. Sign-on records which
harness took the helm, and `swap` moves an in-flight dispatch across
harnesses mid-stream — the worktree, not the conversation, is the durable
layer.

## Set it up

1. Install lobstah, configure your repos, start the daemon
   ([README](../README.md#install)). To upgrade: `npm i -g lobstah`,
   `lobstah daemon restart`, `lobstah glass restart`, then the plugin update
   ([README](../README.md#upgrade)).
2. Start an interactive session anywhere and paste this into the project's
   agent instructions (`AGENTS.md` / `CLAUDE.md`), or just say it:

```markdown
You are my liaison for delegated coding work. For any task that should run in
the background, dispatch it with the `lobstah` CLI instead of doing it inline:

- `lobstah dispatch --repo <key> --brief-text "<full brief>"` — returns an id.
  Write briefs that stand alone; the worker has no other context.
- `lobstah status [<id>]`, `lobstah ls` — check progress when I ask, not on a loop.
- `lobstah send <id> "<instruction>"` — steer a live dispatch, add to a queued
  dispatch's inbox, or wake a finished chain as a follow-up. Sending to any
  member of a finished chain follows up its newest member. Use `--no-wake` to
  leave a message in a finished inbox without starting work (nothing reads it).
  A new follow-up accepts `--harness`, `--model`, and `--for wt:<trap>`.
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

A follow-up (`lobstah dispatch --follow-up <id>`) resumes the origin's
conversation and, by default, its worktree too: it runs in the checkout of
the newest dispatch in its chain, on the branch and HEAD where that dispatch
stopped, without a second dependency install. It allocates a fresh worktree
instead when that checkout has uncommitted changes, is gone, or another
dispatch runs in it; its first status note says which (`reusing worktree of
<origin>` or `fresh worktree (<reason>)`). `lobstah catch` prints the
`worktree` a dispatch ran in, and `worktreeOf` when it reused one.
`[limits].reuseWorktree = false` turns reuse off. Normally, use
`lobstah send <id> "<instruction>"` for a continuation: it delivers to the
live or queued member of the chain, or creates a follow-up of the newest
finished member. If that member was last claimed by a trap still signed on,
the follow-up returns to that trap unless `--for` overrides it. Otherwise it
is unaddressed for a headless worker.

Attach refuses while a dispatch is `working` (two writers, one session);
follow the logs or `send` instead, or cancel and then attach.

`lobstah swap <id> [--harness codex] [--model ...]` hands an in-flight
dispatch to a fresh session: same worktree, same brief, plus an auto-generated
progress note with the commits so far and any uncommitted changes.
Conversations do not cross harnesses. The worktree is the durable layer, so
the handoff carries everything that matters. Use swap to move work between
subscriptions, escape a rate limit, or re-roll a session that went sideways.

## Tending the string

`lobstah man tend` is the whole-fleet pass — the lobstah man working every trap
in one sweep. It prints a verdict and the story of each piece of work, from a
pure disk read: no forge calls, no tokens.

The verdict distinguishes states that look identical from the outside:

| Verdict | Meaning |
| --- | --- |
| `daemon-down` | No fresh heartbeat — nothing is being supervised. |
| `stalled` | Work queued, capacity free, daemon alive, nothing claiming — actually broken. |
| `needs-attention` | An unanswered `needs-decision`/`blocked` is standing, with its age. |
| `working` | Dispatches active or queued, nothing waiting on a human. A free-space hold counts here, not as `stalled`. |
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

The work table's `activity` column shows what each live dispatch is doing
now, with its age: `Edit src/a.ts (12s ago)`. It comes from the runner's
event stream (headless) or the post-tool hook (a trap), never from the
worker's reports, so it stays current when the worker forgets to report.
Past `[limits].wedgeThresholdSecs` it reads `stale: … (14m ago)`. A long
silence is shown, not escalated: it raises no attention and no notice. The
worker's verb and note stay the primary line. `lobstah status <id>` prints
the same line as `activity:`, and `lobstah ls` has an `activity` column. See
[Activity](vocabulary.md#activity).

A worker that waits on something outside lobstah (a ume review, a PR
review, a deploy) reports `paused "<note>" --waiting-on review --link <url>`
before it waits. Tend, `status`, `ls`, and the glass then show
`paused: waiting on review` with the link and the time waited. It is a
state, not a question: nothing to answer, no attention, no pet. A paused
headless worker is never counted as wedged and its wall clock stops, but it
still holds a `maxConcurrent` slot while its process is alive. A worker
that reported `done` or `failed` holds no slot: its runner exits within
`[limits].exitGraceSecs`, and a restart of the daemon does not wait for it
(see [status verbs](vocabulary.md#status-verbs)). A paused
trap is kept out of the ghost sweep until `--until` or
`[soak].pausedTtlSecs` (24 hours). See [Waiting on](vocabulary.md#waiting-on).

### PR state after done

A dispatch reports `done` when its PR opens; `report done --pr <url>`
registers a `pr:` watch for the chain so the PR stays observed (see the
PR preset in [vocabulary.md](vocabulary.md#the-pr-preset); `--no-watch`
opts out). What you get depends on what runs:

- **Only the helm park or `man wait`** (no service): PR state badges in
  `man tend`, `lobstah catch`, and the glass (`merged`, `draft`, `review`,
  `checks 1/2 failed`, `conflicts`, `behind`, `green`), and a `pr-merged` / `pr-closed` notice
  when the PR lands. The inline poller observes at `[pickup].pollSecs`
  (default 45 s), one `gh pr view` per PR per cycle, and forks nothing.
- **With `lobstah pick`** (watch-only mode needs no tracker; `lobstah pick
  install` runs it as a service for a steady cadence): all of the above,
  plus CI-fix continuations — a failing check forks the chain with a brief
  naming the PR, the check, its details URL, and the head sha — and
  review-decision continuations for repos `[pickup.github]` doesn't cover.

`gh` must be on PATH and authenticated; if it isn't, the done report still
succeeds and the watch's check records `lastError`.

Which commands register a watch. Only these write points register one:

- `lobstah report <id> done --pr <url>` registers the watch for the PR the
  worker just opened.
- `lobstah watch add <key>` registers the watch you name.
- `lobstah watch backfill --apply` registers watches for PRs in old dispatch
  history. Without `--apply` it only lists them. Nothing runs it for you.

Read commands never register a watch: `catch`, `man tend`, `status`, `ls`,
`prs`, `prs sync`, `attention`, and the glass. They read PR records and
watches that already exist. `prs sync` refreshes existing PR watches only.

The first check of a new watch is a baseline:

- An open PR: the first observation records its checks and merge state, but
  starts no repair. Later observations may start a bounded repair on a PR
  lobstah owns.
- A merged or closed PR: the check records `MERGED` or `CLOSED` in the PR
  record and retires the watch. It forks nothing and raises no attention. A
  `pr-merged` / `pr-closed` notice is posted once only when the PR ended in
  the last 24 hours.

One watch cycle forks at most `[watch].maxForksPerCycle` continuations
(default 3). Generic watches over the cap are held and listed as `held` in
`man tend` and `lobstah watch`. PR repairs wait for the next cycle.
`lobstah watch release <key>` (or `--all`) releases held watches.

For a dispatch-owned PR, the watch repairs conflicts, failed current checks,
and requested review changes. It follows up the newest dispatch in the PR's
chain. A conflict brief names the PR's base branch, including a stacked
base. A check brief names each failed check and its details URL. The watch
records each attempt and stops at `[watch].maxRepairsPerPr` per head SHA.
It does not repair a PR with a person's newer commits or uncertain commit
ownership, a terminal PR, or a PR whose chain already has queued or active
work. `[watch].autoRepair`, `conflicts`, and `checks` control this behavior.

**A repair waits** while any of these is true:

- A live worker holds the PR's head branch. A live worker is an active
  headless dispatch, or a trap with an open catch. It holds a branch when
  its worktree has the branch checked out, when its current branch tracks
  the branch on the remote, or when it pushed the branch during its current
  dispatch. It holds a PR when its evidence names the PR or its chain owns
  the PR.
- A live worker holds the head branch of an open PR below this PR in the
  same stack. The stack is the one the glass shows: a PR's parent is the
  PR whose head branch is its base branch.
- The PR's head, its base branch's head, or its failing checks changed less
  than `[watch].repairSettleSecs` ago (default 600).
- For a checks repair: a fresh read of the latest run of each failing check
  shows that run in progress or passed.
- The PR's watch is held. `lobstah cancel` on a repair dispatch holds its
  PR's watch. `lobstah watch hold <key> [--for <id>] [--reason <text>]`
  holds one PR's watch; with `--for`, the hold ends when that dispatch
  ends. `lobstah watch release <key>` ends any hold.

A waiting repair is recorded on the PR record as `repair.status: waiting`,
with `heldBy` (`wt:<trap>`, `dispatch:<id8>`, `helm`, `hold`, `settle`, or
`checks`) and `reason`. A wait is not an attempt: it does not count against
`[watch].maxRepairsPerPr`. It raises no attention item. `man tend` lists it
in the `repairs waiting` table, the PR badge ends in `repair waits: <heldBy>`,
the glass PR modal shows the reason, and `lobstah doctor` lists it. When the
wait ends, the normal rules apply again.

Lobstah records pushes it sees in the dispatch's evidence (`pushes`): the
runner's own pushes, a headless worker's `git push` commands, and a trap's
`git push` commands (from its post-tool beat). It does not read GitHub to
guess who pushed. A worker that is about to push to other PRs can hold them
first with `lobstah watch hold <key> --for <its dispatch id>`.

Watching a PR nobody dispatched — `lobstah watch add pr:<owner>/<repo>#<n>`
with no `--for` — is how a helm follows a human's PR, or one whose
dispatch chain was culled. Every observation lands in a PR record keyed by
the PR, so it shows in the glass PRs tab and stacks and in tend's `pr:*`
attention kinds exactly like a dispatched PR (its dispatch chain column is
empty). It stays quiet while it's fine: only a failing check or a changes
request surfaces as a watch event; a merge or close arrives as a notice.

**PR order.** Every PR list uses one order: the glass PRs tab, the On deck
PR stacks, `lobstah prs`, and the `stack #…` lines and the `work` table of
`man tend`. Open stacks come first, then finished ones. Within each group, the
stack whose newest PR was first seen last is on top. Within a stack, PRs are
in stack position. A PR sorts by its record's `firstSeenAt`, then by number.
A new observation does not change the order. The order changes when a PR
opens, merges, closes, or changes its base so that it joins or leaves a
stack. When two PRs share a head branch, the parent is the one first seen
last. The attention list is in standing order: the time each condition
started. `observedAt` is shown as the time of the last check.

An observed PR joins tend's attention list by kind. `pr:ready` needs a
mergeable, non-draft PR with no failed, pending, or unknown current checks.
`pr:conflict` and `pr:checks` appear for an owned PR only when repair is off,
blocked, or exhausted; their notes say why. Requested review changes on an
owned PR follow the same repair rule. Unresolved review questions remain
`pr:review` attention. Drafts are not attention by default; users can add
`pr:draft` to `attentionKinds`. The glass and desktop pet use the same list.
See the [attention contract](vocabulary.md#attention-contract). A PR is
something to look at, not a stall: it never flips the verdict to
`needs-attention` and stays out of the digest.

### The spyglass

The lobstah man skill brings up the glass when it takes the helm.
`lobstah man helm` alone does not. `lobstah man relieve` leaves it running.
`lobstah glass stop` stops a detached glass. `lobstah glass install` runs it
as a user service. `lobstah glass restart` restarts the service, or a
detached glass (stop, then `--detach`).

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
the arm command. The hook first waits up to `[helm].armGraceSecs` (5 s) for a
watcher that is still starting, so arming and ending the turn at once is safe.
`man haul --park` or `[helm].park = "block"` makes the hook
wait for attention itself. Without a Stop hook, use the
[foreground loop below](#without-a-plugin).

The hook is a CLI command — `lobstah man haul` (the lobstah man hauls the
trapline; every orchestrator-facing command lives under `lobstah man`).
Install it from the project you'll run the lobstah man in:

```bash
# Easiest: the plugin ships the hooks + the man and trap skills, no settings
# edits — install steps per harness in docs/harness/claude-code.md and
# docs/harness/codex.md. Or wire the Claude hook by hand:
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

**The pet's read.** Every six seconds the pet runs `lobstah attention --json`.
It prints `{ "attention": [...] }`: the same items, with the same fields, that
`man tend --json` puts under `attention`, and nothing else. If that command
fails (an older CLI exits 2 on the unknown flag), the pet runs
`man tend --json` instead. The pet reads the child's output while the child
runs, so a report of any size works. Each read may take 10 seconds; then the
pet stops the child and keeps its current windows. After three failed reads in
a row it writes one line with the reason to `~/.lobstah/logs/pet.log`, and one
more line when reads work again. After every read it writes
`~/.lobstah/pet/state.json`. `lobstah doctor` reads that file for its `pet`
row: installed or not, running or not, and whether the last read worked:

```
pet  ok    installed; running (pid 812); last read worked 4s ago (`lobstah attention --json`, 3 walking)
pet  warn  installed; running (pid 812); last read failed 2s ago, 3 in a row: `lobstah attention --json` timed out; `lobstah man tend --json` timed out; last worked 5m ago
```

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

### Without a plugin

Run the CLI sequence directly:

```bash
lobstah man helm --session <id>
lobstah man wait --session <id> --timeout 900
lobstah dispatch --repo myapp --brief ./brief.md
lobstah man tend
lobstah glass
lobstah man relieve --session <id>
```

Without a hook, run `man wait` in the foreground and loop on it after each
event or timeout.

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

The lobstah man skill prints the glass URL. `[glass].port` sets the port;
`LOBSTAH_GLASS_PORT` takes precedence.

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
  other session parks as a lobstah man — those verbs consume the helm's
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
- The wake cursor starts at sign-on. When `man helm` signs on and the
  grounds has no live helm, notices and watch events recorded before the
  sign-on are not wakes: they were delivered to nobody, and they are not
  news. `man tend` and the glass Notices tab still list them. Standing
  attention still wakes: an unanswered `needs-decision` or `blocked`, a
  free-space hold on queued dispatches, a failing watch. The `man report`
  digest also starts at the sign-on. A `--take` from a live helm keeps that
  helm's cursor, so nothing in flight is dropped.

## Soaking: a live session volunteers as a worker

Workers are usually traps lobstah sets itself — fresh headless sessions in
fresh worktrees. A **soaking** session is the inverse: an interactive thread
already in the water volunteers to take bait, keeping its warm context, its
visible terminal, and whatever authenticated tooling a headless spawn can't
get.

```bash
lobstah soak                    # in a linked worktree: sign it on; in a
                                # repo's primary checkout: create a linked
                                # worktree and sign that on
                                # (the id: --session, else hook stdin, else
                                # $CLAUDE_CODE_SESSION_ID)
lobstah soak --repo <key>       # outside any configured repo: create a
                                # worktree for <key> and sign it on
lobstah soak --wait             # hookless sessions: listen in the foreground
                                # (re-runs need no flags — identity is the
                                # worktree, else the session id); exit 3 =
                                # quiet, run it again
lobstah stow                    # sign off; an open catch requeues, unread
                                # messages bounce back to the helm; removes
                                # the worktree when soak created it
lobstah stow --keep             # sign off and keep the worktree
lobstah soak --name amber-gull  # choose or change this trap's two-word name
```

**Soak can create the worktree.** From a repo's primary checkout, or with
`--repo <key>` from outside any configured repo, soak creates a linked
worktree the same way a dispatch does. It fetches trunk, adds
`~/.lobstah/worktrees/soak-<trap>` on a new branch `lobstah/soak-<trap>`
from `origin/<trunk>`, and runs the repo's `setup` commands. Without
`--repo`, soak run outside a configured repo fails with an error that names
`--repo`. In a linked worktree, `--repo` must match that worktree's repo.
Soak prints `worktree: <path>`, `created: true`, and `branch:`. When the
session is not inside the worktree, it also prints
`instruction: cd <path> and work in that directory from now on`, and its
help lines carry `--session <id>`. The session changes into that directory
before it takes work. If creation fails (setup fails, the
`[limits].minFreeGB` check fails, or trunk cannot be fetched), soak signs
nothing on, removes the partial worktree and its branch, and prints the
cause. The address is `wt:<trap>`. The registration records
`createdWorktree: true`, and `.lobstah-trap` records `createdBy: "soak"`,
the session id, the repo, and the branch.

Soak is idempotent. A session that already mans a trap re-uses it when it
runs `soak` or `soak --wait` outside a linked worktree: the trap is resolved
from the session id, and no second worktree is created. A worktree that soak
created for the same session and repo is also re-used after a ghost sweep.
From outside the worktree, `soak --wait`, `report`, and `stow` find the
trap by session id (`--session <id>`, or `$CLAUDE_CODE_SESSION_ID`), and
`send session:<id>` addresses it. With `--session`, or from inside the worktree, `report done` records the
worktree's HEAD commit and branch in evidence.

`stow` removes a worktree only when soak created it and nothing in it exists
elsewhere. It keeps the worktree and prints `worktree: kept` and a `reason:`
when soak did not create the worktree, or when the worktree has uncommitted
changes, untracked files that are not ignored, or commits on no remote
branch. Ignored files do not block removal. Stow never forces a removal.
Stow runs the removal from the primary checkout, so it works from inside
the worktree. On removal it prints `worktree: removed`, `path:`, and
`returnTo: <primary checkout>`, with a help line `cd <primary>`. It
deletes the branch only when every commit on it is on its upstream (with no
upstream: on some remote branch);
otherwise it prints `branchKept: <branch> (<reason>)`. A deleted branch
prints as `branchDeleted:`. `stow --wt <id>` follows the same rules. The
SessionEnd hook (`lobstah stow --quiet`) signs off and keeps the worktree.

**Identity is the worktree.** Sign-on anchors a short trap id and two-word
name in `.lobstah-trap` and prints both, such as `amber-gull (wt:c32a245d)`; the address
survives session restarts — a new session in the same worktree resumes the
same trap (a *live* foreign session is refused: the session lock). The
name is reserved across all traps known to this lobstah home, including
stowed and swept traps. `--name` sets or changes it; malformed and taken
names are refused. The bare name, `wt:<name>`, and `wt:<id>` all address the
same live trap in `dispatch --for`, `send`, and `stow --wt`. Unknown names
list known names and never turn addressed bait into headless work. The id
remains the key in dispatch and claim records.

The session id (from the plugin's session-start brief) lives inside the
registration as the liveness principal. The harness (claude or codex) is
inferred — from `CLAUDE*` / `CODEX*` in the environment, and when both are
set (one harness launched inside the other) from the session id's format:
Codex thread ids are UUIDv7, Claude Code session ids UUIDv4 — and
`--harness` overrides; an undecidable case refuses rather than guessing.
Once soaking, the same Stop hook
that parks a lobstah man parks the worker: at turn end it delivers messages
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

A soaking session proves it is alive three ways: its park heartbeat, its
reports, and its **beat**. The plugin's post-tool hook runs
`lobstah soak beat` after tool calls: at most once per 30 seconds it
refreshes the trap's beat and writes the claimed catch's activity. The hook
resolves the trap from the working directory, else from the session id. A
trap that works for an hour without reporting is not swept while it beats.
`[soak].beat = false` turns the hook off.

Liveness has two failure shapes with two remedies: a registration that
parked before and went quiet (no park, report, or beat) past `[soak].ttlSecs` is a **ghost trap** —
swept, catch requeued, noticed, its worktree kept; one that **never parked** is a **defective
enlistment** — noticed with its diagnosis (usually a missing Stop hook →
`soak --wait`) and left standing so the address keeps protecting its work.
Nobody is conscripted: only a worktree whose session ran `soak` ever
receives work.

### Culling and disk space

Worktrees are 1 to 8 GB each. `lobstah cull` sweeps what is finished: `done/`
entries older than the window (`--older-than <days>`, default 14), worktrees
whose dispatch is finished or gone, stale state files, merged or closed PR
records, and orphaned acks. It never touches queued or active work, and
`git worktree remove` keeps each dispatch's branch. A worktree that soak
created counts as in use while a trap registration anchors it. After that,
the cull and the daemon's retention and free-space culls treat it like any
other worktree that no dispatch owns: it ages out after
`[limits].retentionDays`. A worktree that follow-ups
reused is one worktree shared by the chain: it stays while any dispatch in
the chain is queued or active, and it ages from the newest dispatch that
used it.

Without `--apply` it is a dry run: it measures each target and prints the
sizes. A worktree is measured with one `du -sk`; where `du` is missing
(Windows) a file walk measures it instead. `--apply` measures nothing. It
deletes, then prints the count and the change in free space on the worktrees
volume.

```
$ lobstah cull
cull[2]{kind,id,ageDays,bytes}:
  done,6a1f…,21,4120
  worktree,6a1f…,21,3221225472
totalBytes: 3221229592
total: 3 GB
dry run — pass --apply to remove
```

The daemon can do this on its own. Two `[limits]` keys turn it on
([configuration](configuration.md#limits)); both are off by default:

- `retentionDays` — once an hour at most, the daemon culls finished
  dispatches older than this, 10 at a time. A dispatch whose PR is still open
  is kept.
- `minFreeGB` — before it claims work (each claim creates a worktree), the
  daemon reads free space on the worktrees volume. Below the limit it removes
  finished worktrees, oldest first, until the limit is met. If space is still
  short, the work stays queued. `man tend` shows it as
  `held (3.2 GB free, needs 10 GB)`, the glass shows the same reason in the
  note column, and one `disk-held` notice reaches the helm. When space
  returns, one `disk-cleared` notice follows and claiming resumes.

A third key, `releaseOnMerge`, frees a worktree as soon as its PR merges
instead of waiting out `retentionDays`. When a PR watch records `merged`, the
next cull pass removes the worktree of the dispatch that owns the PR and of
every dispatch in its follow-up chain that ran on that PR. It checks first:
every dispatch in the chain is finished, the worktree is clean, and its HEAD
is on the remote after a fetch. A worktree that fails a check is kept and
listed as `kept: unpushed work`. A PR closed without merge releases nothing,
and a trap's worktree is never released. Branches and the dispatch record
stay; `lobstah catch` says `worktree: released on merge (<time>)`. One
`worktree-released` notice per pass lists what went.

`lobstah doctor` prints a `disk` row: free space on the worktrees volume, the
limits, the count and age of the worktrees a cull could remove, and any
merged PR's worktree that `releaseOnMerge` kept, with the reason:

```
disk  warn  412.3 GB free on ~/.lobstah/worktrees; minFreeGB 10; retentionDays 14; 3 cullable worktree(s), oldest 9d; releaseOnMerge on; kept: unpushed work (1 worktree(s) of merged PRs: 6a1f0c2e HEAD is not on the remote)
```

## What the daemon gives your liaison for free

- Parallel work that can't collide — worktree per dispatch.
- A crew that survives crashes: dead runners respawn (bounded), wedged ones
  are killed and forked with a nudge, and everything reconciles from disk
  after a reboot.
- An honest six-verb status contract, validated at the write path, so the
  liaison never has to parse prose to know where things stand.
