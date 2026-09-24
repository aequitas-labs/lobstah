# lobstah in Claude Code

The [README quickstart](../../README.md#quickstart-the-lobstah-man-) is the
same in every harness: it uses only `lobstah` commands. This page covers
what the Claude Code plugin adds on top: slash commands, skills, how the
session gets its id, and how the Stop hook wakes you. For the pattern
itself, see [docs/man.md](../man.md).

## Install

```bash
npm i -g lobstah             # the plugin wires hooks to the CLI; it doesn't bundle it
```

In Claude Code:

```
/plugin marketplace add aequitas-labs/lobstah
/plugin install lobstah@lobstah
```

Plugin versions track the CLI: plugin 0.5.x goes with `lobstah` 0.5.x.
When `npm i -g lobstah` moves to a new minor version, run
`/plugin update lobstah@lobstah`. `lobstah doctor` shows a `plugin claude`
row, and the session-start brief says when the plugin is behind.

## What the plugin adds

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Prints the session id and a one-line fleet state. A session that is neither helm nor trap gets the two sign-on commands, with the id filled in. |
| Stop hook (`lobstah man haul`) | At turn end, blocks with standing attention, or with the command to arm a watcher while work is in flight. Inert unless the session holds the helm or is soaking. |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off when it ends. |
| `man` skill | The orchestrator: the helm, the charter, dispatching, tending, getting woken. |
| `trap` skill | The worker: soaking from a linked worktree, the `wt:` address, the six report verbs. |

Slash commands, each a shortcut for a CLI verb:

| Command | CLI equivalent |
| ------- | -------------- |
| `/lobstah:helm [grounds]` | `lobstah man helm` |
| `/lobstah:relieve` | `lobstah man relieve` |
| `/lobstah:tend` | `lobstah man tend` |
| `/lobstah:soak` | `lobstah soak` (from a linked worktree) |
| `/lobstah:stow` | `lobstah stow` |

Claude Code also loads the `man` and `trap` skills on its own when you ask
for that kind of work ("take the helm", "work as a trap").

## The session id

Claude Code exports `CLAUDE_CODE_SESSION_ID` to every command, and the CLI
reads it, so no `--session` flag is needed. The session-start brief still
prints the id, and the sign-on commands with the id filled in, if you want
to pass `--session` explicitly. Claude Code session ids are UUIDv4.

## Getting woken: arm the watcher

In Claude Code the Stop hook runs in **arm** mode by default. At turn end
with work in flight:

- If a watcher is live, the hook allows the stop.
- If no watcher is live, the hook blocks and prints the arm command:
  `lobstah man wait --session <id> --timeout 900`, to run as a background
  task. Re-arm it after each completion.
- Standing attention (an unanswered question) always blocks with the
  question.

A trap arms `lobstah soak --wait --timeout 900` the same way.
`lobstah man haul --park` or `[helm].park = "block"` in `config.toml`
switches to the blocking park instead: the hook itself waits (up to its
4-hour timeout) for something to need attention.

Without the plugin, `lobstah man init` merges the Stop hook into
`.claude/settings.local.json` (`--shared` for the committed
`.claude/settings.json`, `--global` for `~/.claude/settings.json`). See
[docs/man.md](../man.md#getting-woken-instead-of-asked).

## CLI vs desktop app

The plugin, hooks, skills, and slash commands are the same whether you run
`claude` in a terminal or use the Code tab of the Claude desktop app. What
differs:

- **The watcher is visible in the desktop app.** An armed `man wait` or
  `soak --wait` is a background task, and the desktop app's task pane shows
  it. In a terminal it runs as a background task of the session, with no
  separate pane.
- **Messages queue while a hook blocks.** While the Stop hook is running
  (the blocking park, or a wait inside the hook), a message you type is
  queued until the turn ends. The desktop app offers **Send now** to
  deliver it at once. Arm mode keeps the hook short, so messages rarely
  wait.
- **Pushes can need approval.** The desktop app's permission classifier can
  hold a `git push` from a helm or trap for your approval. Expect that
  prompt before you leave a trap to work alone.
- **Session lists show dispatch sessions.** Every dispatch is a real Claude
  Code session, so the desktop app's session list shows it, as
  `claude --resume` does in a terminal. `lobstah attach <id>` opens the
  worker's session in its worktree with `claude --resume <sessionId>`, in a
  terminal.
