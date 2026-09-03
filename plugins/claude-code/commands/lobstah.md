---
description: Tend the lobstah fleet — status of every dispatch, waiting questions, and what needs you
argument-hint: [dispatch id, or a question about the fleet]
---

Run `lobstah man tend` and report what it shows: the fleet verdict, any
unanswered questions with their ages, and each work item's state. Surface
anything waiting on a human first, with the exact `lobstah send <id> "..."`
command to answer it.

If `$ARGUMENTS` names a dispatch id, run `lobstah status $ARGUMENTS`,
`lobstah catch $ARGUMENTS`, and (if more detail is needed) `lobstah logs
$ARGUMENTS`, then summarize that dispatch instead. If `$ARGUMENTS` asks
something else about the fleet, answer it from `lobstah man tend --json` and
the working-set commands rather than guessing.
