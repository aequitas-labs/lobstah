# Changelog

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
