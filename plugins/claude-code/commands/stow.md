---
description: Sign this session's trap off — stop taking work from the helm
---

Run `lobstah stow` from this worktree. No session flag is needed: the CLI
reads `$CLAUDE_CODE_SESSION_ID`. If it finds nothing to stow here, re-run
with `--session $CLAUDE_CODE_SESSION_ID`.

Report the result: the stowed `wt:<trap>` address, and any catch it
requeued or messages it bounced back to the helm. From here on, this
session takes no more assigned work.
