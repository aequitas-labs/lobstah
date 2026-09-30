# lobstah in Codex

Use `$lobstah:man` to load the lobstah man skill. You can also say
"Lobstah man, take the helm."

This page covers the plugin's skills, first sign-on with `--session`,
the blocking park, and the desktop app. See [docs/man.md](../man.md)
for the full pattern.

The lobstah man skill brings up the glass and prints its URL. Open it in the
desktop browser pane. `lobstah man helm` alone does not start the glass.

## Install

Codex v0.114+ (the hooks system).

```bash
npm i -g lobstah             # the plugin wires hooks to the CLI; it doesn't bundle it
codex plugin marketplace add aequitas-labs/lobstah
codex plugin add lobstah@lobstah
```

These are the commands verified from a Codex session (see the
[appendix](#appendix-verified-from-a-codex-session)). Plugin versions track
the CLI: plugin 0.5.10 goes with `lobstah` 0.5.10. After every
`npm i -g lobstah` (a patch release can change a skill too), run
`codex plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah`.
`lobstah doctor` shows a `plugin codex` row, and the session-start brief
says when the plugin is behind.

## What the plugin adds

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Prints the session id and a one-line fleet state. A session that is neither helm nor trap gets the two sign-on commands, with the id filled in. |
| Stop hook (`lobstah man haul`) | Parks the session at turn end while work is in flight and wakes it when something needs attention. Inert unless the session holds the helm or is soaking. |
| PostToolUse hook (`lobstah soak beat`) | After a tool call in a soaking session: refreshes the trap's liveness and writes its catch's activity. Needs Codex 0.117.0+ (see [below](#post-tool-hook-what-codex-has)). Older Codex ignores the event, and a trap's liveness then comes from its reports and its park only. |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off when it ends and keeps its worktree. |
| `man` skill | The orchestrator: the helm, the charter, dispatching, tending, getting woken, and sending a follow-up to finished work. |
| `trap` skill | The worker: soaking (in a linked worktree, or in one that soak creates), the `wt:` address, the six report verbs, and `paused --waiting-on` before external waits. |

`lobstah soak` prints a title at sign-on, `soak --wait` prints one with
the claimed work, and `report done` or `report failed` prints the trap
name again. The trap skill uses `set_thread_title` for the current thread
in the Codex app when available. It does not retry a refusal or approval
request. The CLI has no live title setter.

There are no slash commands: the Codex plugin layout has no commands
directory. The skills run the same `lobstah` commands as the README
quickstart.

## Invoking the skills

In the Codex CLI, `/skills` → **List skills** → filter `lobstah` shows
`man (lobstah)` and `trap (lobstah)`. Selecting them inserts the namespaced
mentions below. Plain-language requests load the same skills:

```text
/skills
$lobstah:man take the helm for this repo
$lobstah:trap work as a trap in this linked worktree
$lobstah:stow sign this trap off
$lobstah:relieve step down from the helm
```

The plugin has these four skills and no commands; the Claude Code plugin has
the same four.

The skill instructions lead to `lobstah man helm` and `lobstah soak`,
respectively. This verification stopped before running either sign-on
command. The desktop task's supplied skill catalog names
`lobstah:lobsterman` and `lobstah:trap`; *the desktop picker and its exact
inserted mention remain to be verified from the desktop UI*.

## Post-tool hook: what Codex has

Codex has a `PostToolUse` hook event, with the same `hooks.json` shape as
Claude Code. Verified in the openai/codex source at commit `e07e58c`:

- `codex-rs/hooks/src/lib.rs` lists `PostToolUse` among the hook event names,
  and `codex-rs/config/src/hook_config.rs` maps the `PostToolUse` key.
- The stdin payload (`PostToolUseCommandInput`, `codex-rs/hooks/src/schema.rs`)
  carries `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
  and `tool_response`: the fields `lobstah soak beat` reads.
- It arrived in 0.117.0 for shell commands only (openai/codex#15531), gained
  `apply_patch` and MCP tools in 0.124.0 (#18391, #18385), and other local
  function tools in 0.135.0 (#23757).
- It does not fire for hosted tools such as web search, and it fires only
  when the tool call succeeds (a shell command that exits non-zero still
  counts).

Docs: <https://developers.openai.com/codex/hooks>.

So on Codex 0.117.0+ a trap beats after its tool calls, like a Claude Code
trap. On 0.114 to 0.116, Codex has no post-tool hook: a trap's liveness
comes from its reports and its park only, and a long stretch of work
without a report can be swept after `[soak].ttlSecs`.

## Waiting on something external

Before a trap waits on a review, PR, deploy, person, or other external event,
it reports `paused "<note>" --waiting-on <kind> --link <url>`. Resume with a
`working` report. A Codex task cannot run an await as a tracked background
task: use the external tool's non-blocking form and end the turn. See
[Waiting on](../vocabulary.md#waiting-on).

`lobstah send <id> "<instruction>"` steers live or queued work and wakes a
finished dispatch as a follow-up.

## The session id and `--session`

Codex exports no session-id variable, so the CLI cannot find the id on its
own. Open a **new** task after installing the plugin. Its session-start
brief prints the task id. Pass it on first sign-on:

```bash
lobstah man helm --session <task-id>      # the helm
lobstah soak --session <task-id>          # a trap
```

After sign-on, the Stop hook gets the id from Codex on stdin. A trap's
identity is its worktree, so `lobstah soak --wait` in that worktree needs no
flags. Outside the trap's worktree, `soak --wait`, `report`, and `stow`
take `--session <task-id>`. Outside
the hook, `man wait`, `man report`, and `man relieve` still take
`--session <task-id>`.

Codex task ids are UUIDv7 (for example `01a0ceb8-b9bd-7d42-…`); Claude Code
session ids are UUIDv4. When both harnesses' variables are set, lobstah uses
this format to tell which one signed on.

For the glass's ↗ open button in the Codex desktop app, form
`codex://threads/<task-id>` from the task id in the session-start brief and
pass it with `lobstah soak --link <url>`. A Codex CLI session in a terminal
passes no link; soak ignores a link that does not fit the session. The glass checks the stored link before
showing it. `lobstah focus <trap>` uses the same focus steps from the
terminal.

## Getting woken: the blocking park

In Codex the Stop hook runs in **block** mode by default. At turn end with
work in flight, the hook waits (up to its 4-hour timeout), then continues
the turn with the event to handle: a worker's question, a catch, a message, or
the periodic digest (`[helm].reportSecs`). There is nothing to arm.

With no hook, run `lobstah man wait --session <task-id> --timeout 900` in
the foreground and loop on it (exit 3 is a timeout). A trap listens with
`lobstah soak --wait --timeout 600`.

## CLI vs desktop app

Verified from a Codex desktop task on PR #48 and in #55:

- **Skill names differed in this installation.** Codex CLI
  `0.155.0-alpha.16.4` with lobstah plugin `0.5.7` listed
  `man (lobstah)` / `trap (lobstah)` and inserted `$lobstah:man` /
  `$lobstah:trap`. This desktop task's injected catalog listed
  `lobstah:lobsterman` / `lobstah:trap` from a `0.5.5` plugin cache.
  These are different plugin versions, so this does not establish a
  desktop-versus-CLI rule. The desktop picker itself could not be
  inspected, so its insertion syntax is not asserted here.
- **Install mid-task gives no brief.** The plugin was installed while a
  desktop task was running, and no session-start brief appeared in that
  task. Open a new task after you install.
- **Desktop task ids are UUIDv7 thread ids**, the same format as CLI
  threads (`01a0ceb8-b9bd-7d42-927c-c52a334b8e2d`).
- **A desktop thread is not resumable from the CLI.** `codex exec resume`
  refused a desktop thread (`thread/resume failed: no rollout found for
  thread id …`), even with its rollout file on disk. lobstah recognizes a
  desktop thread by its rollout's originator (`Codex Desktop`,
  `codex_work_desktop`). A follow-up or resume of a dispatch that ran in
  one starts cold, with the note
  `Codex desktop thread; not resumable from the CLI (<id>), starting cold on <harness>`,
  and `lobstah attach` refuses with the same words. CLI threads
  (`codex_exec`, `codex_sdk_ts`) resume with `codex resume <id>` as usual.

Documented, not verified:

- **First-load trust review.** Codex asks for a one-time review of the
  plugin's hook definitions on first load.
- **The helm in a Codex task.** The `lobstah man helm` charter and the
  Stop-hook park at turn end are documented but have not yet been exercised
  from a Codex task. The verified session below was a trap.

## Appendix: verified from a Codex session

Desktop task `01a0ceb8-b9bd-7d42-927c-c52a334b8e2d`, plugin 0.5.7, trimmed
to the commands and their key output.

```text
$ codex plugin marketplace add aequitas-labs/lobstah
Marketplace `lobstah` is already added from https://github.com/aequitas-labs/lobstah.git.

$ codex plugin add lobstah@lobstah --json
pluginId: lobstah@lobstah
version: 0.5.7

$ lobstah doctor
plugin codex,ok,v0.5.7 matches CLI v0.5.7

$ lobstah soak --session 01a0ceb8-b9bd-7d42-927c-c52a334b8e2d
trap: wt:0a31bf2e
harness: codex (as signed on)

$ lobstah soak --wait --timeout 600
You are a lobstah worker session and have been assigned dispatch 1ca60b8a-22a9-42b3-abdd-0cd63091d1ce.

$ lobstah attach fa2c0d0b-303a-475b-b89c-85df8026eccb --print
harness: codex
command: codex resume 01a0ceb8-b9bd-7d42-927c-c52a334b8e2d

$ codex --version
codex-cli 0.155.0-alpha.16.4

$ /skills → List skills → filter lobstah
man (lobstah)   [Skill] Take the helm and orchestrate background coding work …
trap (lobstah)  [Skill] Volunteer this live session as a lobstah worker …

$ select man (lobstah)
inserted: $lobstah:man
prompt: $lobstah:man Explain the first action this skill instructs, but do not run commands or sign on.
Codex: The skill's first action is lobstah man helm, which signs on as the helm and prints the charter. I read the instructions and stopped; I did not run the command or sign on.

prompt: Take the helm for this repo. Before any command, identify which installed skill this wording selects and the first action it prescribes. Do not run anything.
Codex: “Take the helm” selects the installed lobstah:man skill. Its first action is lobstah man helm; I did not run it or any other command.

$ select trap (lobstah)
inserted: $lobstah:trap
prompt: $lobstah:trap Explain the first action this skill instructs, but do not run commands or sign on.
Codex: The lobstah:trap skill first instructs you to run lobstah soak from a linked worktree. I only read the instructions; I did not run a command or sign on.

prompt: Work as a lobstah trap in this linked worktree. Before any command, identify which installed skill this wording selects and its first action. Do not sign on or run anything.
Codex: “Work as a lobstah trap” selects the installed lobstah:trap skill. Its first action is lobstah soak from a linked worktree; I did not run it or any other command.
```

The desktop task's supplied skill catalog read:

```text
lobstah:lobsterman — Take the helm and orchestrate background coding work through lobstah …
lobstah:trap       — Volunteer this live session as a lobstah worker (a trap) …
```

The `attach` output predates #55. On current `main`, `attach` on a dispatch
whose session is a desktop thread refuses with
`Codex desktop thread; not resumable from the CLI`.
