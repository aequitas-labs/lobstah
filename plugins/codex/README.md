# lobstah for Codex 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Codex with no settings surgery.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. A session that is neither helm nor trap gets the two copy-paste sign-on commands. |
| Stop hook (`lobstah man haul`) | Parks the session at turn end while work is in flight and wakes it the moment something needs attention. Inert unless the session holds the helm or is soaking (or the directory opts in with a `.lobstah-man` file or `LOBSTAH_MAN=1`). |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off cleanly when it ends. |
| `lobsterman` skill | The orchestrator: taking the helm, the charter fences, dispatching, addressing traps, tending, getting woken, relieving. |
| `trap` skill | The worker: soaking from a linked worktree, the `wt:` address, the six report verbs, inbox, stowing. |

## Requirements

- Codex v0.114+ (the hooks system). Expect a one-time trust review of the
  hook definitions on first load.
- `npm i -g lobstah` — the plugin wires hooks to the CLI; it does not bundle it.
- A configured `~/.lobstah` (`lobstah init --scan ~/src`, then `lobstah doctor`).

## Install

```
/plugin marketplace add aequitas-labs/lobstah
/plugin install lobstah@lobstah
```

The plugin's version tracks the CLI's: plugin 0.5.x is written for
`lobstah` 0.5.x, since its skills describe CLI verbs. After `npm i -g
lobstah` moves to a new minor version, update the plugin too with `codex
plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah`.
`lobstah doctor` shows a `plugin codex` row, and the session-start brief
adds one line when the installed plugin is behind.

## Opting in

The park never conscripts a session. A session opts in as one of two roles:

| Role | How | What it does |
| ---- | --- | ------------ |
| Helm (orchestrator) | `lobstah man helm` | Signs on as the one lobsterman for its grounds: prints the charter, parks at turn end, and receives wakes and digests. `lobstah man relieve` steps down. |
| Trap (worker) | `lobstah soak` from a linked worktree | Takes work the helm addresses to its `wt:<trap>` address. Never from the primary checkout. `lobstah stow` signs off. |

Codex documents no session-id environment variable, so pass the id the
session-start brief prints: `lobstah man helm --session <id>` or
`lobstah soak --session <id>`. Codex ships the two skills, not slash
commands — its plugin layout has no commands directory.

Manual fallbacks without the helm: `touch .lobstah-man` in a project (every
session there parks as the lobsterman), or `LOBSTAH_MAN=1` for one launch.

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/lobsterman.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/lobsterman.md).
