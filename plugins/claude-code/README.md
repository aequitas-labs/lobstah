# lobstah for Claude Code 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Claude Code with no settings surgery — everything `lobstah man init` does by
hand, plus the skill and command.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. |
| Stop hook (`lobstah man haul`) | Parks the session at turn end while work is in flight and wakes it the moment something needs attention. Inert unless the directory opts in with a `.lobstah-man` file (or `LOBSTAH_MAN=1`), or the session is soaking. |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off cleanly when it ends. |
| `lobsterman` skill | The orchestrator's working knowledge: dispatching, tending, getting woken, soaking. |
| `/lobstah` command | Fleet status at a keystroke. |

## Requirements

- `npm i -g lobstah` — the plugin wires hooks to the CLI; it does not bundle it.
- A configured `~/.lobstah` (`lobstah init --scan ~/src`, then `lobstah doctor`).

## Install

```
/plugin marketplace add aequitas-labs/lobstah
/plugin install lobstah@lobstah
```

## Opting in

The park never conscripts a session. Three gates, any one suffices:

- `touch .lobstah-man` in a project — every session there acts as the
  lobsterman (orchestrator).
- `LOBSTAH_MAN=1` in the environment — this launch only.
- `lobstah soak --session <id>` — this session volunteers as a *worker* and
  takes dispatched bait (run it from a worktree; the id comes from the
  session-start brief).

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/lobsterman.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/lobsterman.md).
