# lobstah for Claude Code 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Claude Code with no settings surgery — everything `lobstah man init` does by
hand, plus the skills and commands.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. A session that is neither helm nor trap gets the two copy-paste sign-on commands. |
| PostToolUse hook (`lobstah soak beat`) | Refreshes a soaking trap's liveness and records redacted activity after tool calls. |
| Stop hook (`lobstah man haul`) | Checks for an armed watcher while work is in flight; `--park` waits in the hook. Inert unless the session holds the helm or is soaking (or the directory opts in with a `.lobstah-man` file or `LOBSTAH_MAN=1`). |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off cleanly when it ends and keeps its worktree. |
| `man` skill | The orchestrator: taking the helm, the charter fences, dispatching, addressing traps, tending, getting woken, relieving. |
| `trap` skill | The worker: soaking (in a linked worktree, or in one that soak creates), the `wt:` address, the six report verbs, inbox, stowing. |
| `/lobstah:helm` · `/lobstah:relieve` | Take the helm (optionally for a named grounds) and step down. |
| `/lobstah:soak` · `/lobstah:stow` | Volunteer this session as a trap, and sign it off. |
| `/lobstah:tend` command | Fleet status at a keystroke. |

## Requirements

- `npm i -g lobstah` — the plugin wires hooks to the CLI; it does not bundle it.
- A configured `~/.lobstah` (`lobstah init --scan ~/src`, then `lobstah doctor`).

## Install

```
/plugin marketplace add aequitas-labs/lobstah
/plugin install lobstah@lobstah
```

The plugin's version tracks the CLI's: plugin 0.5.10 is written for
`lobstah` 0.5.10, since its skills and commands describe CLI verbs. After
every `npm i -g lobstah`, update the plugin too with
`/plugin update lobstah@lobstah`. `lobstah doctor` shows a `plugin claude`
row, and the session-start brief adds one line when the installed plugin is
behind.

## Using it

The hooks never conscript a session: they stay inert until a session signs
on as the helm (`lobstah man helm`) or as a trap (`lobstah soak`). In a
repo's primary checkout, `lobstah soak` creates a linked worktree for the
trap; `lobstah stow` removes it unless it holds work that exists nowhere
else or `--keep` is passed.

`lobstah soak --link <url>` records the session's own link for the glass's
Open window action. `lobstah focus <trap>` runs the same focus steps from the
CLI. Signing on, the session id, getting woken, and how the
Claude Code CLI and desktop app differ are in
[docs/harness/claude-code.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/harness/claude-code.md). The quickstart, the same
in every harness, is in the
[README](https://github.com/aequitas-labs/lobstah#quickstart-the-lobstah-man-).

`lobstah send <id> "<instruction>"` steers live or queued work and wakes a
finished dispatch as a follow-up. The trap skill reports `paused --waiting-on`
before external waits.

Manual fallbacks without the helm: `touch .lobstah-man` in a project (every
session there parks as the lobstah man), or `LOBSTAH_MAN=1` for one launch.

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/man.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/man.md).
