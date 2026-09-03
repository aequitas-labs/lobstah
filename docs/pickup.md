# Pickup — tracker add-on

**Local work pickup from Linear and GitHub, without webhooks.**

Pickup is a poll loop that runs beside the daemon. It polls trackers outbound,
translates matching items into queue descriptors, translates state files back
into tracker updates, and — where enabled — merges approved PRs. It is the
fourth caller: core never learns it exists.

```
Linear / GitHub  <──poll──  apps/pick  ──writes──>  queue/
                 <──report──            <──reads───   state/  evidence  events
```

---

## Why polling is the product, not the compromise

Every existing tracker-driven agent needs inbound networking — OAuth apps plus
a tunnel, often sold as the hosted tier's headline feature. A webhook target
cannot run on a laptop behind NAT that sleeps.

A poll loop has zero inbound surface. No listener, no tunnel, no public
exposure. Offline means it doesn't poll; wake means it catches up. Latency is
the poll interval — 30–60 seconds against tasks measured in minutes.

This is the queue contract's own rule applied one layer up: watch as an
optimization, poll as the guarantee.

## Boundary

Pickup holds tracker credentials, so it lives in `apps/`, never `packages/core`
— the same rule that governs the bridge and the node plugin. Core stays free of
network, OAuth, and tracker vocabulary.

**Secrets never live in the config file.** Each source configures a token
*source*, in precedence order: `tokenCommand` (exec'd and cached ~5 minutes —
the fit for hourly-expiring GitHub App installation tokens, e.g. a
`gh-app-token.sh`-style minting script), `tokenFile` (read per call, so
rotation just works), or `tokenEnv` (read per call, so a wrapper can refresh
it). This mirrors OpenClaw's own secret-reference pattern: config carries a
reference, never the secret.

**Notifications are a hook, not a vendor.** `notifyCommand` under `[pickup]`
is exec'd on every verb transition with `LOBSTAH_KEY`, `LOBSTAH_UUID`,
`LOBSTAH_VERB`, `LOBSTAH_NOTE`, and `LOBSTAH_PR_URL` in the environment —
fire-and-forget, never blocking the loop. Point it at whatever the host
already has (a Slack helper, `openclaw message send`); lobstah stays free of
messaging vendors.

**No LLM in the loop.** Issue-to-descriptor translation is mechanical. Judgment
about an ambiguous issue belongs to the dispatched agent, which reports
`needs-decision` — not to pickup. Fleet setups that wake an LLM to poll a
tracker pay tokens for a mechanical translation; a deterministic program is
the right tool, and it keeps token cost proportional to real work.

---

## Architecture

```
apps/pick/
  sources/
    linear/        # API key or OAuth app actor token
    github/        # PAT or GitHub App installation token
  loops/
    dispatch/      # issues + review feedback → descriptors
    reconcile/     # tracker state ⟷ lobstah state, both directions
    merge/         # opt-in: merge approved PRs, dispatch rebases on conflict
```

One source interface, four methods:

```ts
interface Source {
  poll(): WorkItem[]                    // items matching the pickup rules
  claim(item: WorkItem): boolean        // tracker-side state transition
  report(id: string, verb: Verb, evidence: Evidence): void
  inbound(id: string): Message[]        // new human comments since last poll
}
```

A source translates tracker vocabulary to lobstah vocabulary and nothing else.
The three loops are tracker-agnostic and drive whichever sources are configured.

---

## Dispatch loop

### Pickup rules

| Rule | Trigger | Descriptor |
|---|---|---|
| Issue pickup | Assigned to the configured identity, in the configured start state | Implementation brief from the issue |
| Review pickup | Open PR authored by the configured identity with `CHANGES_REQUESTED`, or a human review newer than HEAD | Address-review brief from the feedback |

A review dispatch sets `followUp` to the implementation dispatch's UUID,
forking that session so the feedback lands on the context that made the
choices. A rebase chore starts cold on purpose — the conflict is about commits
the original session never saw.

### Claiming

The tracker-side state transition is the cross-machine mutex. Moving the issue
to In Progress (or applying a claim label) is pickup's atomic rename: two
machines polling the same workspace cannot double-dispatch, because exactly one
claim succeeds.

Pickup owns the mapping from tracker item to dispatch UUID, in its own state
directory. This is the design's rule — whoever dispatched holds the mapping — and
it is what lets `report` and `reconcile` correlate without anything on the
tracker knowing lobstah's identifiers.

### Routing and briefs

The descriptor's `repo` key resolves from config. The tracker never carries
machine detail:

```toml
[pickup.linear]
assignField = "delegate"             # agent token: Linear assigns agents via delegate
startState  = "Todo"
route       = { ENG = "myapp" }      # team key → repo key
```

GitHub routing needs no map: with no `repo` named in `[pickup.github]`, every
`[repos.<key>]` that opted in with `pickup = true` and has a GitHub `origin`
is polled, and the repo key doubles as the routing key. Opt-in is explicit —
being configured for dispatch never makes a repo pickable by itself.

The brief is assembled from the item — title, description, comments to date —
through an optional per-repo template. The issue is the durable instruction's
source; `brief.md` in `active/<uuid>/` remains the durable instruction itself.

### Reporting

Six verbs map to tracker vocabulary. The mapping is per-source and total — a
verb with no mapping is a config error at startup, not a silent drop.

| Verb | Linear (default) | GitHub (default) |
|---|---|---|
| `working` | In Progress + progress comment | comment |
| `needs-decision` | comment + `needs-human` label | comment + label |
| `blocked` | comment + `blocked` label | comment + label |
| `paused` | comment | comment |
| `done` | attach PR link, move to In Review | comment with PR link |
| `failed` | comment with evidence, back to Todo | comment with evidence |

### Inbox bridging

`inbound()` turns new human comments on a claimed item into
`inbox/<uuid>/NNN.msg` records. The tracker becomes the steering surface: a
comment on the Linear issue reaches the running agent through the same
between-turns delivery as any other inbox message — tracker-native steering
with none of the webhook plumbing.

---

## Watch loop

Pick's third loop family: standing outbound polls on anything external with
a CLI that can answer "anything new since cursor N?" — a ume review session,
a CI run. Registration goes through `lobstah watch add <key> --check <cmd>`
(the validated write path; the check contract and word set live in
[vocabulary.md](vocabulary.md#watch-contract)):

```bash
# an interactive session pushes a plan for review, then stops blocking on it
lobstah watch add ume:9f2c --check 'ume events 9f2c --since {cursor} --json'

# a worker pauses on a review round; events fork a continuation of its chain
lobstah watch add ume:9f2c --check '...' --for <dispatch-uuid>
```

Each cycle: run due checks (cadence = `[pickup].pollSecs`, or `--every` per
watch), append events, deliver by owner. Man-owned events surface through
`man wait`/`man haul` and fire `notifyCommand` with verb `watch`;
dispatch-owned events enqueue a continuation that forks the latest session
in the owning chain — one in flight per watch, later rounds buffer. With no
tracker sources configured, `lobstah pick` still runs in watch-only mode.
`man wait` runs due checks itself when no pick process is stamping them, so
watches work with every service stopped.

**Streams — the latency optimization.** `--stream <cmd>` names a long-lived
process (spawned with `{cursor}` substituted) that emits the same event
objects as NDJSON lines, plus bare `{"cursor": "N"}` checkpoints. Pick holds
one child per streaming watch and delivers each line the moment it arrives —
milliseconds instead of the poll interval. The queue contract's rule applies
one layer up: **watch as an optimization, poll as the guarantee** — appends
dedupe by `seq`, so the cadence check re-seeing a streamed event is a no-op,
and a dead stream just means cadence-only until the next cycle respawns it.
Stream and cadence events feed one serialized executor, so pick's state stays
single-writer. The daemon completes the fast path: it fs.watches the queue
directories, so a continuation enqueued by a stream event is claimed in
milliseconds too — end to end, an external event reaches a spawning session
in roughly harness start-up time.

## Merge loop

Opt-in, per repo, off by default. Merging is policy, not mechanics, so it ships
disabled and its config is explicit about who qualifies.

```toml
[pickup.github.merge]
enabled          = true
method           = "squash"
approvers        = ["alice"]        # the floor: always qualify, on every PR
assigneeApproves = true                # PR assignees also qualify…
restrictedLabels = ["risk:high"]       # …except on PRs carrying any of these labels
scope            = "own"               # only PRs authored by the configured identity
```

**Who qualifies is monotone by construction.** The qualifying set is
`approvers`, plus the PR's assignees when `assigneeApproves` is on and no
restricted label is present. A restricted label collapses the set to
`approvers` — labels revoke the assignee relaxation, they never grant, replace,
or subtract from the floor. Multiple restricted labels therefore compose
trivially (any one collapses), and no label combination can make a PR
unmergeable by everyone. If a label ever needs its own named approvers, that is
a future *additive* grant key, not a replacement — replacement is how a policy
locks itself out.

The loop's doctrine, in full:

- **Re-validate at the moment of merge, not at the poll tick.** State shifts
  between observation and action; the gate check runs against a fresh fetch
  immediately before the merge call. Any failure aborts and reports — never
  merge on stale data.
- **Trust the forge's merge-state rollup.** GitHub's `mergeStateStatus` already
  encodes required-check semantics — `BLOCKED` means a required check failed,
  `UNSTABLE` means only non-required checks failed and GitHub itself would
  allow the merge. Re-implementing check-pass logic client-side is how you
  drift from the forge's own rules.
- **Dedup by approval, not by PR.** A specific approval merges at most once; a
  new push invalidates it and the gate waits for a fresh one.
- **Stacks merge through the forge's stack-aware path.** A PR in a native
  stack goes through GitHub's asynchronous stack merge API; a standalone PR
  through the ordinary merge call. `method` is per repo and applies to both.
- **`scope = "own"` is the safety default.** Pickup merges work it dispatched.
  Widening to human-authored PRs is a deliberate config change.

### Conflicts dispatch, cleanly-behind updates

A PR behind its base splits deterministically:

| Condition | Action |
|---|---|
| Behind, no conflict | Update the branch through the forge API, re-enter the gate next tick |
| Behind, real conflict | Write a rebase chore — brief: rebase onto base, resolve, push — and re-enter the gate when it completes |

Rebase chores go through the **chore lane** (`~/.lobstah/chores/`, defined in
the [design's queue contract](design.md#queue-contract)), never the primary queue. Same descriptor schema,
same daemon, same supervision — but their own directories and their own
concurrency budget, so machine-generated maintenance can't crowd the work
queue, and `lobstah ls` stays a list of things a human asked for.

Chores report to no tracker. The merge loop consumes the chore's status file
directly, holds its own PR-to-chore mapping, and bounds the attempt at one: a
failed rebase comments on the PR, applies the `needs-human` label, and stops.
The doctrine stays whole — the deterministic program handles everything
mechanical, and the moment resolution requires judgment it becomes a
supervised dispatch. It just doesn't become *work*.

---

## Reconciliation loop

The daemon owns dead and wedged *processes*. It cannot own tracker drift — an
item that claims In Progress while nothing anywhere backs it is invisible to a
component that, by design, has no tracker knowledge. The classification rule
holds one layer up: absence of signal never means fine.

Every poll, diff both directions:

| Drift | Detection | Action |
|---|---|---|
| Orphaned item | In Progress, attributed to pickup, no live or completed UUID behind it | Comment, reset to the start state |
| Orphaned dispatch | UUID active for an item now closed, reassigned, or de-scoped | Cancel the dispatch, note it in evidence |
| Lost report | Dispatch `done`/`failed`, tracker never updated | Replay the report — the state file is the durable record, the tracker write is the retryable notification |

An orphan verdict requires a trustworthy mapping — see
[Pickup state](#pickup-state): a missing table entry is `unknown` and triggers
a rebuild, never a reset.

**Residual, by honesty:** same-machine reconciliation cannot detect
whole-machine death — the reconciler dies with the laptop. The stale
`executor.json` heartbeat covers that case, but only for a remote reader — a
second machine's pickup, or a remote dispatcher. This is parity with the
cron-script fleets it replaces, whose watchers also died with their host.

---

## Merge view

The merge loop is already fetching the forge's view of every candidate PR each
tick — so it persists what it saw (`pickup/merge-view.json`): per open PR the
head sha, mergeable state, and gate verdict (`waiting-approval`,
`behind-updated`, `conflict-chore:<uuid>`, `rebase-failed`, `blocked`,
`draft`), and per PR that *left* the open set, its disposition — one extra
lookup answers whether it merged or closed, so "merged in the last 24h" is
complete even when a human pressed the button.

This is what lets a status view report PR state without its own forge calls:
`lobstah man tend` and any dashboard read the file, at most one poll interval
stale. Observational, not load-bearing — deleting it loses nothing but
history. It exists only where the merge loop runs (merge enabled).

---

## Pickup state

Pickup's own state — the tracker-item-to-UUID mapping the loops correlate
through, the merge loop's PR-to-chore table, per-source poll cursors — lives
under `~/.lobstah/pickup/`, written with the same atomic-rename discipline as
everything else on disk.

The mapping is load-bearing for all three loops, so it gets durability by
design rather than by trust:

- **Reconstructible.** Every report comment pickup writes to a tracker embeds
  the dispatch UUID. A lost table rebuilds from the tracker trail plus
  `state/` — the durable-record, retryable-notification rule applied to
  pickup's own memory.
- **Missing is `unknown`, never orphaned.** Reconciliation must not reset an
  In Progress item because the table lacks an entry for it. A missing mapping
  triggers a rebuild, and only a rebuilt table may declare an orphan. Losing a
  file must never cancel live work.

---

## What pickup replaces

The typical hand-rolled fleet is a pile of cron/launchd scripts. One polls
the tracker and dispatches a headless agent. One watches PRs for review
feedback. One merges approved PRs. One hunts for issues marked in-progress
that nothing is working on. Each dispatch also re-arms its own cron check.
Pickup's three loops and the daemon absorb that whole layer:

| Fleet-script job | Fate |
|---|---|
| Poll tracker, dispatch assigned issues | Dispatch loop, issue rule |
| Watch PRs for review feedback | Dispatch loop, review rule |
| Per-dispatch outcome checks and cron re-arms | Daemon supervision + `report` |
| Merge approved PRs | Merge loop |
| Detect in-progress issues nothing backs | Dead/wedged half → daemon; tracker-drift half → reconciliation loop |
| Triage, escalation policy, answering humans | Not pickup's. Judgment stays agent-side |

---

## Non-goals

- No webhooks, no inbound listener, no tunnel — ever. Inbound networking is the
  category's tax; not paying it is the point.
- No LLM in any loop. The moment a loop needs judgment, it dispatches.
- No triage. Pickup acts on items already assigned and staged; deciding what
  deserves an agent is upstream of it.
- No cross-tracker abstraction leakage into core. Sources normalize at the
  pickup boundary; the queue contract stays tracker-free.
