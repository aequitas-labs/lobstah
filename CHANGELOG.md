# Changelog

## 0.8.4 — 2026-10-29

### The permission profile adds context, never restrictions

`lobstah permissions apply` no longer writes a list of "human-only actions" into
Claude Code's `autoMode.environment` or Codex's auto-review policy, and the Codex
rules file no longer forbids lobstah's permission commands or prompts on
`gh pr merge`. Claude Code's classifier and Codex's reviewer keep their own safety
policies. lobstah only adds context that removes friction: its worktrees are the
person's trusted checkouts, the helm acts on the person's request, and a glass
decision answer is the person's own answer. Both profiles now read that context
from one place. Re-applying retires the old entries, including hand-edited copies
under lobstah's headings. (#298)

### Repo setup runs non-interactively

Repo setup commands run with `CI=true`, so `pnpm install` no longer fails without
a TTY when a trap is thrown. (#297)

## 0.8.3 — 2026-10-28

### Codex traps start without the OS sandbox

Codex traps in auto mode now run `--sandbox danger-full-access --ask-for-approval
on-request` with the automatic approval reviewer and the execpolicy rules. The
workspace-write sandbox couldn't write a linked worktree's index in the shared
`.git`, so every commit, amend and rebase asked for approval.
`--dangerously-bypass-approvals-and-sandbox` stays the person's bypass. (#293)

### The helm keeps work moving and never blocks traps

The charter and both man skills gain a short set of rules for every user: dispatch
when a blocker clears and the next step needs no human call; work that parks gets
a todo at once (and a card when a human must act); a stale todo gets acted on;
a decision card is withdrawn as soon as it no longer applies. An upgrade now
restarts a stale glass. (#294)

### lobstah watches only the person's own PRs on its own

Automatic PR watches and repairs now cover only PRs the person authored. Someone
else's stack is no longer watched unless you run `watch add`. (#290)

### `watch rm` records a PR's final state first

`lobstah watch rm pr:…` reads the PR once and records it before removing the
watch, so a PR closed on GitHub no longer stays `OPEN` on the glass. A failed
read still removes the watch and warns that the record may be stale. (#296)

### Glass cards

The permissions proposal card looks like the other decision cards and lists only
the changing rules, with the raw diff folded away (#291). Long decision option
labels wrap inside the card, and the answer box shows its placeholder in WebKit
(#292).

### Checks

The session-grants e2e check gates on a baseline that is always denied, so a
grant's `allow` is the only way through (#289).

## 0.8.2 — 2026-10-23

### Propose permission changes; approve them in the glass

`lobstah permissions propose --codex-allow '<command prefix>' --reason "…"` (or
`--claude-allow 'Bash(<prefix> *)'`) files one glass card with the exact profile
diff. Approve, Reject or Edit (untick rules) there; Approve writes the rules into
`~/.lobstah/config.toml` and applies the profile, with backups. Only the helm may
propose. Over-broad prefixes (bare shells and interpreters, wrappers such as
`env`/`sudo`, `rm`/`curl`/`kill`, bare package runners) and anything reaching a
forbidden command are refused. CLI answers, `lobstah send` and ordinary decision
answers cannot approve a proposal; agents still cannot run `permissions apply` or
`grant`. (#288)

### Per-harness trap permission defaults

`[harness.codex] permissionMode` and `[harness.claude] permissionMode` set the
mode new traps of that harness start in; a roster entry still overrides it. (#283)

### Stowed Codex traps come back when thrown

A stow from outside a Codex trap now ends its Codex process (interrupt, then kill
after 5s), checked by pid and start time. Codex allows one writer per thread, so
a live old process used to block every resume. A throw starts the trap cold while
an old process still runs. Repo `setup` commands run unattended (no pnpm purge
prompt, stdin closed), and a failed setup names its exit code and output tail.
(#287)

### Glass

- Closing a decision keeps your place in the queue; closing the last one shows
  the new last, not the first. (#284)
- The deck shows up to 8 dispatches in flight and 5 landed. (#285)
- Closed (unmerged) PRs leave stacks, PR lists and badges, and are never shown as
  drafts. (#286)

### Goals

The helm checks proposed goals and suggests specific, measurable wording that
starts with a verb before setting them. (#282)

## 0.8.1 — 2026-10-22

### Review asks name the person

A review request that an automation re-requests (for example an approval-gate
workflow running as `github-actions[bot]`) is now attributed to the most recent
human who asked, or else the PR author. CLI rows, the glass, hosted review
content, polling logs and draft-review briefs all use the same attribution; the
raw bot actor stays as provenance. (#280)

### Goals and todos stay in helm context

The helm's session brief carries today's goals and a capped todo list after
start and compaction, so goals can be checked off as they land. The brief also
states the rule of thumb: todos are for the helm or the user over the next few
days; anything longer, or work someone else could pick up, goes to the issue
tracker. The glass daily-goals checklist aligns its numbers, checkboxes and
text. (#279, #278)

### Build caches cleared on sign-off and under disk pressure

Repos can list `cacheDirs` (globs inside the worktree, such as
`apps/*/.next/cache`). lobstah clears them when a trap stows or its dispatch
finishes, and, when free space drops below `limits.cacheMinFreeGB` (default
50), clears idle traps' caches largest first before refusing new traps. Tracked
files and working traps are never touched. (#281)

## 0.8.0 — 2026-10-22

### Session grants

`lobstah grant request --session <id>|--trap <name>|--grounds <name> --tools
'<name|glob>' [--hosts a,b] [--for 15m] --reason '...'` asks the glass for a
trust window for exactly one helm or trap session, browser and MCP tools
included. The card offers Allow for the requested time, Allow for 1h, or Deny.
Windows default to 15 minutes, cap at 4 hours, and never carry over to a
replacement session. Hostname pins must match every URL a call names; Bash needs
a command prefix and keeps the shell-joiner, redirect and dry-run guards.
Agents can't grant themselves, and grants never cover lobstah's own config,
the grant store or Claude/Codex settings, symlinks included. Permission cards
add **Allow this tool family for 15 min**. Active grants live on a new
**Grants** page with Revoke and a use log; a "grant · 12m left" chip marks the
helm or trap they cover. (#272)

### Reviews without pickup

`[reviews]` resolves its own GitHub identity, so review requests can run
without issue or PR-feedback pickup. The Reviews tab is the inbox: requests
land silently with a count, open the repo's review tool, and new drafts carry a
verdict (`approve`, `comment` or `request_changes`) that publishing checks
against the live PR head. `lobstah setup reviews` writes notify mode. (#269)

### Codex traps start and resume cleanly

Codex traps keep lobstah's terminal title, wait out the **Hooks need review**
prompt (`[soak].codexStartSecs`, default 600), start app-owned threads fresh,
and resume in their own worktree with an explicit `--cd`. (#265, #266)

### Grants and prompts

y/N prompts wait for a full answer and accept piped input; `grant` and `trap
bypass` take `--yes`. Codex permission hooks honor saved grants, and "Allow
always" records a reusable scope such as `ume push …`. Permission cards only
offer Allow once, Allow always or No. (#264, #267)

### `dispatch --trap-any` returns at once

It queues the work and prints the id right away; the daemon starts a stowed or
new trap in the background, and a failed start moves on to another eligible
trap. (#275)

### Quieter `man wait`

The wait's backoff now resets only for news it hasn't seen: routine writes,
progress, quiet lifecycle notices and repeated reminders no longer pull it back
to 15 minutes. The timeout line shows the count of empty waits. (#277)

### Glass

The glass is dark in every OS theme. On deck shows at most five TODOs, with
`More (N)` opening a full TODOs page, and phones get a compact menu instead of
tabs. `lobstah man chat brief|full` switches the helm between brief and full
chat at runtime, and card pointers are clickable links. (#270, #273, #274)

### Wharf groundwork

The wharf is configured for `glass.lobstah.dev` and `api.lobstah.dev`, with a
new GitHub sign-in screen. It is not deployed yet. (#268, #271)

## 0.7.11 — 2026-10-21

### Lock races no longer crash `man wait`

Two pollers racing for a PR record could make `man wait` exit with
"ENOENT rmdir pr-polls/...lock" or "PR record locked". The locks now go
through one shared directory-lock helper, so a lost race waits and retries
instead of crashing the watcher. (#261)

### A permission profile for Claude Code and Codex

`lobstah permissions show|apply|remove [--yes]` gives the agents' permission
checks context about lobstah:

- Trap worktrees are your own checkouts.
- The helm acting on your instruction in its chat isn't a bypass.
- Merges, production deploys, secrets, accounts and lobstah's own permission
  controls stay yours.

It merges a base profile, plus a new `[permissions]` table in config.toml
(environment, allow, deny), into Claude Code's user settings
(`autoMode.environment` and narrow allows). It also writes a lobstah-marked
block in `~/.codex/config.toml` `[auto_review].extra_policy` and a
lobstah-only `~/.codex/rules/lobstah.rules`, checked with
`codex execpolicy check`.

It shows one diff and asks before writing. It keeps backups, never replaces
your own entries, and refuses to run from an agent shell. `remove` restores
the files. `doctor` reports both halves. (#262, #263)

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
