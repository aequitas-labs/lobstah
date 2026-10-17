# Changelog

## 0.7.10 — 2026-10-17

### Quiet waiters back off for real

A finished background task (the helm's quiet `man wait`, a trap's
`soak --wait`) comes back as an injected turn, and that turn fired the prompt
hook, which reset the backoff. So every quiet wait started again at 900 s.
A prompt that is only `<task-notification>` envelopes no longer resets it.
Typed prompts and real wakes still reset at once. Quiet waits now go 900, 900,
900, 1800, 3600, 7200, then 14400 s. (#259)

### The day's goals prompt waits for a person

The once-a-day goals prompt fired on the first turn after 04:00, even when
that turn was a task notification with nobody there. It now waits for the
first prompt a person types, and a notification doesn't use up the day's
prompt. (#260)

## 0.7.9 — 2026-10-16

### Traps start in auto permission mode

Traps now start in auto mode: Claude with `--permission-mode auto`, Codex with
`--approve-for-me` (auto review, the same reviewer the Codex desktop app uses),
workspace-write plus network, and the lobstah home and repo git dir allowed.
A person can choose bypass with `man throw --bypass`, with
`man roster set <trap> permissionMode bypass` from a TTY, or with
`permissionMode = "bypass"` under `[harness]` or `[repos.<key>.harness]`.
Agents can't set bypass. The mode shows in roster, plan, traps and tend. (#256)

### Allow always follows the repo

An "Allow always" grant now applies in every checkout of the repo: main,
traps, the pool and Codex worktrees. Path grants are stored relative to the
repo root, and commands normalise checkout roots to `{repo:<key>}`. Once
grants and paths outside every repo stay exact. Earlier absolute grants are
read the new way, and the ledger is untouched. The card shows the scope. (#258)

### Glass

- Viewing a decision or a report in the glass acknowledges it. For reports
  this reverses #124.
- The PR section has an **Ack stack** button on each stack, and **Ack** on a
  lone PR. A stale page can't acknowledge a newer PR state.
- Reports stay newest-first, and acknowledged rows keep their place.
- no-mistakes is removed: its command, daemon, skills and repo gate. (#257)

### Smaller changes

- The helm finds `man file`, and `--attach` takes relative paths and folders
  of images. (#255)
- A dispatch can name its PR, and draft PRs never take their title from the
  brief. (#254)
- A decision keeps its answer, text included, in `answer.json`. (#253)

## 0.7.8 — 2026-10-16

### Config hooks moved

Lobstah's hooks now live under `[hooks]` (global) and `[repos.<key>.hooks]`
(per repo), and the review-tool setting is named for what it is. There are no
aliases and no fallback: a config that still uses an old key fails to load,
and the error names the key's new place.

| Old key | New place |
|---|---|
| `notifyCommand` (top level) | `[hooks.notify]` `command` |
| `notifyVerbs` (top level) | `[hooks.notify]` `verbs` |
| `[pickup]` `notifyCommand` | `[hooks.pickupNotify]` `command` (same `LOBSTAH_*` environment) |
| `[repos.<key>.briefHooks]` | `[repos.<key>.hooks.brief]` |
| `[repos.<key>]` `review` | `[repos.<key>]` `reviewTool` |
| `[reviews]` `rules` | `[hooks.brief]` `prReview` |
| `[repos.<key>.reviews]` `rules` | `[repos.<key>.hooks.brief]` `prReview` |

New: `[hooks.brief]` takes the same keys as the per-repo brief hooks
(`conflict`, `checks`, `review`, `ciFix`, `rebase`, `prReview`, `all`) for
every repo. In each brief the global text comes first, then the repo's.
