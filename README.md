# lobstah 🦞✨

*Nobody stares at the water.*

[![CI](https://github.com/aequitas-labs/lobstah/actions/workflows/ci.yml/badge.svg)](https://github.com/aequitas-labs/lobstah/actions/workflows/ci.yml)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue)
[![npm](https://img.shields.io/npm/v/lobstah)](https://www.npmjs.com/package/lobstah)
![Harnesses](https://img.shields.io/badge/harnesses-Claude%20Code%20%7C%20Codex-8A2BE2)

Harness-agnostic, token-efficient supervision framework for coding agents.

You were promised agents that do the work. Somehow, watching them became the
work: which one is stuck, which one is waiting on an answer nobody saw, which
one died forty minutes ago. Watching is why you run two agents instead of
ten.

A trap doesn't fish faster for being watched, and an agent doesn't code
faster either. You **lob** bait into a trap and walk away. Each dispatch runs
in its own git worktree; the daemon tells a dead process from a wedged one
and recovers each; status and evidence land on disk. Supervision costs
nothing — no tokens, no attention — so the whole fleet fits in one
conversation, and **your agents just bring home the lobstahs**.

## Requirements 📋

- Node 20+, git, pnpm
- An authenticated harness CLI: `claude` (Claude Code) and/or Codex. Lobstah
  never handles harness login — you authenticate your own CLI; lobstah invokes it.

## Install ⚓

```bash
npm i -g lobstah
```

Or from source:

```bash
git clone https://github.com/aequitas-labs/lobstah
cd lobstah
pnpm install && pnpm build
ln -s "$PWD/bin/lobstah" /usr/local/bin/lobstah   # Windows: add .\bin to PATH
```

## Quick start 🪝

```bash
lobstah init                 # ~/.lobstah + example config
$EDITOR ~/.lobstah/config.toml
lobstah daemon &             # under tmux/pm2/launchd for real use
lobstah dispatch --repo myapp --brief ./brief.md
```

```toml
[repos.myapp]
path  = "~/src/myapp"
trunk = "main"
setup = ["pnpm install"]     # runs in each fresh worktree
```

Every key, with defaults: [docs/configuration.md](docs/configuration.md).

Watch, steer, take over:

```bash
lobstah ls                            # queue, active, recent done
lobstah status <uuid>                 # reconciled state + last note
lobstah logs <uuid> --follow          # normalized event stream
lobstah send <uuid> "also update the docs"   # delivered between turns
lobstah attach <uuid>                 # open the agent's own session in its worktree
lobstah swap <uuid> --harness codex   # hand an active dispatch to a fresh session
lobstah catch <uuid>                  # the evidence: branch, commits, PR, session
lobstah cancel <uuid>
lobstah cull --apply                  # sweep aged results and orphaned worktrees
lobstah man tend                      # the whole string: fleet verdict, waiting
                                      # questions, each item's chain + PR + gate
```

Prefer the water? 🌊 `set --bait`, `buoys`, and `buoy` alias `dispatch`,
`ls`, and `status`.

Dispatches report six verbs: `working`, `needs-decision`, `blocked`,
`paused`, `done`, `failed`. The write path rejects anything else. `done`
means the brief is fulfilled. Merging is never the dispatch's job.

Everything lives under `$LOBSTAH_HOME` (default `~/.lobstah`). To run more
instances, use more homes. One daemon per home, enforced.

## When something needs you 🛎️

Set one config line — `notifyCommand = "ntfy pub my-topic ..."` — and the
daemon pings you on `needs-decision`, `blocked`, `done`, and `failed`. No
model in the loop. Driving lobstah from an agent session instead? `lobstah
man` prints the lobsterman's manual. `man wait` blocks until a dispatch needs
attention, and unanswered questions re-fire until answered. `man init`
installs a Claude Code Stop hook that parks the session on the fleet and
continues the turn the moment something needs it.

## Add-ons 🎣

- **Tracker pickup** — `lobstah pick` polls Linear and GitHub outbound (no
  webhooks, no tunnel), dispatches assigned work, streams status back as
  comments, forwards replies into the running dispatch, reconciles drift, and
  optionally merges approved PRs. [docs/pickup.md](docs/pickup.md)
- **OpenClaw plugin** — gives fleet agents `lobstah_dispatch` / `lobstah_status`
  / `lobstah_send` / `lobstah_cancel` tools and operators a `/lobstah` command.
  [docs/openclaw.md](docs/openclaw.md)
- **The lobsterman** — one interactive agent session that dispatches,
  supervises, and hands you outcomes, woken by the `lobstah man` commands.
  [docs/lobsterman.md](docs/lobsterman.md)

## How it holds together 🧭

```
CLI / pick / OpenClaw plugin / anything ──writes──>  ~/.lobstah/queue/
                                                           │ claim (atomic rename)
daemon ──spawn──> runner (one per dispatch) ──SDK──> harness CLI
   │                  │
   │                  └── worktree per dispatch · status/evidence/events on disk
   └── dead/wedged classification · bounded restart ladder · zero tokens
```

Design: [docs/design.md](docs/design.md). Every verb, verdict, and gate in
one place: [docs/vocabulary.md](docs/vocabulary.md).
Verified by CI on Linux and Windows, by live end-to-end runs on both
harnesses, and by fault-injection drills. A SIGKILL'd runner respawns and
completes. A SIGSTOP'd one is classified wedged, killed cleanly, and recovers
with a nudge.

## Non-goals

No webhooks or inbound listeners, no merge decisions in core, no tracker
vocabulary in core, no hosted service.

## License

[MIT](LICENSE)
