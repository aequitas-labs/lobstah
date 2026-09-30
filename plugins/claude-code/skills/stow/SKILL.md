---
name: stow
description: Sign this session's trap off — stop taking work from the helm. Use when the user asks to stow, sign the trap off, stop taking lobstah work, or leave the fleet as a worker.
---

# Stow the trap

Invoke `/lobstah:stow` to load this skill.

Run `lobstah stow`. No session flag is needed: the CLI reads
`$CLAUDE_CODE_SESSION_ID`. If it finds nothing to stow, re-run with
`--session $CLAUDE_CODE_SESSION_ID`. If the user asks to keep the worktree,
add `--keep`.

Report the result: the stowed two-word name and `wt:<trap>` id, any catch it
requeued or messages it bounced back to the helm, and the worktree line:

- `worktree: removed` — soak created it and it held no unpushed work. Run
  `cd` to the `returnTo:` path and work from there.
- `worktree: kept` — report the `reason:` line.

From here on, this session takes no more assigned work.
