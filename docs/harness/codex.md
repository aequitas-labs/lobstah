# lobstah in Codex

The [README quickstart](../../README.md#quickstart-the-lobstah-man-) is the
same in every harness: it uses only `lobstah` commands. This page covers
what the Codex plugin adds and where Codex differs: skills instead of slash
commands, `--session` on first sign-on, the blocking park, and the desktop
app. For the pattern itself, see [docs/man.md](../man.md).

## Install

Codex v0.114+ (the hooks system).

```bash
npm i -g lobstah             # the plugin wires hooks to the CLI; it doesn't bundle it
codex plugin marketplace add aequitas-labs/lobstah
codex plugin add lobstah@lobstah
```

These are the commands verified from a Codex session (see the
[appendix](#appendix-verified-from-a-codex-session)). Plugin versions track
the CLI: plugin 0.5.x goes with `lobstah` 0.5.x. When `npm i -g lobstah`
moves to a new minor version, run
`codex plugin marketplace upgrade lobstah && codex plugin add lobstah@lobstah`.
`lobstah doctor` shows a `plugin codex` row, and the session-start brief
says when the plugin is behind.

## What the plugin adds

| Piece | What it does |
| ----- | ------------ |
| SessionStart hook (`lobstah man brief`) | Prints the session id and a one-line fleet state. A session that is neither helm nor trap gets the two sign-on commands, with the id filled in. |
| Stop hook (`lobstah man haul`) | Parks the session at turn end while work is in flight and wakes it when something needs attention. Inert unless the session holds the helm or is soaking. |
| SessionEnd hook (`lobstah stow --quiet`) | Signs a soaking session off when it ends. |
| `man` skill | The orchestrator: the helm, the charter, dispatching, tending, getting woken. |
| `trap` skill | The worker: soaking from a linked worktree, the `wt:` address, the six report verbs. |

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
```

The skill instructions lead to `lobstah man helm` and `lobstah soak`,
respectively. This verification stopped before running either sign-on
command. The desktop task's supplied skill catalog names
`lobstah:lobsterman` and `lobstah:trap`; *the desktop picker and its exact
inserted mention remain to be verified from the desktop UI*.

## The session id and `--session`

Codex exports no session-id variable, so the CLI cannot find the id on its
own. Open a **new** task after installing the plugin. Its session-start
brief prints the task id. Pass it on first sign-on:

```bash
lobstah man helm --session <task-id>      # the helm
lobstah soak --session <task-id>          # a trap, from a linked worktree
```

After sign-on, the Stop hook gets the id from Codex on stdin. A trap's
identity is its worktree, so `lobstah soak --wait` needs no flags. Outside
the hook, `man wait`, `man report`, and `man relieve` still take
`--session <task-id>`.

Codex task ids are UUIDv7 (for example `01a0ceb8-b9bd-7d42-…`); Claude Code
session ids are UUIDv4. When both harnesses' variables are set, lobstah uses
this format to tell which one signed on.

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
