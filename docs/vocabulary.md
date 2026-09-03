# Vocabulary

Every closed word-set in lobstah, in one place: what the words are, who says
them, and where the set is enforced. Each set is deliberately small and the
write paths reject anything outside it — a new word is a design change, not a
patch.

## Status verbs

What a dispatch *declares* about itself. Workers write them with
`lobstah report <id> <verb> [note]`; the write path (`appendStatus`) rejects
anything else. The status log is append-only; the last entry wins.

| Verb | Meaning | Who acts next |
| --- | --- | --- |
| `working` | Making progress; nothing needed. | Nobody. |
| `needs-decision` | Blocked on a judgment call only a human (or the orchestrator) can make. The note carries the question. | Human — re-fires every `remindSecs` until answered. |
| `blocked` | Cannot proceed for an external reason (missing access, broken dependency). | Human. |
| `paused` | Intentionally idle; resume is expected. | Whoever paused it. |
| `done` | The brief is fulfilled. Terminal. Merging is never the dispatch's job. | Merge loop / reviewer. |
| `failed` | Cannot fulfill the brief; work preserved in the worktree. Terminal. | Human. |

`done` and `failed` are the **terminal verbs** (`TERMINAL_VERBS`): once
logged, process state stops mattering and the daemon finalizes.

Source of truth: `VERBS` in `packages/core/src/types.ts`.

## Reconciled state

What an observer should *believe*, combining the status log with event
recency. Computed by `reconcile()`; shown by `lobstah status` and `buoys`.

The value set is the six verbs plus `unknown`. Precedence, highest first:

1. A terminal verb in the log — final, regardless of anything else.
2. Fresh event activity (default window 120s) — `working`, unless the log
   says something more specific (`needs-decision` with recent activity stays
   `needs-decision`).
3. The last logged verb.
4. Nothing trustworthy → `unknown`. **Absence of signal never means fine** —
   `unknown` is a prompt to look, not a synonym for idle.

## Liveness classification

What the *process* is doing, independent of what it claims. Computed by
`classify()` each daemon tick; drives the restart ladder. Internal to the
daemon — it never reaches a tracker.

| Classification | Evidence | Daemon response |
| --- | --- | --- |
| `unclaimed` | Descriptor present, no runner yet. | Spawn a runner. |
| `busy` | Runner alive, activity within the wedge threshold. | Nothing. |
| `terminal` | Terminal verb logged. | Finalize once the process is gone. |
| `dead` | Pid verified gone (pid + process-start-time, so pid reuse can't lie). | Respawn with session resume, bounded by `maxRestartAttempts`; then `failed`. |
| `wedged` | Alive but no activity past `wedgeThresholdSecs`. | SIGKILL the group, fork the session with a nudge, same bound. |
| `unknown` | Contradictory or missing evidence. | Touch nothing; log it. |

Dead and wedged get opposite treatment on purpose: a dead process is safe to
respawn; a wedged one must be killed first or two writers share a worktree. A
pending cancel preempts all of this — a cancelled dispatch finalizes as
`failed` ("cancelled by request") and never re-enters the ladder.

Source of truth: `Classification` in `packages/supervisor/src/liveness.ts`.

## Tend verdicts

What the *fleet* needs, computed by `lobstah man tend` from the heartbeat,
queues, and attention cursors. One verdict, precedence top-down:

| Verdict | Meaning |
| --- | --- |
| `daemon-down` | No fresh heartbeat — nothing is being supervised. |
| `stalled` | Work queued, capacity free, daemon alive, nothing claiming. Actually broken. |
| `needs-attention` | An unanswered `needs-decision`/`blocked` is standing. |
| `working` | Dispatches active or queued; nothing waiting on a human. |
| `idle` | Everything drained. The quiet is real — distinguished from `stalled` by evidence, not absence. |

## Merge gates

What the merge loop concluded about each open PR on its last tick, persisted
in the [merge view](pickup.md#merge-view).

| Gate | Meaning |
| --- | --- |
| `waiting-approval` | No qualifying approval on the current head. The resting state. |
| `behind-updated` | Behind base, no conflict; branch updated via the forge, gate re-enters next tick. |
| `conflict-chore:<uuid>` | Real conflict; a rebase chore owns the PR until it completes. |
| `rebase-failed` | The one bounded rebase attempt failed; `needs-human` label applied. Resting until a human acts. |
| `blocked` | The forge's rollup says a required check failed. |
| `draft` | Draft PR; never merged. |

A PR that leaves the open set gets a **disposition** instead: `merged` or
`closed`, recorded with one follow-up lookup so the answer is right even when
a human pressed the button.

## Tracker mappings

How verbs translate to tracker vocabulary is per-source and total — a verb
with no mapping is a config error at startup, not a silent drop. The tables
live in [pickup.md](pickup.md#reporting).

## Lanes and buckets

Work moves through two **lanes** — `work` (human-originated) and `chore`
(system-originated maintenance, own concurrency budget, reports to no
tracker) — and three **buckets** within a lane: `queued`, `active`, `done`.
Bucket transitions are atomic renames; the directory *is* the state.

## Doctor statuses

`lobstah doctor` grades each check with one of three words. **Owner:**
`apps/cli/src/doctor.ts`. **Enforcement:** any `fail` row exits 1.

| Status | Meaning |
| ------ | ------- |
| `ok`   | Works as configured. |
| `warn` | Degraded or optional — dispatches may still run (e.g. one harness missing, daemon not running). |
| `fail` | Broken configuration or missing requirement — fix before relying on lobstah. |

## Watch contract

A **watch** is a standing outbound poll on something external (a ume review
session, a CI run) registered through `lobstah watch add` — the validated
write path; nothing else touches `watches/`. **Owner:**
`packages/core/src/watch.ts`. **Enforcement:** check output that doesn't
parse records `lastError` and advances nothing.

| Word | Meaning |
| ---- | ------- |
| `check` | Shell command exec'd with `{cursor}` substituted; prints `{ "cursor", "events"?, "done"? }` JSON. Read-only and idempotent — pick and an inline `man wait` coordinate only by the `lastCheckedAt` stamp. |
| `cursor` | Opaque progress marker, advanced only from successful check output. The stream of record: a crashed watcher resumes from it losslessly. |
| `owner` | Who the events belong to: `man` (surface via `man wait`/`man haul` + notify) or `dispatch:<uuid>` (fork a continuation of that chain). Events are never unowned work. |
| `done` | The source is finished (session closed, run complete); the watch retires after its last events are consumed. |

Delivery is level-triggered and at-least-once, like dispatch attention:
events stand until the owner consumes them. One continuation dispatch in
flight per watch; later events buffer and fork from the latest session in
the chain.
