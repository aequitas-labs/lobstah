# Configuration reference

One file: `$LOBSTAH_HOME/config.toml` (default `~/.lobstah/config.toml`),
created with commented examples by `lobstah init`. Pickup reads its own
`[pickup.*]` sections from the same file.

**The one TOML gotcha:** top-level keys (`notifyCommand`, `remindSecs`, …)
must appear **before** the first `[section]` header, or they silently become
keys of that section.

## Top level

| Key | Default | Meaning |
|---|---|---|
| `notifyCommand` | — | Exec'd by the daemon on wake-worthy status transitions with `LOBSTAH_ID`, `LOBSTAH_LANE`, `LOBSTAH_VERB`, `LOBSTAH_NOTE`, `LOBSTAH_AT` in the environment. Fire-and-forget; point it at ntfy, a Slack helper, anything. |
| `notifyVerbs` | `["needs-decision", "blocked", "done", "failed"]` | Which verbs fire `notifyCommand`. |
| `attentionKinds` | `["question", "pr:draft", "pr:review", "pr:checks", "pr:conflict", "pr:ready"]` | Which attention kinds `man tend` lists — and so what the desktop pet and the glass walk across the screen. Valid kinds: `question`, `landed` (opt-in), `pr:draft`, `pr:review`, `pr:checks`, `pr:conflict`, `pr:ready`; an unknown kind is a config error naming the valid set. Notify is edge-triggered and fires once per transition; attention is level-triggered and stands until its clear condition ([vocabulary.md](vocabulary.md#attention-contract)). |
| `remindSecs` | `900` | An unanswered `needs-decision`/`blocked` re-fires to `man wait`/`man haul` on this interval until answered. `0` = report once only. |

## `[repos.<key>]` — workspace definitions

The descriptor's `repo` field resolves here; the key is what dispatchers name.

| Key | Required | Meaning |
|---|---|---|
| `path` | yes | The git clone worktrees are allocated from (`~/` expands). |
| `trunk` | yes (default `main`) | Branch dispatches start from (`origin/<trunk>`). |
| `origin` | no | Enables clone-on-first-use when `path` doesn't exist. |
| `setup` | no | Commands run in each fresh worktree, in order (e.g. `["pnpm install"]`). A follow-up that reuses its origin's worktree does not run them again unless a lockfile at the worktree root (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, and others) or the commands changed since they last ran there. |
| `scratch` | no | Repo-relative paths (e.g. `["tmp", ".cache"]`) whose untracked files do not count as uncommitted changes when a follow-up decides whether to reuse its origin's worktree. Tracked changes anywhere, and untracked files elsewhere, still do. |
| `env` | no | Environment merged into every dispatch for this repo. |
| `pickup` | no (`false`) | Opt this repo into `[pickup.github]` multi-repo mode. Explicit per repo — nothing becomes pickable by being configured. |
| `pushEarly`, `draftPr`, `checkpointOnStop` | no (inherit `[limits]`) | Override remote preservation for this repo's headless dispatches. |

`[repos.<key>.harness]` — per-repo harness defaults: `default` (`claude` \|
`codex`), `model`, `effort`.

`effort` reaches both harnesses: Claude as its effort level (`low`, `medium`,
`high`, `xhigh`, `max`), Codex as `model_reasoning_effort`. Set it for Claude
rather than relying on the default — left unset, a Claude session takes
`effortLevel` from the host's settings files, including the user's own
`~/.claude/settings.json`.

`lobstah repos add <path> [--pickup]` detects and appends a block (origin,
default branch from `origin/HEAD`, setup from the lockfile); `lobstah init
--scan <dir>...` does the same for every git repo found under the given
roots. Both append text — hand-written comments survive.

## `[harness]` — global harness defaults

Same three keys as the per-repo block. Precedence for every harness setting:
**descriptor > repo > global > adapter default.**

## `[limits]`

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | `2` | Headless work-lane runners the daemon may run at once. Trap-claimed catches use their own sessions and do not spend these slots. |
| `choreConcurrent` | `1` | Headless chore-lane runner ceiling (rebases and other machine-originated runs). |
| `wedgeThresholdSecs` | `600` | No tool activity for this long while alive = wedged → killed and forked with a nudge. Also the age past which `status`, `ls`, `man tend`, and the glass show a dispatch's activity line as stale. |
| `maxRestartAttempts` | `2` | Bounded restart ladder for dead and wedged runners. |
| `wallClockSecs` | `3600` | Initial active-work window. Progress extends it, up to `maxWallClockSecs`; time paused with `report paused --waiting-on` does not count. |
| `maxWallClockSecs` | `4 × wallClockSecs` | Hard active-work ceiling across restarts. |
| `pushEarly` | `true` | Push each new committed HEAD to its non-trunk branch on `origin` within 10 seconds. A rejected push is noted and retried only after HEAD moves. |
| `draftPr` | `true` | After first push, adopt an existing PR or open one draft PR when `gh` is available. |
| `checkpointOnStop` | `true` | Before a nonterminal stop, checkpoint eligible tracked and untracked files, then push. Ignored files and secret/build denylist paths are excluded. Set all three switches to `false` for prior runner behavior. |

A runner extends its active-work window when a fresh activity event or new HEAD
shows progress at the boundary. The elapsed budget and current window are
persisted across restarts; a pause with `--waiting-on` does not spend active
time. At the hard ceiling, the status verb remains `failed` for compatibility,
but its note starts `budget:` and tells the man what work was saved and to
send a continuation.
| `backgroundWaitSecs` | `1800` | A turn that ends without a report is held open this long while background work the worker started is still running (a push behind a slow pre-push gate); the harness wakes the worker when it settles. Heartbeats keep the wedge detector off the wait. Keep it below `wallClockSecs`, which still ends the run. |
| `choreRetentionDays` | `7` | Completed chores age out of `chores/done/`. |
| `attachmentMaxBytes` | `26214400` (25 MiB) | Maximum size of each file supplied with repeatable `dispatch --attach` or `send --attach`. |
| `retentionDays` | `0` (off) | The daemon culls finished dispatches (done and failed) older than this many days: their `done/` entries, worktrees, state files, and stale PR records and acks. Branches are kept. A dispatch whose PR is still open is kept. Queued and active dispatches are never culled. The pass runs at most once per hour and culls at most 10 dispatches per pass, so it cannot stall the claim loop. Suggested: `14`, the same window as `lobstah cull`. |
| `releaseOnMerge` | `false` (off) | When a PR watch records `merged` for a PR, the daemon's next cull pass removes the worktree of the dispatch that owns the PR, and of every dispatch in its follow-up chain that ran on that PR (its own worktree or a shared one). It uses the retention cull's removal path, its hourly throttle, and its limit of 10 per pass, and runs even when `retentionDays` is `0`. It releases a worktree only when every dispatch in the chain is finished (done or failed) and none is queued or active, `git status --porcelain` is empty, and after a fetch `git branch -r --contains HEAD` is not empty. Otherwise it keeps the worktree, records why, and `lobstah doctor`'s `disk` row shows `kept: unpushed work`; the next pass checks again. Uncommitted changes and unpushed commits are never deleted. A PR closed without merge releases nothing. A trap's worktree is never released. Branches (local and remote), `done/` entries, state, and evidence are kept; `lobstah catch` prints `worktree: released on merge (<time>)`. One `worktree-released` notice per pass lists what was released. |
| `reuseWorktree` | `true` | A follow-up (`--follow-up <id>`) runs in the worktree of the newest dispatch in its chain whose worktree still exists, on the branch and HEAD where that dispatch stopped. Trunk is fetched; `setup` runs again only if a lockfile changed. It reuses only when the worktree is clean (untracked files under the repo's `scratch` paths excepted), belongs to the same repo, and no other dispatch runs in it; otherwise it allocates a fresh worktree as usual. A dirty worktree is never cleaned or reset. The first status note says which: `reusing worktree of <origin>` or `fresh worktree (<reason>)`. A lock file in the worktree's git dir (`lobstah.lock`) keeps a second runner out; a lock whose dispatch has finished is stale. A shared worktree is kept by the cull and the free-space guard while any dispatch in the chain is queued or active, and it ages from the newest dispatch that used it. `false` allocates a fresh worktree for every dispatch. Headless dispatches only: a trap works in its own worktree. |
| `minFreeGB` | `0` (off) | Free space the worktrees volume (`~/.lobstah/worktrees`) must have before the daemon claims work, because each claim creates a worktree (1 to 8 GB). Below the limit, the daemon first removes finished worktrees, oldest first, until the limit is met or none are left (this runs even when `retentionDays` is `0`; open-PR and live worktrees are kept, branches are kept). If space is still short, the work stays in the queue and is not failed: `man tend` and the glass show it as `held: 3.2 GB free, needs 10 GB`. The daemon checks again on every tick. One `disk-held` notice marks the start of a hold and one `disk-cleared` notice marks its end. Suggested: `10`. |

## `[soak]` — soaking sessions (`lobstah soak`)

| Key | Default | Meaning |
|---|---|---|
| `deferSecs` | `90` | A soaking session whose park heartbeat is this fresh holds unaddressed matching bait — the daemon waits instead of spawning. Addressed bait (`--for session:<id>`) waits regardless, until the registration is gone. |
| `ttlSecs` | `1800` | Heartbeat age past which a registration is a ghost trap: the sweep removes it and requeues its open catch (or finalizes a cancelled one as failed). A fresh `lobstah report` on the catch counts as liveness too, and so does a fresh beat. |
| `beat` | `true` | The post-tool hook (`lobstah soak beat`) refreshes a soaking session's liveness and writes its catch's activity, at most once per 30 seconds per trap. With `false` the hook does nothing, and a trap's liveness comes from its reports and its park only. |
| `pausedTtlSecs` | `86400` (24 hours) | A trap whose catch last reported `paused` is kept out of the ghost sweep this long after the report. `report paused --until <iso|duration>` sets the expiry instead. After it, the sweep removes the trap as usual, and the notice says the pause expired. |

## `[helm]` — the orchestrator seat (`lobstah man helm`)

| Key | Default | Meaning |
|---|---|---|
| `ttlSecs` | `1800` | Heartbeat age past which a helm registration is stale: the next `man helm` claims it without `--take`. The park and `man brief` heartbeat it. |
| `reportSecs` | `900` | Minimum seconds between park-delivered digests for a helm session. The digest is also change-gated — quiet grounds deliver nothing regardless of cadence. |
| `armGraceSecs` | `5` | Arm mode: when work is in flight and no live watcher is registered, the Stop hook polls this long for one before blocking — a `man wait` (or `soak --wait`) backgrounded just before the turn ended is usually still starting. A stale registration gets the same window. |

## `[glass]` — the spyglass

| Key | Default | Meaning |
|---|---|---|
| `port` | `4949` | Localhost port for the glass. `LOBSTAH_GLASS_PORT` takes precedence. |

## `[watch]` — watch delivery

| Key | Default | Meaning |
|---|---|---|
| `maxForksPerCycle` | `3` | The most continuation (CI-fix) dispatches one watch cycle of `lobstah pick` may fork. Each watch over the cap is held: its events stay buffered, `man tend` and `lobstah watch` list it as `held`, one `watch-held` notice names the held watches, and it forks nothing until `lobstah watch release <key>` (or `--all`). |

## `[grounds.*]` — helm territories

One helm per grounds; a repo belongs to at most one grounds (`man helm`
refuses on overlap or an unknown repo key). With no `[grounds.*]` configured
there is one implicit `fleet` grounds covering every repo — the partition
only exists when asked for.

```toml
[grounds.base]
repos = ["homebase", "matcha"]

[grounds.aequitas]
repos = ["lobstah", "lavish"]
```

## `[pickup]` — tracker loops (`lobstah pick`)

| Key | Default | Meaning |
|---|---|---|
| `pollSecs` | `45` | Poll cadence. Outbound only — no webhooks, ever. |
| `liveComment` | `true` | Keep one editable, marked status comment per dispatch. Routine edits are capped at once per minute; human-needed and terminal transitions still post a fresh notification comment. Falls back to transition comments if editing is unavailable. |
| `notifyCommand` | — | Pickup's own hook, fired on tracker-report transitions with `LOBSTAH_KEY`, `LOBSTAH_UUID`, `LOBSTAH_VERB`, `LOBSTAH_NOTE`, `LOBSTAH_PR_URL`. |

### Token sources (both trackers)

Exactly one of, in precedence order — the config carries a reference, never a
secret:

| Key | Behavior |
|---|---|
| `tokenCommand` | Exec'd, output cached ~5 min. The fit for hourly-expiring GitHub App installation tokens (`gh-app-token.sh`-style minting scripts). |
| `tokenFile` | Read per call — rotation just works. |
| `tokenEnv` | Read per call, so a wrapper can refresh it. Defaults: `GITHUB_TOKEN` / `LINEAR_TOKEN`. |

### `[pickup.linear]`

| Key | Default | Meaning |
|---|---|---|
| `assignField` | `assignee` | Which Linear field marks work as ours: `assignee` for a user token, `delegate` for an agent token (Linear's UI assigns agents through the delegate field). |
| `startState` | `Todo` | Assigned + this state → dispatch. Claiming moves the issue to `claimedState` — the cross-machine mutex. Also the reset target for `failed` and orphans. |
| `startStateTypes` | — | Optional: poll by state *type* instead of the `startState` name, e.g. `["backlog", "unstarted"]` — a delegated issue is meant to be done even while it sits in Backlog. |
| `claimedState` | `In Progress` | |
| `doneState` | `In Review` | Where `done` reports land. `failed` returns to `startState`. |
| `route` | — | Team key → repo key, e.g. `{ ENG = "myapp" }`. |

### `[pickup.github]`

Two modes. **Single-repo**: name the forge repo explicitly. **Multi-repo**:
omit `repo`/`key` and the `[repos.*]` table becomes the source of truth —
every repo with `pickup = true` and a GitHub `origin` is polled, its lobstah
key reused as the routing key. Opt-in is per repo, never implied.

| Key | Default | Meaning |
|---|---|---|
| `identity` | required | The bot login work is assigned to / authored by. |
| `repo` | single-repo mode | `owner/name`. Omit for multi-repo mode. |
| `key` | single-repo mode | Lobstah repo key for dispatches and rebase chores. |
| `startLabel` | `lobstah` | Label + assignee + open = pickup. |
| `claimedLabel` | `lobstah:claimed` | Applied on claim. |

`[pickup.github.overrides.<key>]` — multi-repo per-repo overrides:
`startLabel`, `claimedLabel`, and a nested `merge` table layered over
`[pickup.github.merge]`.

### `[pickup.github.merge]` — off by default

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | |
| `method` | `squash` | |
| `approvers` | `[]` | The floor — always qualify, on every PR. |
| `assigneeApproves` | `true` | PR assignees also qualify… |
| `restrictedLabels` | `[]` | …except on PRs carrying any of these — the set collapses to the floor. Labels revoke, never grant. |
| `scope` | `own` | Merge only PRs authored by `identity`. |

See [pickup.md](pickup.md) for the loop semantics these keys drive.

## Environment

| Variable | Meaning |
|---|---|
| `LOBSTAH_HOME` | The instance root (default `~/.lobstah`). Multiple instances = multiple homes; one daemon per home, enforced. |
| `LOBSTAH_MAN` | `=1` designates a session as the lobstah man for the `man haul` Stop hook. |
