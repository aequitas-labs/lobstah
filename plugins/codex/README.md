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
| `man` skill | The orchestrator: taking the helm, the charter fences, dispatching, addressing traps, tending, getting woken, relieving. |
| `trap` skill | The worker: soaking from a linked worktree, the `wt:` address, the six report verbs, inbox, stowing. |

## Requirements

- Codex v0.114+ (the hooks system). Expect a one-time trust review of the
  hook definitions on first load.
- `npm i -g lobstah` — the plugin wires hooks to the CLI; it does not bundle it.
- A configured `~/.lobstah` (`lobstah init --scan ~/src`, then `lobstah doctor`).

## Install

```bash
codex plugin marketplace add aequitas-labs/lobstah
codex plugin add lobstah@lobstah
```

The plugin's version tracks the CLI's: plugin 0.5.x is written for
`lobstah` 0.5.x, since its skills describe CLI verbs. After `npm i -g
lobstah` moves to a new minor version, update the plugin too with `codex
plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah`.
`lobstah doctor` shows a `plugin codex` row, and the session-start brief
adds one line when the installed plugin is behind.

## Using it

The hooks never conscript a session: they stay inert until a session signs
on as the helm (`lobstah man helm`) or as a trap (`lobstah soak`, from a
linked worktree). Signing on, the session id, getting woken, and how the
Codex CLI and desktop app differ are in
[docs/harness/codex.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/harness/codex.md). The quickstart, the same
in every harness, is in the
[README](https://github.com/aequitas-labs/lobstah#quickstart-the-lobstah-man-).

Manual fallbacks without the helm: `touch .lobstah-man` in a project (every
session there parks as the lobstah man), or `LOBSTAH_MAN=1` for one launch.

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/man.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/man.md).
