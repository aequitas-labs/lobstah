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
| `needs-decision` | Blocked on a judgment call only a human (or the orchestrator) can make. The note carries the question. A headless worker waiting on a question stays alive until answered (`lobstah send`), cancelled, or the wall clock. | Human — re-fires every `remindSecs` until answered. |
| `blocked` | Cannot proceed for an external reason (missing access, broken dependency). | Human. |
| `paused` | Intentionally idle; resume is expected. With `--waiting-on`, the worker says what it waits on outside lobstah (see [Waiting on](#waiting-on)). A state, not a question: it raises no attention and does not walk the pet. A paused headless dispatch is **parked**: no process and no slot (see [Parked](#parked)). | Whoever paused it, or the thing it waits on. |
| `done` | The brief is fulfilled. Terminal. Merging is never the dispatch's job. | Merge loop / reviewer. |
| `failed` | Cannot fulfill the brief; work preserved in the worktree. Terminal. | Human. |

`done` and `failed` are the **terminal verbs** (`TERMINAL_VERBS`): once
logged, process state stops mattering and the daemon finalizes.

A terminal verb from the worker is final. No later time limit, harness
error, kill, cancel, or daemon restart adds a verb after it. From the
moment the worker reports it:

- the wall clock stops for that dispatch;
- the dispatch holds no headless slot and does not count toward
  `maxConcurrent`;
- `lobstah daemon status` and `lobstah daemon restart` do not count it as
  active, so a restart needs no `--force`;
- `man tend`, the glass, and `lobstah doctor` show it as done.

At the end of that turn the runner ends the session and waits
`[limits].exitGraceSecs` (30 seconds) for the harness to exit. Then it
stops the harness and the processes it started, releases the worktree lock,
and moves the dispatch to `done/`. A cancel that arrives after the report
stops the harness at once and leaves the verb as reported. The daemon stops
a runner that is still alive `exitGraceSecs` plus `wedgeThresholdSecs` after
the report; it does not restart the dispatch.

Source of truth: `VERBS` in `packages/core/src/types.ts`.

## Waiting on

What a worker waits on outside lobstah: a human review in ume, a PR review, a
deploy. A report says it with flags:

```bash
lobstah report <id> paused "<note>" --waiting-on <kind> [--link <url>] [--until <iso|duration>]
```

| Kind | Meaning |
| --- | --- |
| `review` | A human review of an artifact (a ume plan or result). |
| `pr` | A pull request review or merge. |
| `deploy` | A deploy or release to finish. |
| `person` | A named person to act. |
| `external` | Anything else outside lobstah. |

`--waiting-on` and `--link` are valid only with `paused`, `needs-decision`,
and `blocked`; `--until` only with `paused`. The link must be http or https.
`--until` takes an ISO time or a duration from now (`30m`, `4h`, `2d`). The
fields are stored on the status entry (`waitingOn`, `link`, `until`); the
write path (`appendStatus`) rejects anything else.

Effects of `paused` with `--waiting-on`:

- `lobstah status`, `lobstah ls`, `lobstah man tend`, and the glass show
  `paused: waiting on review` with the link and the time waited. The glass
  card links the URL.
- A **trap** whose catch last reported `paused` (with or without
  `--waiting-on`) is not ghost-swept until `--until` passes, or, without it,
  until `[soak].pausedTtlSecs` (default 24 hours) after the report. After
  that it sweeps as before, and the `trap-ghosted` notice says the pause
  expired.
- A **headless** worker is not classified `wedged`, however long it is
  silent, and its `wallClockSecs` limit does not run while it is paused.
  It is parked and holds no slot (see [Parked](#parked)).
- With `--waiting-on pr` or `--waiting-on review`: when the PR it waits on
  merges, the daemon finishes the dispatch `done` (`the PR merged: <url>`);
  closed without merge, `failed`. The PR is the `--link` when it names a
  GitHub PR, else the dispatch's own PR, else its chain's PR. Every paused
  dispatch in the chain that waits on the PR is finished. The report
  registers the watch of the dispatch's own PR when it has none.
- No attention, no notice, no pet. It is a state, not a question.

Source of truth: `WAITING_ON` in `packages/core/src/types.ts`.

## Parked

A headless dispatch whose worker's last report is `paused`. At the end of
that turn the runner ends the session, stops the processes the harness
started, and exits without adding a verb. The dispatch stays in `active/`
and keeps its worktree lock.

- It holds no slot: it does not count toward `maxConcurrent` or
  `choreConcurrent`, and `lobstah daemon restart` needs no `--force` for it.
- It wakes when a message reaches its inbox (`lobstah send <id>`), or when
  its `--until` time passes. The daemon then starts a runner that resumes
  the same session, when a slot is free, before it claims queued work. The
  first prompt says why it woke and carries the messages; the first status
  note is `woke from pause: <why>`.
- A cancel finalizes it `failed` without a runner. A merged or closed PR
  it waits on finishes it (see [Waiting on](#waiting-on)).
- `man tend` lists it in the `parked (no slot)` table and counts
  `parked: N (no slot)` beside the slots; `lobstah daemon status` prints
  `slots`, `parked`, and `parkedOn`; `lobstah doctor`'s `daemon` row and the
  glass header show it too.

A trap's paused catch keeps its session: a trap never holds a headless
slot.

Source of truth: `isParked` and `parkedDispatches` in
`packages/core/src/slots.ts`; the runner's park in
`packages/runner/src/drive.ts`.

## Human gate

A CI check that fails by design until a person approves the change. No
code change turns it green. A human gate starts no PR repair and no CI-fix
continuation on its PR. The gates of a PR come from
`[repos.<key>].humanGateChecks` (names; `*` matches any run of characters)
and from `lobstah report <id> <verb> --human-gate "<check>"`, which records
the name in the worker's evidence and on the PR record (`humanGates`).
Apart from gates, each failing check gets at most one repair round per PR,
check name, and head commit (`repair.checks` on the PR record;
`checkRounds` on a pick-delivered PR watch).

Source of truth: `humanGatesFor`, `repairableChecks`, and `unrepairedChecks`
in `packages/core/src/pr-repair.ts`.

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

## Activity

What a worker is doing *now*. It comes from the event stream and from hooks,
never from the model remembering to report. The four layers, from least to
most detail: **liveness** (alive or stuck), **activity** (what it is doing
now), **narrative** (where it is in the plan: the six verbs, at milestones),
and **transcript** (everything). Liveness and activity are machine-derived.
Narrative stays with the worker.

One record per dispatch, `state/<id>.activity`: `{ at, kind, summary }`.

| Kind | Source |
| --- | --- |
| `tool` | A tool call started. The summary is the tool name and its primary target: a file path relative to the worktree, a command's first word, a URL's host. |
| `message` | The model wrote text. The summary is fixed (`writing a message`); the text is never copied. |
| `thinking` | The model is reasoning. No content. |
| `waiting` | The runner holds the run open: for an answer to a question, or for background work. |

The summary is never the tool's full input, file contents, an environment
value, or anything that looks like a secret (token prefixes, JWTs, bearer
values, `key=value` pairs with a secret-sounding key, long mixed runs of
letters and digits are replaced with `[redacted]`). It is capped at 80
characters.

Writers:

- **Headless:** the runner derives it from every event it drives. At most one
  write per 10 seconds, plus one on every change of kind; a held record is
  written when the window closes. Atomic write.
- **Trap:** the post-tool hook runs `lobstah soak beat`, which writes the
  record for the trap's claimed catch. At most one beat per 30 seconds per
  trap.

Readers: `lobstah status <id>` (`activity: <summary> (<age> ago)`),
`lobstah ls` (an `activity` column), `lobstah man tend` (the work table), and
the glass (under the verb and note on each dispatch). Past
`[limits].wedgeThresholdSecs` the line shows as **stale** (dim in the glass,
`stale:` in text, with its age). Staleness is displayed, not escalated: no
attention kind, no notice, no pet. The worker's own verb and note stay the
primary line; activity never replaces them.

Source of truth: `packages/core/src/activity.ts`.

## Liveness classification

What the *process* is doing, independent of what it claims. Computed by
`classify()` each daemon tick; drives the restart ladder. Internal to the
daemon — it never reaches a tracker.

| Classification | Evidence | Daemon response |
| --- | --- | --- |
| `unclaimed` | Descriptor present, no runner yet. | Spawn a runner. |
| `busy` | Runner alive, activity within the wedge threshold. | Nothing. |
| `terminal` | Terminal verb logged. | Finalize once the process is gone. A runner still alive `exitGraceSecs` + `wedgeThresholdSecs` after the report: stop its group (SIGTERM, then SIGKILL past twice that). Never restart. |
| `dead` | Pid verified gone (pid + process-start-time, so pid reuse can't lie). | Respawn with session resume, bounded by `maxRestartAttempts`; then `failed`. |
| `wedged` | Alive but no activity past `wedgeThresholdSecs`. Never a worker whose last report is `paused` with `--waiting-on` (that is `busy`). | SIGKILL the group, fork the session with a nudge, same bound. |
| `unknown` | Contradictory or missing evidence. | Touch nothing; log it. |

Dead and wedged get opposite treatment on purpose: a dead process is safe to
respawn; a wedged one must be killed first or two writers share a worktree. A
pending cancel preempts all of this — a cancelled dispatch finalizes as
`failed` ("cancelled by request") and never re-enters the ladder. A cancel
of a dispatch whose worker already reported `done` or `failed` stops the
runner and keeps the reported verb.

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

An **attachment** is a dispatch descriptor entry `{ name, path, bytes, type }`
pointing to a copied, dispatch-owned file under `state/<id>/attachments/`;
follow-ups reuse those paths, and messages may carry their own attachments.

## Follow-up and swap

How a dispatch picks up a session it did not start. One resolver
(`resolveSessionHarness`, `packages/core/src/resume.ts`) names the harness
that owns a session: evidence `harness`, else the claiming trap, else the
session id's UUID version (v7 codex, v4 claude), else the descriptor.

| Word | Meaning |
| ---- | ------- |
| follow-up | `--follow-up <id>` forks the origin's session **under the origin's harness** when the follow-up names no harness. An explicit `--harness` (recorded as `harnessExplicit: true` in the descriptor by `dispatch`, `swap`, and the node tool) that differs from the origin session's makes it a swap. A descriptor from before the record falls back to the old guess: a swap only if the harness is one the chain never asked for. Pickup review rounds and watch continuations are follow-ups. |
| send to a chain | `lobstah send <id> "<instruction>"` routes to a live member's inbox first, then a queued member's inbox. If the chain is finished, it dispatches a follow-up of its newest member, with the instruction as the brief. A second send reaches that queued follow-up. Use `dispatch --follow-up` to choose a new worker, harness, or model. |
| worktree reuse | A headless follow-up runs in its chain's worktree (the newest chain member's that still exists) when that worktree is clean, same-repo, and free, instead of allocating a new one (`[limits].reuseWorktree`, default on). Evidence records `worktree` (the checkout) and, on reuse, `worktreeOf` (the dispatch that allocated it). `dispatchWorktree` (`packages/core/src/worktrees.ts`) is the one resolver from a dispatch id to its checkout; attach, swap, catch, tend, the glass, and the cull all use it. The first status note says `reusing worktree of <origin>` or `fresh worktree (<reason>)`. |
| release on merge | With `[limits].releaseOnMerge`, the cull pass after a PR watch records `merged` removes the worktrees of that PR's finished chain, only when each is clean and its HEAD is on the remote. Evidence records `worktreeReleased` (when). A worktree that fails a check is **kept**: `release-kept.json` holds the reason, and doctor's `disk` row shows `kept: unpushed work`. |
| swap | Start cold on another harness with the brief plus a progress note (commits so far, uncommitted changes, and the origin's branch/PR/commits for a follow-up). `lobstah swap` does it to an active dispatch; a follow-up does it when it explicitly asks for a different harness. |
| `resume-fallback` | Status note (`resume-fallback: <reason> — starting cold on <harness>`) and evidence field (`resumeFallback`), recorded when the harness refuses a resume (not found, culled, foreign) before doing any work. No session is left to keep, so the runner starts cold on **the dispatch's own harness** (explicit, else the configured default), not the origin's. It passes the progress note along and the dispatch proceeds. |
| Codex desktop thread | A Codex thread whose rollout (`$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl`) has a `session_meta.originator` naming the desktop app (`Codex Desktop`, `codex_work_desktop`); CLI runs say `codex_exec` or `codex_sdk_ts`. `codex exec resume` has been seen to refuse one (`thread/resume failed: no rollout found for thread id …`, e2de5dd7, even though the rollout file was on disk). So when a Codex session is a known desktop thread, the resume path skips the attempt and notes `Codex desktop thread; not resumable from the CLI, starting cold on <harness>`, and `attach` refuses with the same words. A thread with no local rollout still gets its resume attempt, and a failure goes through `resume-fallback`. |
| model ↔ harness | A model never crosses harnesses. Before any spawn, a model that belongs to another harness is dropped for the adapter's default, and the first status note says so (`model claude-opus-5-5 is a claude model — dropped, using codex's default`). A small prefix table decides: `claude-*`, `opus`/`sonnet`/`haiku`/`fable` → claude; `gpt-*`, `o<N>`, `codex-*` → codex (`packages/core/src/models.ts`). Unknown ids pass through. |

## Doctor statuses

`lobstah doctor` grades each check with one of four words. **Owner:**
`apps/cli/src/doctor.ts`. **Enforcement:** any `fail` row exits 1.

| Status | Meaning |
| ------ | ------- |
| `ok`   | Works as configured. |
| `warn` | Degraded or optional — dispatches may still run (e.g. one harness missing, daemon not running). |
| `fail` | Broken configuration or missing requirement — fix before relying on lobstah. |
| `skip` | The check does not apply on this host (e.g. no harness plugin installed). Never fails the run. |

## Watch contract

A **watch** is a standing outbound poll on something external (a ume review
session, a CI run) registered through `lobstah watch add` — the validated
write path; nothing else touches `watches/`. **Owner:**
`packages/core/src/watch.ts`. **Enforcement:** check output that doesn't
parse records `lastError` and advances nothing. A failed check keeps its
reason (the first meaningful line of its output), exit code, and the start of
the failure streak; the third consecutive failure posts one `watch-failing`
notice and the next success one `watch-recovered`. A permission, auth,
not-found, or rate-limit failure doubles the watch's interval per failure, up
to one hour ([github.md](github.md#when-a-pr-watch-fails)).

| Word | Meaning |
| ---- | ------- |
| `check` | Shell command exec'd with `{cursor}` substituted; prints `{ "cursor", "events"?, "done"?, "error"? }` JSON. `error` marks a check that half-worked: its cursor and events apply, and the error counts as a failure. Read-only and idempotent — pick and an inline `man wait` coordinate only by the `lastCheckedAt` stamp. |
| `cursor` | Opaque progress marker, advanced only from successful check output. The stream of record: a crashed watcher resumes from it losslessly. |
| `owner` | Who the events belong to: `man` (surface via `man wait`/`man haul` + notify) or `dispatch:<uuid>` (fork a continuation of that chain). Events are never unowned work. |
| `done` | The source is finished (session closed, run complete); the watch retires after its last events are consumed. |
| `stream` | Optional long-lived NDJSON command held by pick for ms-latency delivery; a pure optimization — appends dedupe by `seq`, the check remains the guarantee. |

Delivery is level-triggered and at-least-once, like dispatch attention:
events stand until the owner consumes them. One continuation dispatch in
flight per watch; later events buffer and fork from the latest session in
the chain.

### The PR preset

`lobstah watch add pr:<owner>/<repo>#<n>` (or a github.com PR URL,
normalized to that key) installs the shipped check, `lobstah watch
check-pr`: one read-only `gh pr view` per cycle, diffed against the
previous observation that the cursor carries, plus — while the PR is open —
one read-only `gh api graphql` query for `reviewThreads { isResolved }`,
which `gh pr view --json` cannot return (no bodies are requested). `report <id> <verb> --pr
<url>` (any verb but `failed`) registers the same watch owned by
`dispatch:<id>` (idempotent; `--no-watch` opts out). A trap's beat
(`lobstah soak beat`) registers it the same way when it finds a PR on the
trap's branch. `lobstah watch backfill --apply` registers watches
for PRs in old dispatch history and fills the title of PR records without
one; it is a dry run without `--apply`. No other
path registers a PR watch: read commands (`catch`, `man tend`, `status`,
`ls`, `prs`, the glass) never do. **Owner:** `packages/core/src/pr.ts`
(derivation, badge) and `apps/cli/src/pr-watch.ts` (check, registration,
evidence).

| Word | Meaning |
| ---- | ------- |
| `pr:` key | `pr:<owner>/<repo>#<n>` — one watch per PR. |
| cursor | The last observation (head sha, per-check conclusions, review decision, merge state, draft, state), base64url-encoded. An unchanged PR re-emits nothing and returns the same cursor. A new head sha resets check memory. |
| first observation | Cursor `0`. It is the baseline. An open PR records checks and merge state but starts no repair. A merged or closed PR emits nothing, records its state, and the watch retires; the notice is posted only when the PR ended in the last 24 hours. |
| `check-completed` | A check reached a conclusion on the current head after the baseline (`name`, `conclusion`, `detailsUrl`). Failing → work; passing → evidence only. Never emitted for a merged or closed PR. |
| `review-decision` | The review decision changed (`value`). Work, unless `[pickup.github]` covers the repo — then pickup's feedback rule owns it ([pickup.md](pickup.md), "Feedback pickup"). |
| `merge-state` | `mergeStateStatus` changed (`value`). The PR record carries conflicts into the repair planner. |
| `draft` | Draft flipped (`value`). Evidence only. |
| `merged` / `closed` | Terminal; the check sets `done`, and the watch retires once delivered. Emitted only on an open → terminal change, never on the first observation. |
| evidence `pr` | `{ url, number, state, draft, reviewDecision, mergeStateStatus, headSha, checks: { total, passed, failed, pending, unknown? }, review: { unresolvedThreads, changesRequested, lastReviewAt }, observedAt }`. Check counts use only the latest run per check name and app/workflow. `CANCELLED` and `STALE` latest runs are unknown, not failed. The PR record also stores repair status, attempts, and reason. `prBadge` shows `repairing: conflict (attempt 1 of 2)` while a repair is in flight, and ends in `repair waits: <heldBy>` while a repair waits; tend, `catch`, and the glass share the badge. |
| waiting repair | `repair.status: waiting` on a PR record: a repair is due but is not queued. `heldBy` names the holder: `wt:<trap>` or `dispatch:<id8>` (a live worker holds the PR's head branch or the head branch of a PR below it in the stack), `helm` (the helm cancelled a repair of this PR), `hold` or `dispatch:<id8>` (`watch hold`), `settle` (the head, base head, or failing checks changed less than `[watch].repairSettleSecs` ago; `until` says when), or `checks` (the latest run of a failing check is in progress or passed). `reason` says what holds it. A wait is not an attempt and raises no attention item. |
| live worker | An active headless dispatch, or a trap with an open catch. It holds a branch that its worktree has checked out, that its current branch tracks, or that it pushed during its current dispatch (evidence `pushes`). It holds a PR that its evidence names or that its chain owns. |
| evidence `pushes` | `[{ branch, at }]`: the branches a dispatch pushed, as lobstah saw them. The runner records its own pushes; the runner records a headless worker's `git push` from the harness event stream (branch names only); `soak beat` records a trap's `git push`. |
| descriptor `pr` | `{ url, headRefName?, headSha? }`: the existing PR a dispatch works on. A PR repair and a pickup rebase chore carry it. The runner pushes no branch and opens no PR for such a dispatch; its worker pushes to the PR's head branch. |
| push rule | What a repair or rebase brief tells its worker: push only to the PR's head branch; on a non-fast-forward rejection, fetch, rebase the commits onto the moved head again, and push with `--force-with-lease` on the head just fetched, at most three times; a hook failure from a real test or type error is not retried; when it cannot push, report `failed "push rejected: <rejection text>; moved head <sha>"` and leave the PR as it was. That report marks the PR's repair `blocked` at the moved head and posts a `push-failed` notice. |
| checks unknown | Without `Checks: read`, the check re-reads the PR without `statusCheckRollup`: the PR state is recorded, `checks.unknown` is `no permission`, and the check's output carries the permission `error`. `pr:ready` never stands on unknown checks. |
| PR record | `~/.lobstah/prs/<owner>__<repo>__<n>.json` — the PR's latest observation keyed by the PR, not by a dispatch: the evidence `pr` object (with `title`, read on every check; a title change is not a state change) plus `key`, `repo` (`<owner>/<repo>`), `dispatches` (the ids whose watch observed it; empty for a human's or a culled PR), and `firstSeenAt` (the time of the first observation; written once, never rewritten). `firstSeenAt`, then the PR number, is the order of every PR list. A record from before `firstSeenAt` existed sorts by number at the earliest `firstSeenAt` in the set, and its next observation writes that time as its `firstSeenAt`. **Owner:** `packages/core/src/prs.ts` (`upsertPr`, `readPrs`); the one writer is the preset's observation path (`observePr`), on every observation, man-owned or dispatch-owned — a dispatch-owned one also stamps that dispatch's evidence, which stays the per-dispatch view. Tend's `pr:*` kinds and `pr:ready` stack suppression, the glass PRs tab and stacks, the merged/closed notice, and PR acks read records first and fall back to dispatch evidence only for a PR with no record yet. `cull` removes records merged or closed longer than its window, never open ones. |

Every event carries `headSha`. A dispatch-owned PR watch records work events,
then the repair planner decides whether to follow up. One repair runs per PR
at a time. A first observation starts none. Repairs use the newest owning
dispatch and the PR's observed base branch. The watch checks commit ownership
before enqueueing. It stops after `[watch].maxRepairsPerPr` attempts per head
SHA. A repair waits (`repair.status: waiting`) while a live worker holds the
PR's head branch or a branch below it in the stack, until the PR has settled
for `[watch].repairSettleSecs`, while a failing check's latest run is in
progress or passed, and while the PR's watch is held. A wait is not an
attempt. A repair whose worker reported `failed "push rejected: ..."` is `blocked` at the
moved head and at the head it started from. The rest is evidence.
Merged and closed reach the helm as a `pr-merged` / `pr-closed` notice,
posted once by whichever process first records the open → terminal
transition on the **PR record** — not by event routing. A PR whose first
record is already terminal gets the notice only when it ended in the last
24 hours.

One pick watch cycle forks at most `[watch].maxForksPerCycle`
continuations (default 3). Generic watches over the cap are held (`heldAt`
on the watch); PR repairs wait for the next cycle. A watch hold also comes
from `lobstah watch hold <key> [--for <id>]` and from
`lobstah cancel` on a repair dispatch. The watch then carries `heldReason`,
`heldBy`, and, for `--for`, `heldFor`: the hold ends when that dispatch ends.
`lobstah watch release` ends any hold.

A man-owned PR watch (no `--for`) delivers as attention only what needs a
human (`manEvents`, beside `workEvents` in `apps/cli/src/pr-watch.ts`): a
failing `check-completed`, and a `review-decision` turning to
`CHANGES_REQUESTED`. Green checks, draft toggles, merge-state changes, and
approvals go to the PR record only — they show as `pr:*` kinds and in the
glass, never as `watch` attention.

One carrier per event kind:

| Event | Carrier |
| ----- | ------- |
| `check-completed`, failing | dispatch-owned: the PR repair planner; man-owned: a `watch` attention event |
| `review-decision` | dispatch-owned: the PR repair planner for requested changes; man-owned: a `watch` event only for `CHANGES_REQUESTED` |
| `check-completed` green, `draft`, `merge-state`, approvals | the PR record (and the owner's evidence) only |
| `merged`, `closed` | a `pr-merged` / `pr-closed` notice from the record transition only |

Pick stays the single writer of watch progress. The inline poller (`man
wait`, the helm park) runs PR checks for man-owned watches as usual, and
only **observes** dispatch-owned ones: it writes the PR record and the
evidence `pr` object (and so the merged notice) and never advances their cursor or consumes
their events, so pick still sees and forks every one.

## Soaking contract

A **trap** is a worktree that volunteered as a worker seat through
`lobstah soak` — the validated write path; nothing else touches `soaking/`.
Identity is **worktree-anchored**: `.lobstah-trap` in the worktree root
holds a short stable id, the registration keys on it, and the address
(`wt:<id>`) survives session restarts. The session id inside the
registration is the liveness principal. **Owner:**
`packages/core/src/soak.ts`. **Enforcement:** sign-on from a repo's primary
checkout, or with `--repo <key>` from outside any configured repo, creates a
linked worktree (`~/.lobstah/worktrees/soak-<trap>`, branch
`lobstah/soak-<trap>`) and signs that on; a live foreign session in an owned
worktree is refused (the session lock); a stale one is adopted.

| Word | Meaning |
| ---- | ------- |
| `soak` | Sign the worktree's trap on and take matching work. From a primary checkout, or with `--repo <key>` from outside any configured repo, it first creates a linked worktree like a dispatch does (fetch trunk, new branch from `origin/<trunk>`, `setup` commands), prints `worktree:`, `created: true`, `branch:`, and, when the session is elsewhere, `instruction: cd <path> ...`; the session works in that directory. If creation fails, nothing is signed on and the partial worktree and branch are removed. `--repo` in a linked worktree must match its repo. A session that already mans a trap re-uses it (resolved from the session id) and never gets a second worktree. `--session` is needed only on first sign-on. `--one` stows after the first catch. `--wait` registers a watcher and waits for work; a quiet timeout exits 3. Workers never run `man` verbs. |
| `stow` | Sign the trap off (in the worktree, or elsewhere by session id: `--session <id>` or `$CLAUDE_CODE_SESSION_ID`); an open catch requeues (a cancelled one finalizes as failed) and unread messages bounce to the helm. A trap always stows itself freely; stowing someone else's (`--wt`) is steering — the claimed helm's alone. Stow closes the seat, never the session: an opted-in session can only be asked to stop, and a still-looping worker re-enlists visibly (`trap-signed-on`). By default stow removes the worktree when soak created it (`createdWorktree: true`) and prints `worktree: removed`, `path:`, and `returnTo:`; `--keep` leaves it. It keeps the worktree (`worktree: kept`, `reason:`) when soak did not create it, or when it holds uncommitted changes, untracked files that are not ignored, or commits on no remote branch; it never forces a removal. The branch is deleted (`branchDeleted:`) only when all its commits are on its upstream (with no upstream: on some remote branch); otherwise `branchKept: <branch> (<reason>)`. `--wt` follows the same rules. The SessionEnd hook (`stow --quiet`) signs off and keeps the worktree. |
| address | `--for wt:<trap>` targets one trap; `session:<id>` is an alias resolved to the trap at dispatch time. **Sticky:** addressed work is never the daemon's — it waits for its trap; an orphan (trap gone) surfaces as a `bait-orphaned` notice for the helm to re-address, release, or cancel. Delivery stamps a receipt (`deliveredTo`/`deliveredAt`) into evidence. Unaddressed work defers to a parked matching trap for `[soak].deferSecs`, then the daemon spawns headless. |
| message | `send wt:<trap> "<text>"` — a conversational continuation, not work: no branch, no catch, no report obligation. Delivered before bait at the trap's next park, stamped with its sender (`helm` / `session:<id>` / `terminal`); undeliverable messages bounce to the helm as notices. |
| catch | The active dispatch a trap claimed (`claim.json`, `by: wt:<id>`). One catch per trap; one active item per worktree. The daemon never spawns or restarts it — the session's reports are its liveness. |
| beat | `lobstah soak beat`, run by the plugin's post-tool hook after every tool call. It resolves the trap from the working directory, else from the session id (files only: no git, no network), refreshes the trap's beat (`soaking/<trap>.beat`, separate from the registration), and writes the claimed catch's [activity](#activity). Throttled to one per 30 seconds per trap. Inert in a session that is not soaking, or with `[soak].beat = false`. Always exits 0; errors go to `logs/beat.log`. |
| ghost trap | A registration whose heartbeat **and** beat lapsed past `[soak].ttlSecs` **after having parked at least once**. The sweep removes it, requeues its catch, and posts a `trap-ghosted` notice; the worktree stays, and re-soaking restores the same address. A fresh report or a fresh beat keeps a working session out of the sweep. A fresh beat also holds the session lock. A catch whose last report is `paused` keeps its trap until the pause expires ([Waiting on](#waiting-on)). |
| defective enlistment | A stale registration that **never parked** — signed on but never listened (usually no Stop hook). Not swept: the helm gets a `trap-defective` notice with the remedy (`soak --wait`), and the registration stays so the address keeps protecting its work. |
| notice | The helm's attention channel for non-status events (`~/.lobstah/notices/`): sign-ons, first parks, sign-offs, ghosts, defective enlistments, orphaned work, bounced messages, PRs merged or closed, watches held over the fork cap (`watch-held`), failing (`watch-failing`), and recovered (`watch-recovered`), free-space holds (`disk-held`, `disk-cleared`), worktrees released after their PR merged (`worktree-released`, one per cull pass), and a repair or rebase that could not push to its PR's branch (`push-failed`). A trap leaves the registry only through a `trap-stowed` or `trap-ghosted` notice — the end-state is always explicit. Consumed by `man wait`/the park; tend always shows the recent tail. |

Delivery routes by ownership, same as watches: a continuation for a chain
claimed by a live trap is addressed back to that trap and stays sticky.
Sessions are never conscripted — a thread works bait only after opting in,
and nothing addressed is ever silently rerouted.

## Helm contract

The **helm** is the orchestrator seat: one interactive session signed on as
the lobstah man for its grounds through `lobstah man helm` — the validated
write path; nothing else touches `helm/`. Soak enlists workers; helm enlists
the one who dispatches to them. **Owner:** `packages/core/src/helm.ts`.
**Enforcement:** one registration file per grounds — the data model cannot
hold two; a live foreign holder refuses sign-on without `--take`. The rule
is strict: once a helm is claimed, the orchestrator verbs that consume helm
state (`man wait`, `man report`, the lobstah man park) are reserved for the
helm session — any other caller is refused with guidance (or, for the hook,
silently ignored). Read verbs (`man tend`, `man brief`) and the enlistment
verbs stay open. A stale helm reserves nothing.

| Word | Meaning |
| ---- | ------- |
| lobstah man | One interactive session that takes the helm for a grounds, triages the fleet, dispatches work, and answers traps; `lobstah man` also names its CLI command group. |
| `helm` | Sign a session on as the orchestrator for one grounds. Prints the charter and enables the Stop hook without a marker file. Re-running from the same session is an idempotent re-sign. |
| watcher registration | `~/.lobstah/watchers/<session-id>.json` stores a `man wait` or `soak --wait` process's PID and heartbeat. The waiter refreshes it while running and removes it on exit; a heartbeat older than five seconds is stale, and a second waiter for the same session refuses. |
| `man haul --park` | Make the Stop hook wait for attention while work is in flight. `[helm].park = "block"` selects the same mode. In arm mode, the hook allows a stop with a live watcher or blocks with the arm command. |
| `relieve` | Step down. `--take` on another session's `helm` is the only force path: it displaces a live holder deliberately and leaves them a stand-down notice, delivered once at their next park. A holder whose heartbeat lapsed past `[helm].ttlSecs` is stale and claimable without `--take`. |
| grounds | A named territory: the subset of configured repos one helm oversees, from `[grounds.*]`. A repo belongs to at most one grounds (config error otherwise). No grounds configured means one implicit `fleet` grounds covering every repo. |
| charter | The helm's persona and scope fences, in Standard Technical English. Printed at sign-on and re-injected by `man brief` at every session start, so it survives restarts and compaction. |
| digest | The delta since the reported-through cursor: catches landed, attention arisen, still-waiting, fleet verdict. Carried by `man report`, a `man wait` timeout, and — in blocking park mode, at `[helm].reportSecs` cadence — the park itself. Change-gated: an empty delta is never delivered. |

## Attention contract

**Attention** is what stands waiting for a human to look: `man tend`'s
`attention` list, which the desktop pet and the glass walk across the
screen. It is derived in one place (`apps/cli/src/tend.ts`) and nowhere
else. **Owner:** `apps/cli/src/tend.ts`. **Enforcement:** `attentionKinds`
in `config.toml` selects the kinds (an unknown kind is a config error);
every kind is level-triggered — it stands until its own clear condition,
never until someone acknowledges it.

| Kind | Stands while | Clears when |
| ---- | ------------ | ----------- |
| `question` | The dispatch's last status is `needs-decision` or `blocked`. Held (`held: true`; not in the pet, the glass, or notifyCommand) while a live helm for its grounds has not ended a turn since it was filed. | Any newer status entry, or a message newer than it. |
| `landed` | The dispatch is `done` or `failed` after its grounds' reported-through cursor (the grounds listing the repo, else `fleet`; at most 24 h back). Opt-in. | `man report` (or the helm park's digest) advances the cursor. |
| `pr:draft` | An open PR is a draft, and the user opted into this kind. | Ready for review, merged, or closed. |
| `pr:review` | An open PR has unresolved review questions, or requested changes that lobstah cannot repair, has exhausted, or is configured not to repair. | Every thread resolved and no changes requested, or merged / closed. |
| `pr:checks` | An open PR has a failed latest check, and lobstah cannot repair it, has exhausted attempts, or is configured not to repair. | Green on the head, or merged / closed. |
| `pr:conflict` | An open PR conflicts with its base, and lobstah cannot repair it, has exhausted attempts, or is configured not to repair. | The merge state leaves `DIRTY`, or merged / closed. |
| `pr:ready` | An open, non-draft PR has no review condition, a mergeable state (`CLEAN`, `HAS_HOOKS`, or `UNSTABLE`), and no failed, pending, or unknown latest checks. It is approved or has at least one check. | Merged or closed, or the ready conditions stop holding. |
| `report` | A filed report (`report --report`, `man file`) has no ack for this filing. Opt-in. Key `report:<lane>:<uuid>` or `report:helm:<grounds>:<rid>`. | Not cleared: it stays listed until culled. `lobstah attention ack <key>` acks it, and a newer report in the same chain acks the older; an acked report no longer walks. |

`pr:*` kinds read only the `pr:` watch's evidence — never a forge call —
and carry `prUrl`, `number`, and the fields they derive from. Unconsumed
man-owned watch events also list, as `watch`: machinery wakes, always on.
Only `question` and `watch` make the verdict `needs-attention` or arise in
the digest; the rest are things to look at, not stalls.

**The on-the-hook rule.** Repairable conflict, check, and requested-review
conditions on an owned PR stay off attention while lobstah can act. A
queued or active pickup feedback round or watch continuation also suppresses
its review or check item. A blocked or exhausted repair raises attention
with its reason. A waiting repair raises none. `pr:draft` is opt-in; an explicit `attentionKinds` list is
used unchanged.

**Answered questions.** A `question` stands only while no message to the
dispatch is newer than its latest `needs-decision` / `blocked` entry. A
message counts when it carries provenance: `sendMessage` writes a
`NNN.meta.json` sidecar `{ from, at }` beside each `NNN.msg` (`from` is
`helm`, `session:<8>`, `terminal`, `tracker:<source>`, or `node`), and
`acknowledge` moves it into `handled/` with its message. Any sender counts;
a record without a sidecar (written before provenance existed) never does;
the sidecar's `at` decides, never file mtime. `man wait`, the park, and the
reminder loop apply the same predicate.

| Word | Meaning |
| ---- | ------- |
| ack | `~/.lobstah/acks/<item-key>.json` — `{ key, kind, stateHash, at, by }`, written only by `lobstah attention ack` (removed by `unack`, by the CLI's `man tend` / `attention` when its `stateHash` goes stale, and by `cull` when the item is gone). **Display-only**: it hides the item from the desktop pet and the glass lobs while the item's `stateHash` is unchanged; `man tend --json` keeps the item with `acked: { at, by }`, and `man wait`, the park, reminders, and `notifyCommand` never read acks. Item keys: `<lane>:<uuid>` (question, landed), `pr:<owner>/<repo>#<n>` (all of a PR's `pr:*` kinds — one ack covers them), `watch:<key>`. `stateHash` covers the status entry (question, landed) or the PR's head sha plus every evidence field a `pr:*` kind stands on (not `observedAt`). |
| pet state | `~/.lobstah/pet/state.json` — `{ pid, at, ok, command, reason, consecutiveFailures, items, lastOkAt }`. The desktop pet's one write: it rewrites the file after each attention read (about every six seconds). `command` is the command that worked (`attention --json`, or `man tend --json` from an older CLI). `reason` says why the last read failed (timed out, non-zero exit, output that does not decode). Only `lobstah doctor` reads it, for its `pet` row: running means `pid` is alive and `at` is less than two minutes old. |
| budget stop | A headless runner's `failed` verb with a `budget:` note means its progress-extended active-work window reached the hard ceiling. This is out of time, not a code failure: the runner checkpoints eligible changes, pushes when enabled, names the saved branch/commit/draft PR, and invites `lobstah send <id> "continue"`. Paused `--waiting-on` time is excluded. |

## Exit codes

The CLI's exit-code contract, aligned with axi.md P6. **Owner:**
`apps/cli/src/main.ts` (`UsageError`) and `apps/cli/src/usage.ts` (the
registry that decides what parses).

| Code | Meaning |
| ---- | ------- |
| `0` | Success — including definitive empty results. |
| `1` | Error: the command was well-formed but could not do its job. |
| `2` | Usage mistake: unknown command, flag, or subverb. The error names the offender and prints the command's usage card. Flags in a free-text tail (a `send` message, a `report` note) are never validated — prose may contain anything. |
| `3` | `man wait --timeout` elapsed with nothing to report. Its own code so `while lobstah man wait` loops still terminate on timeout while `2` stays unambiguous. |
