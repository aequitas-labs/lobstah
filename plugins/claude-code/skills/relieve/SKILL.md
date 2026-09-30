---
name: relieve
description: Step down from the helm — this session stops orchestrating lobstah work. Use when the user asks to relieve, step down, give up the helm, or stop orchestrating.
---

# Relieve the helm

Invoke `/lobstah:relieve` to load this skill.

Run `lobstah man relieve`. No session flag is needed: the CLI reads
`$CLAUDE_CODE_SESSION_ID`. If it reports `(none held)` or refuses, re-run
with `--session $CLAUDE_CODE_SESSION_ID`.

Report which grounds were relieved. From here on, this session no longer
orchestrates: do not run `man wait` or `man report`, and do not re-take the
helm unless the user asks.
