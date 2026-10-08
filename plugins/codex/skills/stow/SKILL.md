---
name: stow
description: Sign this session's trap off — stop taking work from the helm. Use when the user asks to stow, sign the trap off, stop taking lobstah work, or leave the fleet as a worker.
---

# Stow the trap

Invoke `$lobstah:stow` to load this skill.

Run `lobstah stow` in the trap's worktree. Codex exports no session
variable: outside the worktree, or if it finds nothing to stow, re-run with
`--session <task-id>` from the session-start brief. Stow keeps the worktree.
If the user asks to remove it, add `--remove`.

Report the result: the stowed two-word name and `wt:<trap>` id, any catch it
requeued or messages it bounced back to the helm, and the worktree line:

- `worktree: kept` — the default; report the `reason:` line.
- `worktree: removed` (with `--remove`) — soak created it and it held no
  unpushed work. Run `cd` to the `returnTo:` path and work from there.

From here on, this session takes no more assigned work.
