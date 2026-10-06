# lobstah for Claude Code 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Claude Code with no settings surgery — everything `lobstah man init` does by
hand, plus four skills.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah hook session-start`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. A session that is neither helm nor trap gets the two copy-paste sign-on commands. |
| PostToolUse hook (`lobstah hook post-tool-use`) | Refreshes a soaking trap's liveness and records redacted activity after tool calls. |
| Stop hook (`lobstah hook stop`) | Checks for an armed watcher while work is in flight; `--park` waits in the hook. Inert unless the session holds the helm or is soaking (or the directory opts in with a `.lobstah-man` file or `LOBSTAH_MAN=1`). |
| SessionEnd hook (`lobstah hook session-end`) | Signs a soaking session off cleanly when it ends and keeps its worktree. |
| `man` skill (`/lobstah:man`) | Take the helm: sign on, start the glass, then orchestrate — the charter fences, dispatching, addressing traps, tending, getting woken. |
| `trap` skill (`/lobstah:trap`) | Sign on as a trap: soaking, its two-word name and `wt:` id, the sign-on title, the six report verbs, inbox. |
| `stow` skill (`/lobstah:stow`) | Sign the trap off and report which trap was stowed. |
| `relieve` skill (`/lobstah:relieve`) | Step down from the helm; afterwards no `man wait` or `man report`, and no re-take unless asked. |

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
↗ open action. `lobstah focus <trap>` runs the same focus steps from the
CLI.

`lobstah soak` prints a two-word name alongside the stable `wt:<id>`.
`lobstah soak --name <word-word>` chooses or changes it. Use the name, `wt:<name>`,
or `wt:<id>` with `dispatch --for`, `send`, and `stow --wt`.

Signing on, the session id, getting woken, and how the
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

## Telemetry

This plugin sends nothing itself: its hooks run `lobstah` commands that only
read and write files under `~/.lobstah`. The `lobstah` CLI it drives shares an
anonymous daily count, on by default. Once per UTC day the lobstah daemon (not
a hook) sends `catches: {today, total}` for the UTC day and all-time, plus up
to 100 `traps: [{name, today}]` entries with automatically generated names
and recorded provenance. Custom names (`--name`) and older names with unknown
provenance stay local; their catches remain in the totals. Names are not
hashed. The payload also includes the lobstah version, OS family,
CPU architecture, the UTC date, and a random install id. It never sends
repository names or paths, code, briefs, session ids, PR URLs,
hostnames, or usernames. Nothing is sent until a one-time notice has been shown
in a terminal, and no release sends anything yet because the endpoint is not
set.

`lobstah telemetry show` prints the exact JSON. Turn it off with any one of:
`lobstah telemetry disable`, `[telemetry] share = false` in
`~/.lobstah/config.toml`, `LOBSTAH_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI` set.
Full details, including retention (90 days for per-install and per-trap rows;
retained daily totals have no names), are in
[PRIVACY.md](https://github.com/aequitas-labs/lobstah/blob/main/PRIVACY.md).
