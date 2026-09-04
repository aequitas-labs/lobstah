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
| `remindSecs` | `900` | An unanswered `needs-decision`/`blocked` re-fires to `man wait`/`man haul` on this interval until answered. `0` = report once only. |

## `[repos.<key>]` — workspace definitions

The descriptor's `repo` field resolves here; the key is what dispatchers name.

| Key | Required | Meaning |
|---|---|---|
| `path` | yes | The git clone worktrees are allocated from (`~/` expands). |
| `trunk` | yes (default `main`) | Branch dispatches start from (`origin/<trunk>`). |
| `origin` | no | Enables clone-on-first-use when `path` doesn't exist. |
| `setup` | no | Commands run in each fresh worktree, in order (e.g. `["pnpm install"]`). |
| `env` | no | Environment merged into every dispatch for this repo. |
| `pickup` | no (`false`) | Opt this repo into `[pickup.github]` multi-repo mode. Explicit per repo — nothing becomes pickable by being configured. |

`[repos.<key>.harness]` — per-repo harness defaults: `default` (`claude` \|
`codex`), `model`, `effort`.

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
| `maxConcurrent` | `2` | Work-lane dispatches running at once. |
| `choreConcurrent` | `1` | Chore-lane ceiling (rebases and other machine-originated runs). |
| `wedgeThresholdSecs` | `600` | No tool activity for this long while alive = wedged → killed and forked with a nudge. |
| `maxRestartAttempts` | `2` | Bounded restart ladder for dead and wedged runners. |
| `wallClockSecs` | `3600` | Hard per-dispatch ceiling, enforced by the runner. |
| `choreRetentionDays` | `7` | Completed chores age out of `chores/done/`. |

## `[soak]` — soaking sessions (`lobstah soak`)

| Key | Default | Meaning |
|---|---|---|
| `deferSecs` | `90` | A soaking session whose park heartbeat is this fresh holds unaddressed matching bait — the daemon waits instead of spawning. Addressed bait (`--for session:<id>`) waits regardless, until the registration is gone. |
| `ttlSecs` | `1800` | Heartbeat age past which a registration is a ghost trap: the sweep removes it and requeues its open catch (or finalizes a cancelled one as failed). A fresh `lobstah report` on the catch counts as liveness too. |

## `[helm]` — the orchestrator seat (`lobstah man helm`)

| Key | Default | Meaning |
|---|---|---|
| `ttlSecs` | `1800` | Heartbeat age past which a helm registration is stale: the next `man helm` claims it without `--take`. The park and `man brief` heartbeat it. |
| `reportSecs` | `900` | Minimum seconds between park-delivered digests for a helm session. The digest is also change-gated — quiet grounds deliver nothing regardless of cadence. |

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
| `LOBSTAH_MAN` | `=1` designates a session as the lobsterman for the `man haul` Stop hook. |
