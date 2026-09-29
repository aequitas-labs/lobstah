# lobstah for Codex 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Codex with no settings surgery.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. A session that is neither helm nor trap gets the two copy-paste sign-on commands. |
| PostToolUse hook (`lobstah soak beat`) | Refreshes a soaking trap's liveness and records redacted activity after supported tool calls (Codex 0.117.0+). |
| Stop hook (`lobstah man haul`) | Parks the session at turn end while work is in flight and wakes it the moment something needs attention. Inert unless the session holds the helm or is soaking (or the directory opts in with a `.lobstah-man` file or `LOBSTAH_MAN=1`). |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off cleanly when it ends and keeps its worktree. |
| `man` skill | The orchestrator: taking the helm, the charter fences, dispatching, addressing traps, tending, getting woken, relieving. |
| `trap` skill | The worker: soaking (in a linked worktree, or in one that soak creates), the `wt:` address, the six report verbs, inbox, `paused --waiting-on` before external waits, stowing. |

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

The plugin's version tracks the CLI's: plugin 0.5.10 is written for
`lobstah` 0.5.10, since its skills describe CLI verbs. After every
`npm i -g lobstah`, update the plugin too with `codex
plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah`.
`lobstah doctor` shows a `plugin codex` row, and the session-start brief
adds one line when the installed plugin is behind.

## Using it

The hooks never conscript a session: they stay inert until a session signs
on as the helm (`lobstah man helm`) or as a trap (`lobstah soak`). In a
repo's primary checkout, `lobstah soak` creates a linked worktree for the
trap; `lobstah stow` removes it unless it holds work that exists nowhere
else or `--keep` is passed.

`lobstah soak --link <url>` records the task's own link for the glass's
Open window action. `lobstah focus <trap>` runs the same focus steps from the
CLI. Signing on, the session id, getting woken, and how the
Codex CLI and desktop app differ are in
[docs/harness/codex.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/harness/codex.md). The quickstart, the same
in every harness, is in the
[README](https://github.com/aequitas-labs/lobstah#quickstart-the-lobstah-man-).

`lobstah send <id> "<instruction>"` steers live or queued work and wakes a
finished dispatch as a follow-up. Use `$lobstah:man` or `$lobstah:trap` to
load the skills; Codex has no `/lobstah:*` commands.

Manual fallbacks without the helm: `touch .lobstah-man` in a project (every
session there parks as the lobstah man), or `LOBSTAH_MAN=1` for one launch.

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/man.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/man.md).
