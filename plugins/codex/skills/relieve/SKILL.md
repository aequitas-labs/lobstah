---
name: relieve
description: Step down from the helm — this session stops orchestrating lobstah work. Use when the user asks to relieve, step down, give up the helm, or stop orchestrating.
---

# Relieve the helm

Invoke `$lobstah:relieve` to load this skill.

Run `lobstah man relieve --session <task-id>`, with the task id from the
session-start brief (Codex exports no session variable). If it reports
`(none held)` or refuses, check the id and run it again.

Report which grounds were relieved. From here on, this session no longer
orchestrates: do not run `man wait` or `man report`, and do not re-take the
helm unless the user asks.
