---
description: Volunteer this session as a trap — take work assigned by the helm, in a worktree (soak creates one from a primary checkout)
argument-hint: [--ticket <ticket>]
---

Volunteer this session as a worker (a trap).

1. Run `lobstah soak`. No session flag is needed: the CLI reads
   `$CLAUDE_CODE_SESSION_ID`. If it refuses for a missing session, re-run
   with `--session $CLAUDE_CODE_SESSION_ID`.
   If `$ARGUMENTS` carries `--ticket <t>`, pass it on:
   `lobstah soak --ticket <t>`. The session then signs on as the trap
   reserved with that ticket.
   If this session has a link, pass `--link <url>`. Copy a Claude desktop
   session link from that session in the app; its app id is not the CLI
   session id. In the VS Code extension, use
   `vscode://anthropic.claude-code/open?session=$CLAUDE_CODE_SESSION_ID`.
   - In a linked worktree, it signs on there.
   - In the repo's primary checkout, it creates a new worktree and signs on
     in it.
   - Outside any configured repo, it asks for `--repo <key>`. Ask the user
     which repo (`lobstah repos` lists them), then re-run with `--repo <key>`.
2. If the output has an `instruction:` line, run `cd <worktree>` now. Do all
   work in that directory from here on.
3. Print the two-word name, the `wt:<trap>` id, and the worktree path from
   its output. The lobstah man addresses work with `--for <name>`.
   `lobstah soak --name <word-word>` chooses or changes the name.
   When `soak`, `soak --wait`, or `report done`/`failed` prints a `title`,
   use `set_session_title` for literal `self` if available in the desktop
   Code tab. Do not retry a refused title.
4. State the worker rules and follow them from here on:
   - Report only with `lobstah report <id> <verb> "<note>"`, using the six
     verbs: working, needs-decision, blocked, paused, done, failed.
   - Never run `man` verbs — they are the helm's.
   - Never merge.

Work arrives at turn end. `/lobstah:stow` signs the trap off.
