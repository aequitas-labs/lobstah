---
description: Volunteer this session as a trap — take work assigned by the helm, from a linked worktree
---

Volunteer this session as a worker (a trap).

1. Check where you stand: compare `git rev-parse --git-dir` with
   `git rev-parse --git-common-dir`. If they are the same path, this is the
   repo's primary checkout. Refuse: explain that traps never work in the
   primary checkout, and tell the user to create a linked worktree
   (`git worktree add ../<name> -b <branch>`) and start a session there.
   Stop.
2. Otherwise run `lobstah soak`. No session flag is needed: the CLI reads
   `$CLAUDE_CODE_SESSION_ID`. If it refuses for a missing session, re-run
   with `--session $CLAUDE_CODE_SESSION_ID`.
3. Print the `wt:<trap>` address from its output — the helm addresses work
   here with `--for wt:<trap>`.
4. State the worker rules and follow them from here on:
   - Report only with `lobstah report <id> <verb> "<note>"`, using the six
     verbs: working, needs-decision, blocked, paused, done, failed.
   - Never run `man` verbs — they are the helm's.
   - Never merge.

Work arrives at turn end. `/lobstah:stow` signs the trap off.
