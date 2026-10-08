# lobstah for Codex 🦞✨

Run a fleet of supervised coding agents from one session: dispatch work, get
woken when something needs you, never watch the water.

This plugin wires [lobstah](https://github.com/aequitas-labs/lobstah) into
Codex with no settings surgery.

## What it installs

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah hook session-start`) | Announces the session's id and a one-line fleet state into the conversation, so every session starts oriented. A session that is neither helm nor trap gets the two copy-paste sign-on commands. |
| PostToolUse hook (`lobstah hook post-tool-use`) | Refreshes a soaking trap's liveness and records redacted activity after supported tool calls (Codex 0.117.0+). |
| Stop hook (`lobstah hook stop`) | Parks the session at turn end while work is in flight and wakes it the moment something needs attention. Inert unless the session holds the helm or is soaking (or the directory opts in with a `.lobstah-man` file or `LOBSTAH_MAN=1`). |
| SessionEnd hook (`lobstah hook session-end`) | Signs a soaking session off cleanly when it ends and keeps its worktree. |
| `man` skill (`$lobstah:man`) | Take the helm: sign on, start the glass, then orchestrate — the charter fences, dispatching, addressing traps, tending, getting woken. |
| `trap` skill (`$lobstah:trap`) | Sign on as a trap: soaking, its two-word name and `wt:` id, the sign-on title, the six report verbs, inbox, `paused --waiting-on` before external waits. |
| `stow` skill (`$lobstah:stow`) | Sign the trap off and report which trap was stowed. |
| `relieve` skill (`$lobstah:relieve`) | Step down from the helm; afterwards no `man wait` or `man report`, and no re-take unless asked. |

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
↗ open action. `lobstah focus <trap>` runs the same focus steps from the
CLI.

`lobstah soak` prints a two-word name alongside the stable `wt:<id>`.
`lobstah soak --name <word-word>` chooses or changes it. Use the name, `wt:<name>`,
or `wt:<id>` with `dispatch --for`, `send`, and `stow --wt`.

Signing on, the session id, getting woken, and how the
Codex CLI and desktop app differ are in
[docs/harness/codex.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/harness/codex.md). The quickstart, the same
in every harness, is in the
[README](https://github.com/aequitas-labs/lobstah#quickstart-the-lobstah-man-).

`lobstah send <id> "<instruction>"` steers live or queued work and wakes a
finished dispatch as a follow-up. `$lobstah:man`, `$lobstah:trap`,
`$lobstah:stow`, and `$lobstah:relieve` load the four skills.

Manual fallbacks without the helm: `touch .lobstah-man` in a project (every
session there parks as the lobstah man), or `LOBSTAH_MAN=1` for one launch.

Everything else — the manual, the pattern, the trade-offs — lives in
[docs/man.md](https://github.com/aequitas-labs/lobstah/blob/main/docs/man.md).

## Telemetry

This plugin sends nothing itself: its hooks run `lobstah` commands that only
read and write files under `~/.lobstah`. The `lobstah` CLI it drives shares an
anonymous daily count, on by default. Once per UTC day the lobstah daemon (not
a hook) sends `catches: {today, total}` for the UTC day and all-time, plus up
to 100 `traps: [{name, today, harness, model, config}]` entries with automatically generated names
and recorded provenance. Custom names (`--name`) and older names with unknown
provenance stay local; their catches remain in the totals. Names are not
hashed. A `helm` snapshot and up to 100 headless `byWorker` count buckets
include harness, catalog-only model id, and nullable reasoning effort and
permission-mode enums. Missing observations stay null; custom or unrecognised
models become `other`. No arbitrary config is sent. The payload also includes the lobstah version, OS family,
CPU architecture, the UTC date, and a random install id. It never sends
repository names or paths, code, briefs, session ids, PR URLs,
hostnames, or usernames. Nothing is sent until a one-time notice has been shown
in a terminal, and no release sends anything yet because the endpoint is not
set.

`lobstah telemetry show` prints the exact JSON. Turn it off with any one of:
`lobstah telemetry disable`, `[telemetry] share = false` in
`~/.lobstah/config.toml`, `LOBSTAH_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI` set.
Full details, including retention (90 days for per-install, per-trap and
worker/config rows; retained daily totals contain counts including harness/model
aggregates, no names or config), are in
[PRIVACY.md](https://github.com/aequitas-labs/lobstah/blob/main/PRIVACY.md).
