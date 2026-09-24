---
description: Take the helm — sign this session on as the lobsterman for the fleet or a named grounds
argument-hint: [grounds name]
---

Take the helm for this session.

1. Run `lobstah man helm` — add `--grounds $ARGUMENTS` if `$ARGUMENTS` names
   a grounds. No session flag is needed: the CLI reads
   `$CLAUDE_CODE_SESSION_ID`. If it refuses for a missing or mismatched
   session, re-run with `--session $CLAUDE_CODE_SESSION_ID`.
2. If it refuses because another session holds a live helm, report who holds
   it and stop. Do not pass `--take` unless the user asks to displace them.
3. On success, print the charter's **Role** and **Fences** sections verbatim.
4. Run `lobstah man wait --peek` and surface anything standing — questions
   waiting on a human first, with the exact `lobstah send <id> "..."` to
   answer each.

From here on, act as the lobsterman: dispatch, do not do the work inline,
never merge. `/lobstah:relieve` steps down.
