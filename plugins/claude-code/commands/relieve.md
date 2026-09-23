---
description: Step down from the helm — this session stops orchestrating
---

Run `lobstah man relieve`. No session flag is needed: the CLI reads
`$CLAUDE_CODE_SESSION_ID`. If it reports `(none held)` or refuses, re-run
with `--session $CLAUDE_CODE_SESSION_ID`.

Report which grounds were relieved. From here on, this session no longer
orchestrates: do not run `man wait` or `man report`, and do not re-take the
helm unless the user asks.
