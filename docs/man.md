# The lobstah man: a single-liaison session on lobstah

The pattern: you talk to **one** interactive agent — the lobstah man — and it
runs the fleet: dispatching work, supervising, escalating only real decisions.
Lobstah supplies the machinery for doing that locally without the liaison
burning tokens on supervision.

## The shape

```
you ⇄ liaison (interactive Claude Code / Codex session)
            │  lobstah dispatch / status / send / cancel   (CLI, TOON output)
            ▼
     lobstah daemon ── worktree-isolated dispatches, supervised for free
```

The liaison never watches the workers — the daemon does that with no model in
the loop. The liaison reads `lobstah status` when you ask, which is the
token-efficiency point: supervision is a filesystem read, not a conversation.
Headless runners preserve new-chain committed work on `origin` as HEAD moves
and open one draft PR when `gh` is available. On a nonterminal stop they
checkpoint eligible worktree files and push once more. A follow-up whose
chain already has a PR keeps that PR and its watch. It does not push or open
a second PR automatically; its worker pushes to the existing PR's head
branch. The final status note names the saved branch, commit, and PR, so the
lobstah man can send a continuation without losing work.

**The helm is harness-agnostic: drive the fleet from whichever session you
prefer.** The contract is the CLI, not the harness — a Claude Code session,
a Codex session (hooks since v0.114), or anything with a terminal via the
foreground loop (`man wait` for the lobstah man, `soak --wait` for workers)
holds the same seat with the same verbs. Workers are equally mixed:
dispatches pick their harness per item (`--harness claude|codex`), so a
Codex helm can run Claude workers and the reverse. Sign-on records which
harness took the helm, and `swap` moves an in-flight dispatch across
harnesses mid-stream — the worktree, not the conversation, is the durable
layer.

## Set it up

1. Install lobstah, configure your repos, start the daemon
   ([README](../README.md#install)). To upgrade: `npm i -g lobstah`,
   `lobstah daemon restart`, `lobstah glass restart`, then the plugin update
   ([README](../README.md#upgrade)).
2. Start an interactive session anywhere and paste this into the project's
   agent instructions (`AGENTS.md` / `CLAUDE.md`), or just say it:

```markdown
You are my liaison for delegated coding work. For any task that should run in
the background, dispatch it with the `lobstah` CLI instead of doing it inline:

- `lobstah dispatch --repo <key> --brief-text "<full brief>"` — returns an id.
  Write briefs that stand alone; the worker has no other context.
- `lobstah status [<id>]`, `lobstah ls` — check progress when I ask, not on a loop.
- `lobstah send <id> "<instruction>"` — steer a live dispatch, add to a queued
  dispatch's inbox, or wake a finished chain as a follow-up. Sending to any
  member of a finished chain follows up its newest member. To choose a new
  worker, harness, or model, use `lobstah dispatch --follow-up <id> --repo
  <key> --brief-text "<instruction>" --for <name> --harness <kind> --model <m>`.
- `lobstah cancel <id>` — stop one.
- A dispatch reporting `needs-decision` or `blocked`: when the brief or your
  context gives the answer, `lobstah send` it and tell me what you decided;
  when the choice is mine, frame it with `lobstah man ask <id>` for me to answer.
- `done` means brief fulfilled with a branch + commits; report the evidence
  (`~/.lobstah/state/<id>.evidence`) and never merge anything yourself.
```

That's the whole integration — the CLI is self-documenting (`lobstah help`)
and its TOON output is built to be read by agents.

## Taking over a worker

Every dispatch **is** a real harness session, running under the same CLI you
use by hand. So the crew is inspectable with tools you already have:

- `lobstah attach <id>` — opens the worker's own session, in its worktree:
  `claude --resume <sessionId>` or `codex resume <threadId>` under the hood.
  Full conversation context survives — ask it "what did you do?", redirect it,
  or keep working in the worktree yourself.
- `lobstah logs <id> --follow` — the normalized event stream, live.
- Session pickers in the harness's own tooling (`claude --resume` with no id,
  the Claude/Codex desktop apps' session lists) show dispatch sessions too —
  they're stored where the harness always stores them.

A follow-up (`lobstah dispatch --follow-up <id>`) resumes the origin's
conversation and, by default, its worktree too: it runs in the checkout of
the newest dispatch in its chain, on the branch and HEAD where that dispatch
stopped, without a second dependency install. It allocates a fresh worktree
instead when that checkout has uncommitted changes, is gone, or another
dispatch runs in it; its first status note says which (`reusing worktree of
<origin>` or `fresh worktree (<reason>)`). `lobstah catch` prints the
`worktree` a dispatch ran in, and `worktreeOf` when it reused one.
`[limits].reuseWorktree = false` turns reuse off. Normally, use
`lobstah send <id> "<instruction>"` for a continuation: it delivers to the
live or queued member of the chain, or creates a follow-up of the newest
finished member. If that member was last claimed by a trap still signed on,
the follow-up returns to that trap unless `--for` overrides it. Otherwise it
is unaddressed for a headless worker.

A send to a dispatch expects a reply. The worker's next note after the send
wakes `man wait`: a `working` or `paused` note arrives once as a `reply` event
with the note and the sent instruction's first line, and any other verb wakes
as itself. `--no-reply` sends without expecting a reply.

Attach refuses while a dispatch is `working` (two writers, one session);
follow the logs or `send` instead, or cancel and then attach.

`lobstah swap <id> [--harness codex] [--model ...]` hands an in-flight
dispatch to a fresh session: same worktree, same brief, plus an auto-generated
progress note with the commits so far and any uncommitted changes.
Conversations do not cross harnesses. The worktree is the durable layer, so
the handoff carries everything that matters. Use swap to move work between
subscriptions, escape a rate limit, or re-roll a session that went sideways.

## Tending the string

`lobstah man tend` is the whole-fleet pass — the lobstah man working every trap
in one sweep. It prints a verdict and the story of each piece of work, from a
pure disk read: no forge calls, no tokens.

The verdict distinguishes states that look identical from the outside:

| Verdict | Meaning |
| --- | --- |
| `daemon-down` | No fresh heartbeat — nothing is being supervised. |
| `stalled` | Work queued, capacity free, daemon alive, nothing claiming — actually broken. |
| `needs-attention` | An unanswered `needs-decision`/`blocked` is standing, with its age. |
| `working` | Dispatches active or queued, nothing waiting on a human. A free-space hold counts here, not as `stalled`. |
| `idle` | Everything drained; the quiet is real. |

Below the verdict: counts (queued, active, chores, done/failed last 24h), the
unanswered questions with how long they have waited, and one row per work
item — tracker key, its dispatch chain (original → swaps → review follow-ups),
its PR, the PR's merge-gate status, and any external source the chain is
watching (a ume review session, a CI run). Watches join the same way the
merge view does — from disk. A man-owned watch with unconsumed events counts
as `needs-attention` with its age; a dispatch-owned one annotates its story
(the wake is machinery's job, not the human's). Gate status comes from the [merge
view](pickup.md#merge-view) pickup persists each tick, so PR state is at most
one poll interval stale without tend making a single network call. `--json`
emits the full report for dashboards and scripts to render.

The work table's `activity` column shows what each live dispatch is doing
now, with its age: `Edit src/a.ts (12s ago)`. It comes from the runner's
event stream (headless) or the post-tool hook (a trap), never from the
worker's reports, so it stays current when the worker forgets to report.
Past `[limits].wedgeThresholdSecs` it reads `stale: … (14m ago)`. A long
silence is shown, not escalated: it raises no attention and no notice. The
worker's verb and note stay the primary line. `lobstah status <id>` prints
the same line as `activity:`, and `lobstah ls` has an `activity` column. See
[Activity](vocabulary.md#activity).

A worker that waits on something outside lobstah (a ume review, a PR
review, a deploy) reports `paused "<note>" --waiting-on review --link <url>`
before it waits. Tend, `status`, `ls`, and the glass then show
`paused: waiting on review` with the link and the time waited. It is a
state, not a question: nothing to answer, no attention, no pet. A paused
headless worker is never counted as wedged and its wall clock stops.

A paused headless dispatch is **parked**. When the worker's turn ends on
`paused`, the runner ends the session, stops what the harness started,
and exits. The dispatch stays active and keeps its worktree lock, but it
holds no `maxConcurrent` slot and runs no process. It wakes into the same
session when an operator message reaches its inbox (`lobstah send <id>`)
or when its `--until` time passes, as soon as a slot is free; a waking
dispatch takes the slot before queued work. The first prompt of the woken
session says why it woke and carries the messages. A parked dispatch
counts in the status output, without a slot:

```
$ lobstah man tend
active: headless: 1 of 2; traps: 0; parked: 1 (no slot)
parked (no slot)[1]{id,waitingOn,for,link,note}:
  6a1f0c2e,review,80m,https://github.com/o/r/pull/7,waiting for approval
$ lobstah daemon status
slots: 1 of 2 work in use, 1 free
parked: 1
parkedOn: 6a1f0c2e waiting on review for 80m https://github.com/o/r/pull/7
```

`lobstah doctor`'s `daemon` row ends in `parked: 1, no slot (…)`, and the
glass header shows `parked: 1 (no slot)`. A worker that reported `done` or
`failed` holds no slot: its runner exits within `[limits].exitGraceSecs`,
and a restart of the daemon does not wait for it (see [status
verbs](vocabulary.md#status-verbs)). A parked dispatch has no runner, so a
restart does not wait for it either. A paused trap is kept out of the ghost
sweep until `--until` or `[soak].pausedTtlSecs` (24 hours). See [Waiting
on](vocabulary.md#waiting-on).

**A PR's end finishes the waits on it.** When the PR a dispatch waits on
with `paused --waiting-on pr` or `--waiting-on review` merges, the daemon
finishes that dispatch `done` with the note `the PR merged: <url>`. When
the PR closes without merge, it finishes it `failed` with `the PR closed
without merge: <url>`. The PR waited on is the `--link` when it names a
GitHub PR, else the dispatch's own PR (its evidence, which `lobstah catch`
shows), else its chain's PR, else the PR of a `pr:` watch the dispatch
owns. Every paused dispatch waiting on that PR is finished, in the whole
chain. The daemon does this after it observes PR watches and before its
cull pass, so `[limits].releaseOnMerge` releases the chain's worktrees in
the same pass. `report paused --waiting-on pr|review` registers the watch
of the dispatch's own PR when it has none. The daemon also reads, at
`[pickup].pollSecs`, each waited-on PR that no live dispatch-owned watch
observes (a linked PR with no watch, or a helm-owned watch), so its merge
or close is seen without `lobstah pick`. When lobstah knows no PR for the
wait, the report prints a `warning` and a merge will not finish the
dispatch: report again with `--link <PR url>`.

### PR state after done

A dispatch reports its PR with `report <id> <verb> --pr <url>`, which
registers a `pr:` watch for the chain so the PR stays observed (see the
PR preset in [vocabulary.md](vocabulary.md#the-pr-preset); `--no-watch`
opts out). A trap's PR is tracked from its first push. What you get
depends on what runs:

- **Only the helm park or `man wait`** (no service): PR state badges in
  `man tend`, `lobstah catch`, and the glass (`merged`, `draft`, `review`,
  `checks 1/2 failed`, `conflicts`, `behind`, `green`), and a `pr-merged` / `pr-closed` notice
  when the PR lands. The inline poller observes at `[pickup].pollSecs`
  (default 45 s), one `gh pr view` per PR per cycle, and forks nothing.
- **With `lobstah pick`** (watch-only mode needs no tracker; `lobstah pick
  install` runs it as a service for a steady cadence): all of the above,
  plus CI-fix continuations — a failing check forks the chain with a brief
  naming the PR, the check, its details URL, and the head sha — and
  review-decision continuations for repos `[pickup.github]` doesn't cover.

`gh` must be on PATH and authenticated; if it isn't, the done report still
succeeds and the watch's check records `lastError`.

Which commands register a watch. Only these write points register one:

- `lobstah report <id> <verb> --pr <url>` registers the watch for the PR the
  worker opened. Any verb but `failed` does this. A PR already watched is
  not registered again.
- `lobstah report <id> paused --waiting-on pr|review` registers the watch
  for the dispatch's own PR. A `--link` to another PR registers nothing; the
  daemon reads that PR while the dispatch waits on it.
- `lobstah soak beat` registers the watch for a trap's PR from its first
  push. At most once a minute, it reads the trap's branch. When the branch
  is not trunk and has an upstream, it asks `gh pr view <branch>` for the PR.
  It records a new PR in the dispatch's evidence, where `lobstah catch` and
  `lobstah status <id>` show it.
- `lobstah watch add <key>` registers the watch you name.
- `lobstah watch backfill --apply` registers watches for PRs in old dispatch
  history, and fetches the title of each PR record that has none (one
  `gh pr view --json title` per record). Without `--apply` it only lists
  them. Nothing runs it for you.

Read commands never register a watch: `catch`, `man tend`, `status`, `ls`,
`prs`, `attention`, and the glass. They read PR records and watches that
already exist. Use `watch check-pr <key>` to force one PR-watch refresh.

The first check of a new watch is a baseline:

- An open PR: the first observation records its checks and merge state, but
  starts no repair. Later observations may start a bounded repair on a PR
  lobstah owns.
- A merged or closed PR: the check records `MERGED` or `CLOSED` in the PR
  record and retires the watch. It forks nothing and raises no attention. A
  `pr-merged` / `pr-closed` notice is posted once only when the PR ended in
  the last 24 hours.

One watch cycle forks at most `[watch].maxForksPerCycle` continuations
(default 3). Generic watches over the cap are held and listed as `held` in
`man tend` and `lobstah watch`. PR repairs wait for the next cycle.
`lobstah watch release <key>` (or `--all`) releases held watches.

For a dispatch-owned PR, the watch repairs conflicts, failed current checks,
and requested review changes. It follows up the newest dispatch in the PR's
chain. A conflict brief names the PR's base branch, including a stacked
base. A check brief names each failed check and its details URL. The watch
records each attempt and stops at `[watch].maxRepairsPerPr` per head SHA.
Each failing check gets at most one repair round per PR and head SHA; the
PR record's `repair.checks` lists the checks that had their round. The
same rule holds for CI-fix continuations from `lobstah pick`.

**Human gates.** A check that fails until a person approves the change is
a human gate. It gets no repair round and no CI-fix continuation on that
PR. Two sources name gates: `[repos.<key>].humanGateChecks` in the config,
and a worker's `lobstah report <id> <verb> --human-gate "<check>"` (once
per check). The report records the gate in the worker's evidence
(`humanGates`) and on the PR record (`humanGates`). A check brief lists
the failing gates and tells the worker to name a gate it finds. A PR whose
only failing checks are human gates shows `repair.status: waiting` with
`heldBy: human-gate`.
It does not repair a PR with a person's newer commits or uncertain commit
ownership, a terminal PR, or a PR whose chain already has queued or active
work. `[watch].autoRepair`, `conflicts`, and `checks` control this behavior.

Daemon repairs run in the `chore` lane and use `[limits].choreConcurrent`.
A repair for a trap-built PR is addressed to its owning live trap. If the
trap is busy, the chore waits for up to `[watch].repairTrapWaitSecs`
(default 600). It then runs headless in its own checkout of the PR branch.
A repair for a headless-built PR runs headless and reuses its origin
worktree when that checkout is clean and free. A headless chore never uses
a trap's worktree. Only daemon-created repair chores have this bounded
addressed fallback. Work addressed by a person stays addressed until the
person releases or redirects it. `man tend`, `daemon status`, `doctor`,
and the glass show the repair's PR, chore lane, worker, and trap wait.

**A repair waits** while any of these is true:

- A live worker holds the PR's head branch. A live worker is an active
  headless dispatch, or a trap with an open catch. It holds a branch when
  its worktree has the branch checked out, when its current branch tracks
  the branch on the remote, or when it pushed the branch during its current
  dispatch. It holds a PR when its evidence names the PR or its chain owns
  the PR.
- A live worker holds the head branch of an open PR below this PR in the
  same stack. The stack is the one the glass shows: a PR's parent is the
  PR whose head branch is its base branch.
- The PR's head, its base branch's head, or its failing checks changed less
  than `[watch].repairSettleSecs` ago (default 600).
- For a conflict repair: the PR was approved less than
  `[watch].repairSettleSecs` ago.
- For a checks repair: a fresh read of the latest run of each failing check
  shows that run in progress or passed.
- The PR's watch is held. `lobstah cancel` on a repair dispatch holds its
  PR's watch. `lobstah watch hold <key> [--for <id>]`
  holds one PR's watch; with `--for`, the hold ends when that dispatch
  ends. `lobstah watch release <key>` ends any hold.

A waiting repair is recorded on the PR record as `repair.status: waiting`,
with `heldBy` (`wt:<trap>`, `dispatch:<id8>`, `helm`, `hold`, `settle`,
`checks`, `human-gate`, or `repaired`) and `reason`. `repaired` means each
failing check already had its round at this head; a new commit ends it.
Unlike the other waits, `repaired` also raises `pr:checks` attention with
its reason: the round did not fix the check. A wait is not an attempt: it does not count against
`[watch].maxRepairsPerPr`. It raises no attention item. `man tend` lists it
in the `repairs waiting` table, the PR badge ends in `repair waits: <heldBy>`,
the glass PR modal shows the reason, and `lobstah doctor` lists it. When the
wait ends, the normal rules apply again.

**Repairs stop** on a PR after `[watch].maxRepairsWithoutProgress`
(default 2) repairs in a row that each ended `done` while the PR stayed at
the head the repair pushed and did not merge. lobstah then queues no repair
for that PR, marks its repair `gave-up`, raises `pr:conflict` (or
`pr:checks`, `pr:review`) attention that names the cap, and posts one
`repair-stopped` notice. The count resets when the PR merges or closes,
when a push that is not the repair's moves the head, and on
`lobstah watch release <key>`, which prints `repairsResumed` with the PRs it
resumed.

**A repair pushes** to its PR's head branch, and so does a rebase chore
from pickup's merge loop. The descriptor of each names its PR (`pr`), so
the runner pushes no branch and opens no PR for it. The brief gives the
worker the push rule: push only to the PR's head branch. A conflict
repair of a **standalone** PR (its base is the repo's `trunk`) merges the
base into the PR branch with a merge commit and pushes normally; on a
non-fast-forward rejection it fetches the moved head, merges it, and
pushes again, never with force. A conflict repair of a **stacked** PR (its
base is another PR's branch) rebases onto that base and pushes with
`--force-with-lease`; on a rejection it rebases onto the moved head again
and pushes with a lease on the head just fetched. A checks or review
repair follows the rebase rule on a rejection. Each retries at most three
times. A push hook that fails with a real test or
type error is not retried: the worker fixes the error and pushes again.
For code already on main, the repair keeps main's version and only this
PR's own changes. It does not change behavior. If a conflict resolution
would change behavior, the worker reports `needs-decision`.
When the worker cannot push, it reports
`failed "push rejected: <rejection text>; moved head <sha>"` and leaves the
PR as it was. That report marks the PR's repair `blocked` at the moved head
(no new repair starts on that head, nor on the head the repair started
from) and posts a `push-failed` notice. A repair never opens a branch or a
PR.

Lobstah records pushes it sees in the dispatch's evidence (`pushes`): the
runner's own pushes, a headless worker's `git push` commands, and a trap's
`git push` commands (from its post-tool beat). It does not read GitHub to
guess who pushed. A worker that is about to push to other PRs can hold them
first with `lobstah watch hold <key> --for <its dispatch id>`.

Watching a PR nobody dispatched — `lobstah watch add pr:<owner>/<repo>#<n>`
with no `--for` — is how a helm follows a human's PR, or one whose
dispatch chain was culled. Every observation lands in a PR record keyed by
the PR, so it shows in the glass PRs tab and stacks and in tend's `pr:*`
attention kinds exactly like a dispatched PR (its dispatch chain column is
empty). Each PR card, PRs tab row, and PR modal header shows the PR's title
after its number; a stack line shows numbers only, with each title on hover.
`lobstah prs` prints the title, cut to 60 characters. Every check reads the
title again, so a rename on GitHub shows on the next check and is never
attention. It stays quiet while it's fine: only a failing check or a changes
request surfaces as a watch event; a merge or close arrives as a notice.

**PR order.** Every PR list uses one order: the glass PRs tab, the On deck
PR stacks, `lobstah prs`, and the `stack #…` lines and the `work` table of
`man tend`. Open stacks come first, then finished ones. Within each group, the
stack whose newest PR was first seen last is on top. Within a stack, PRs are
in stack position. A PR sorts by its record's `firstSeenAt`, then by number.
A new observation does not change the order. The order changes when a PR
opens, merges, closes, or changes its base so that it joins or leaves a
stack. When two PRs share a head branch, the parent is the one first seen
last. The attention list is in standing order: the time each condition
started. `observedAt` is shown as the time of the last check.

An observed PR joins tend's attention list by kind. `pr:ready` needs a
mergeable, non-draft PR with no failed, pending, or unknown current checks.
`pr:conflict` and `pr:checks` appear for an owned PR only when repair is off,
blocked, or exhausted; their notes say why. Requested review changes on an
owned PR follow the same repair rule. Unresolved review questions remain
`pr:review` attention. Drafts are not attention by default; users can add
`pr:draft` to `attentionKinds`. The glass and desktop pet use the same list.
See the [attention contract](vocabulary.md#attention-contract). A PR is
something to look at, not a stall: it never flips the verdict to
`needs-attention` and stays out of the digest.

A question is held while a helm is signed on for its grounds and has not
ended a turn since the question was filed. A held question is in `man tend`,
`man wait`, the park, and reminders, and `lobstah attention` and `man tend`
mark it `held`. It is not in `attention --json` (the pet), the glass, or
notifyCommand. The question walks when the helm ends a turn (`man haul`)
without answering it; the release is recorded in `releases/<key>.json`. With
no helm signed on, or a helm relieved or stale past `[helm].ttlSecs`, a
question walks at once.

### The spyglass

The lobstah man skill brings up the glass when it takes the helm.
`lobstah man helm` alone does not. `lobstah man relieve` leaves it running.
`lobstah glass stop` stops a detached glass. `lobstah glass install` runs it
as a user service. `lobstah glass restart` restarts the service, or a
detached glass (stop, then `--detach`).

`lobstah glass [--port <n>]` serves tend as a live web page on 127.0.0.1
(default port 4949): the fleet verdict, decision cards, every
dispatch with its full brief, status log, inbox, and evidence, each trap
with its lifecycle notices, message history, and catches, the notices
tail, the merge view, and watches — with filters, a table/cards toggle,
and the helm identified by name. Its tabs are On deck, Dispatches, Traps,
PRs, Reports, and Notices. The Reports tab lists every report, unacked first,
then newest first, and the repo filter and the search box (title, author,
dispatch id, repo) apply to it. Reading the glass consumes no cursor. Each
live trap has a **↗ open** button at the end of its foot line. It asks the local server to focus
that trap's reported session link, iTerm2 session, Terminal tab, editor
worktree, or recorded app, in that order. The result names the step that
worked; app-only activation says the exact window is not known. On other
platforms, only a session link can open. A signed-off trap has no button; the
page shows its resume command as text to copy. The focus endpoint accepts
only a trap id in a same-origin, token-protected POST. The ⚙ popover's two
preferences — table or cards, and whether lobsters crawl the page — are
per-browser, kept in that browser's localStorage and never on disk.

On a card, the title and the badge share one line. The title shrinks first,
with an ellipsis, but always keeps its PR number or 8-character id. A badge of
12 characters or fewer always shows whole. A longer badge truncates only
after the title is at its minimum, never below 12 characters. The meta line
and the note show at most two lines. The full text of each is in its hover
title.

The On deck tab shows up to 8 traps. Signed-on traps come first, oldest
sign-on first, with name breaking ties. Traps stowed or ghosted in the last
hour follow, most recent sign-off first, with name breaking ties. A "+N more"
link opens the traps tab for the rest, in the same order. Both views show each
trap's current dispatch, last activity, or idle and waiting state. A dot leads
that state line on the deck, the traps tab cards, and the traps tab table. The
dot is green when the trap is working or idle and listening. It is amber when
the trap is parked. It is grey when the trap is not listening (its heartbeat is
stale) or signed off.

This is where "is the agent alive?" belongs: the helm's heartbeat age on a
page, not periodic proof-of-life turns in a transcript.

### Reports

A report is a markdown page of findings, with images, that a dispatch or
the helm files to keep.

- **Filing a worker report.** `lobstah report <id> done "<one-line note>"
  --report <file.md> [--attach <file> ...]` (also `failed`). The page is
  copied to the dispatch's state directory as `state/<id>/report.md`, beside
  `attachments/`. `--attach` copies each file into that `attachments/`. An
  image the page names by bare filename (`![tray](tray.png)`) resolves to
  that directory. The note stays one line.
- **Filing a helm report.** `lobstah man file <file.md> [--attach <file> ...]
  [--title <text>]`. It is stored under the helm's grounds,
  `reports/<grounds>/<rid>/`, with the same layout, and the author is `helm`.
- **Title and author.** The title is `--title`, else the page's first `#`
  heading, else the dispatch's brief title. The author is the trap name, or
  `headless`, or `helm`. A file larger than `[limits].attachmentMaxBytes` is
  refused, and nothing is filed.
- **Finding one.** `lobstah reports` lists every report, newest first: key,
  title, author, the dispatch or helm grounds, when it was filed, and
  whether it is acked. `lobstah status <id>` and `lobstah catch <id>` print
  `report: <path>` when the dispatch has one.
- **In the glass.** The deck has a reports block after Landed: newest first,
  unacked first, up to 8, then "+N more", which opens the Reports tab. A
  report's card or row shows its title, then who filed it (a trap's name, a
  headless dispatch's id, nothing for the helm), its age, and `acked`. A
  report opens on its own page, `/report/<key>`, in a new tab: from its card
  or row, a lob, the desktop pet, or its dispatch's modal. The page renders
  once and does not refresh; opening it does not ack the report.
  `#report/<key>` goes to that page. The page shows headings, lists,
  tables, fenced code, links (in a new tab), bold, italics, and images.
  Raw HTML in the markdown shows as text. The glass serves the markdown and
  the images read-only, and an image only by basename from that report's
  own attachments.
- **Images.** Every image in the glass (a decision card's, a report page's,
  and an attachment's in the dispatch and trap modals) opens in an in-page
  overlay: centered at up to 90% of the viewport over a dark backdrop, with
  a link to open the original file. Escape, a click on the backdrop, or the
  close button closes it. The glass serves a dispatch's and a trap's
  attachment images read-only, by basename, from their own attachments
  directories. Missing files, malformed names, and symlinks are not served.
- **Attention.** A filed report with no ack stands as the `report` attention
  kind. Add `report` to `attentionKinds` to walk it. The desktop pet shows
  the report's title; a pet click opens the item and acks it through
  `lobstah attention ack <key> --by pet`. The pet's Acknowledge menu entry
  acks without opening, and `lobstah attention ack <key>` acks a report
  whether or not `report` is in `attentionKinds`. Opening a report in the
  glass does not ack it. A report filed by a follow-up dispatch acks the report
  of each dispatch before it in the chain.
- **Cull.** `lobstah cull` removes a dispatch's report with the rest of its
  state. A helm report is culled when it is older than the retention window,
  counted from when it was filed.

### Decisions

A decision is a question the helm puts to the human. Workers still ask in
prose (`report needs-decision "<note>"`). The helm decides first. When the
brief, the code, or its context gives the answer, it sends it with
`lobstah send <id> "<answer>"` and says what it decided in its next report.
When it lacks the context, or the choice is the human's (scope, product
behavior, money, releases, merges, anything outward-facing or hard to
undo), it frames a decision with `man ask`. The helm's own questions follow
the same rule.

- **Asking.** `lobstah man ask [<dispatch-id>] --title "<question>"
  [--detail <file.md>] [--option "<label>"]... [--attach <file>]...` stores a
  decision: its key (`decision:<rid>`), title, detail markdown (at most
  64 KiB), 0 to 6 option labels, attachments, the dispatch it is about (none
  for a question such as "cut 0.6.0?"), who asked (`helm`), and when. It is
  stored in `~/.lobstah/decisions/<rid>/`: `decision.json`, `detail.md`, and
  `attachments/`. The claimed helm alone may ask.
- **Standing.** A decision stands until it is answered or the helm withdraws
  it with `lobstah man ask --withdraw <key>`, which removes its directory. A
  newer `man ask` on the same dispatch keeps the older decisions: each shows
  as its own card. `lobstah man ask ... --replace <key>` replaces that one
  standing decision; a key that is not standing is refused.
- **Attention.** A standing decision is attention of kind `decision`, in
  the default `attentionKinds`. It makes the verdict `needs-attention`. A
  worker's raw `needs-decision` or `blocked` stays a `question` until the
  helm frames it. While a decision on the same dispatch, asked at or after
  the question, is on disk, the `question` item is hidden: the decision
  replaces it. Withdrawing the decision shows the question again.
- **In the glass.** The attention section of On deck is a list of
  full-width decision cards, newest first. A card shows the title, the
  detail rendered as markdown, the attachments (images inline), the
  dispatch link and repo, and the age. The options are buttons. Below them
  is an empty text box that grows with its content, and an attach control
  for images and files (`.png .jpg .jpeg .gif .webp .pdf .txt .md .csv
  .json .log .diff .patch .yaml .yml .toml .zip`, each at most
  `[limits].attachmentMaxBytes`, at most 8). Click an option, write an
  answer, attach files, or any mix; one **Send** submits it. With no options,
  the text box is the whole answer. After sending, the card shows
  `answered · <what was chosen>` and leaves on the next refresh. A raw
  `question` the helm has not framed shows as a plain card with the
  worker's note and the same text box. PR kinds stay in the PRs section.
  `#decision/<key>` opens the deck at that card. Pasting with Cmd-V or
  Ctrl-V in the text box adds each image on the clipboard as an attachment
  named `pasted-<time>.png` (the extension follows the image format), with
  the same size, type, and count checks as a picked file; pasted text stays
  text.
- **The answer is a request.** An answer is a glass request of kind
  `decision-answer`, stored as `~/.lobstah/requests/<id>.json` with its
  files in `~/.lobstah/requests/<id>/`. The payload is the decision `key`,
  `title`, `dispatch`, `lane`, `repo`, the `option`, the `text`, and the
  stored `attachments`. `answer.json` in the decision's directory marks it
  answered and names the request.
- **The POST.** Send is a same-origin POST to `/requests` with the page's
  token (header `x-lobstah-token`), the guard the **↗ open** button uses.
  The body is `{ "kind": "decision-answer", "payload": { "key", "option",
  "text", "files": [{ "name", "data" }] } }`, with file data in base64. The
  server checks the kind, the key, that the option is one of the decision's
  labels, the text length (at most 20000 characters), and each file's size
  and type (an image must also start with its format's signature). It
  writes the request and runs nothing. Answering a raw question's key
  (`<lane>:<id>`) first stores it as a decision asked by `worker`.
- **The event.** Writing the request posts a `decision-answer` notice. It
  wakes the helm's `man wait` (and the Stop-hook park) once, as a
  `decision-answer` event: the request `id`, `key`, `dispatch`, `title`,
  `option`, `text`, `attachments` (the stored paths), `from`, and `at`. The
  helm acts on it, usually with `lobstah send <dispatch> "<instruction>"`.
  Answering does not message the worker.
- **From the terminal.** `lobstah man answer <key> [--option <label>]
  [--text <text>] [--attach <file>]...` answers the same way, with the same
  checks.
- **The pet.** The desktop pet shows a decision as its title only. A click
  brings up the live helm's session through the pet's focus ladder: the
  Claude desktop app for a desktop helm, the exact terminal tab for a terminal
  helm. With no live helm, it opens the glass at the card. Either way it acks
  the item for the pet (`lobstah attention ack <key> --by pet`). The card
  stays in the glass until the decision is answered or withdrawn.
- **Cull.** `lobstah cull` removes a decision once its answer is older than
  the retention window, with the `decision-answer` request and its files. A
  standing decision is never culled.

### The periodic report

`lobstah man tend` is the full picture on demand; `lobstah man report` is the
**delta** since the last acknowledged report — catches landed (with their
notes and PRs), attention newly arisen, what still waits, and the fleet
verdict. It advances a "reported through" cursor when it prints, so nothing
is ever reported twice, and it says
`no change` when the delta is empty rather than re-dumping state. Standing
unanswered questions appear under `still-waiting` without counting as
change — reminders (`remindSecs`) own re-firing those.

A catch is reported once the helm's `man wait` watcher delivers its event or
`man report` prints it. The glass's `unreported` badge means no helm received
that catch. A `man wait` timeout and `man wait --peek` only peek at the delta;
a digest lost with a dead background task re-surfaces on the next timeout.
The Stop-hook's standing-attention reminder does not mark a catch reported.

Every carrier shares the cursor (per grounds, for a helm):

- **The wait loop.** A delivered `man wait` event (exit 0) advances the helm's
  cursor through the event time. A timeout (exit 3) prints the delta when
  something changed without advancing the cursor — see the loop idiom below.
- **The blocking park.** A helm session's Stop-hook park delivers the digest as a wake
  at `[helm].reportSecs` cadence — including the landed-then-idle case, where
  the last catches finish and nothing is left in flight to wake for.
- **Direct call.** Anything with a clock — a gateway heartbeat, a cron — runs
  `lobstah man report` and forwards the output when it is not `no change`.
  Escalating a report to a human (a phone push) is the gateway layer's job,
  not lobstah's.

The loop idiom needs no harness scheduler, because the timer is lobstah's own
blocking wait:

```
lobstah man wait --timeout 900
# exit 0 → an event printed; handle it, then loop
# exit 3 → timeout; the delta digest printed above it when something changed
```

A session running this loop reports into its own transcript whether or not a
human is watching — come back later and the transcript is the report.

## Getting woken instead of asked

After `man helm`, run `lobstah man wait --session <id> --timeout 900` as a
background task and re-arm it after each completion. The wait registers a
heartbeating watcher for the session and exits with an event or a timeout
(exit 3). At turn end, `man haul` blocks with standing attention; in arm mode,
work in flight allows a stop with a live watcher and otherwise blocks with
the arm command. The hook first waits up to `[helm].armGraceSecs` (5 s) for a
watcher that is still starting, so arming and ending the turn at once is safe.
`man haul --park` or `[helm].park = "block"` makes the hook
wait for attention itself. Without a Stop hook, use the
[foreground loop below](#without-a-plugin).

The hook is a CLI command — `lobstah man haul` (the lobstah man hauls the
trapline; every orchestrator-facing command lives under `lobstah man`).
Install it from the project you'll run the lobstah man in:

```bash
# Easiest: the plugin ships the hooks + the man and trap skills, no settings
# edits — install steps per harness in docs/harness/claude-code.md and
# docs/harness/codex.md. Or wire the Claude hook by hand:
lobstah man init            # merges the Stop hook into .claude/settings.local.json
lobstah man init --shared   # …or the committed .claude/settings.json
lobstah man init --global   # …or once into ~/.claude/settings.json — any
                            # directory with a .lobstah-man file then uses the hook
lobstah man init --marker   # also touch .lobstah-man (per-directory gate)
```

Idempotent, and it only appends to `hooks.Stop` — existing hooks and settings
are preserved verbatim. What it writes:

```json
{ "hooks": { "Stop": [{ "hooks": [{ "type": "command", "command": "lobstah man haul", "timeout": 14400 }] }] } }
```

`haul` applies to a signed-on helm or trap, or a session opted in with
`LOBSTAH_MAN=1` or `.lobstah-man`. Queued dispatches count as work in flight.

**Delivery guarantee.** Attention wakes are at-least-once with backoff. An
unanswered question is reported immediately. While it still stands, it
re-fires as a reminder every `remindSecs` (top-level config, default 900). So
a wake consumed by a session that died mid-handling resurfaces on its own.
Answering ends the reminders: a message to the dispatch newer than its
question — `lobstah send`, a forwarded tracker comment, anything written
through the inbox with provenance — means the question no longer stands, even
before the worker reads it; `man tend` then shows the dispatch as
`needs-decision (answered <n>m ago)` instead of listing it under attention.
A newer `needs-decision` from the worker stands again. Set `remindSecs = 0`
for pure at-most-once.

A send still waiting on its reply is listed in the `man haul` block as
`sent · <id> · <first line> · <age>`. Alone, it blocks a stop only when no
watcher is live, beside the arm command. It is listed once, then every
`remindSecs` until the worker's next note answers it. `man tend` shows it on
the dispatch as `awaiting reply · <age>`, and the glass dispatch modal shows
it under the inbox.

**Acknowledging, display-only.** Clicking a desktop pet opens its target and
runs `lobstah attention ack <item-key> --by pet`, so that pet stops walking
the item until its state changes (a new status entry, head, failed check, or
thread count). The ack changes only what the pet and the glass lobs display:
`man tend --json` still lists the item (marked `acked`), and `man wait`, the
park, and reminders ignore acks entirely — a human having seen a question
must never hide it from the orchestrator that has to answer it. The glass,
which has no write endpoint, hides a clicked lob per browser in localStorage
instead.

**The pet's read.** Every six seconds the pet runs `lobstah attention --json`.
It prints `{ "attention": [...] }`: the same items, with the same fields, that
`man tend --json` puts under `attention`, and nothing else. If that command
fails (an older CLI exits 2 on the unknown flag), the pet runs
`man tend --json` instead. The pet reads the child's output while the child
runs, so a report of any size works. Each read may take 10 seconds; then the
pet stops the child and keeps its current windows. After three failed reads in
a row it writes one line with the reason to `~/.lobstah/logs/pet.log`, and one
more line when reads work again. After every read it writes
`~/.lobstah/pet/state.json`. `lobstah doctor` reads that file for its `pet`
row: installed or not, running or not, and whether the last read worked:

```
pet  ok    installed; running (pid 812); last read worked 4s ago (`lobstah attention --json`, 3 walking)
pet  warn  installed; running (pid 812); last read failed 2s ago, 3 in a row: `lobstah attention --json` timed out; `lobstah man tend --json` timed out; last worked 5m ago
```

**Wrapper loop.** An outer loop blocking on `wait` can spawn one fresh
headless turn per event:

```sh
while out=$(lobstah man wait); do
  codex exec "A dispatch needs attention: $out — handle it with the lobstah CLI."
done
```

Zero tokens between events and works anywhere a shell does; the cost is that
each event gets a fresh context rather than a continuing liaison
conversation.

### Without a plugin

Run the CLI sequence directly:

```bash
lobstah man helm --session <id>
lobstah man wait --session <id> --timeout 900
lobstah dispatch --repo myapp --brief ./brief.md
lobstah man tend
lobstah glass
lobstah man relieve --session <id>
```

Without a hook, run `man wait` in the foreground and loop on it after each
event or timeout.

## The helm: signing on as the orchestrator

Soak enlists workers; `lobstah man helm` enlists the one who dispatches to
them. Sign-on prints the **charter** — the persona and scope fences, written
in Standard Technical English: triage and dispatch but never do the work,
leave running catches to the daemon, judge the catch not the keystrokes, stay
inside your grounds, report deltas not dumps. `man brief` re-injects the
charter at every session start, so it survives restarts and compaction
without anyone re-running anything. A helm registration enables the
Stop hook by itself — no `.lobstah-man` marker, no env var — and
gates the digest above.

The lobstah man skill prints the glass URL. `[glass].port` sets the port;
`LOBSTAH_GLASS_PORT` takes precedence.

**One helm per grounds, enforced.** A **grounds** is a named territory: the
subset of configured repos one orchestrator oversees (`[grounds.*]`; with
none configured, one implicit `fleet` grounds covers every repo). A repo
belongs to at most one grounds, so two orchestrators can never dispatch into
the same territory. The registration is one file per grounds — the data model
cannot hold two:

- Sign-on against a **live** foreign holder refuses with guidance;
  `--take` is the only force path, and it is deliberate: the displaced
  session finds a stand-down notice at its next park and stops orchestrating.
- A **stale** holder (heartbeat past `[helm].ttlSecs`) is claimable outright —
  a dead orchestrator holds nothing.
- `lobstah man relieve` steps down; a relieved session never re-takes on its
  own.
- The rule is strict: once a helm is claimed, `man wait` and `man report`
  are reserved for the helm session (identified by `--session`, else hook
  stdin, else `$CLAUDE_CODE_SESSION_ID` — inside Claude Code no flag is
  needed; a refusal names the id it resolved and from where), and no
  other session parks as a lobstah man — those verbs consume the helm's
  wakes and cursor. A grounds-scoped call is stricter still: it belongs to
  that grounds' own helm, never a neighboring one. `man tend`/`man brief`
  stay open to everyone; a stale helm reserves nothing. Workers never run
  `man` verbs at all — their hookless park is `soak --wait`.
- An identified `man wait` heartbeats the helm while it waits (waiting is
  liveness) and defaults its digest to the helm's own grounds.
- Consumption is grounds-partitioned: a helm's `man wait` and park consume
  only events and notices for its own grounds' repos (events whose repo is
  unknowable stay visible to all helms). Two helms never eat each other's
  wakes.
- The wake cursor starts at sign-on. When `man helm` signs on and the
  grounds has no live helm, notices and watch events recorded before the
  sign-on are not wakes: they were delivered to nobody, and they are not
  news. `man tend` and the glass Notices tab still list them. Standing
  attention still wakes: an unanswered `needs-decision` or `blocked`, a
  free-space hold on queued dispatches, a failing watch. The `man report`
  digest also starts at the sign-on. A `--take` from a live helm keeps that
  helm's cursor, so nothing in flight is dropped.

## Soaking: a live session volunteers as a worker

Workers are usually traps lobstah sets itself — fresh headless sessions in
fresh worktrees. A **soaking** session is the inverse: an interactive thread
already in the water volunteers to take bait, keeping its warm context, its
visible terminal, and whatever authenticated tooling a headless spawn can't
get.

```bash
lobstah soak                    # in a linked worktree: sign it on; in a
                                # repo's primary checkout: create a linked
                                # worktree and sign that on
                                # (the id: --session, else hook stdin, else
                                # $CLAUDE_CODE_SESSION_ID)
lobstah soak --repo <key>       # outside any configured repo: create a
                                # worktree for <key> and sign it on
lobstah soak --wait             # hookless sessions: listen in the foreground
                                # (re-runs need no flags — identity is the
                                # worktree, else the session id); exit 3 =
                                # quiet, run it again
lobstah soak --link <url>       # store this session's link for the glass's ↗ open button
lobstah focus <trap>           # focus a live trap from the CLI
lobstah stow                    # sign off; an open catch requeues, unread
                                # messages bounce back to the helm; removes
                                # the worktree when soak created it
lobstah stow --keep             # sign off and keep the worktree
lobstah soak --name amber-gull  # choose or change this trap's two-word name
```

`--link` accepts a Claude desktop session URL under `claude://claude.ai/`,
a VS Code extension URL of the form
`vscode://anthropic.claude-code/open?session=<id>`, or a Codex task URL of
the form `codex://threads/<task-id>`. It rejects all other schemes and
malformed links. A link must also fit the session's surface, taken from
Claude Code's `CLAUDE_CODE_ENTRYPOINT` and the recorded window: a `vscode://`
link only in the VS Code extension (`claude-vscode`), a `claude://` link only
in the Claude desktop app's Code tab, a `codex://` link only in the Codex app.
A CLI session in a terminal, including the Claude desktop app's terminal
panel, has no link: soak ignores one and prints `link: ignored — <why>`. The
glass and `lobstah focus` skip a stored link that contradicts the trap's
window and focus the window instead. The glass checks a stored link again
before rendering it.
`lobstah focus <trap>` accepts the trap id with or without `wt:` and reports
the focus step or why it could not focus. It does not revive a signed-off trap.

**Soak can create the worktree.** From a repo's primary checkout, or with
`--repo <key>` from outside any configured repo, soak creates a linked
worktree the same way a dispatch does. It fetches trunk, adds
`~/.lobstah/worktrees/soak-<trap>` on a new branch `lobstah/soak-<trap>`
from `origin/<trunk>`, and runs the repo's `setup` commands. Without
`--repo`, soak run outside a configured repo fails with an error that names
`--repo`. In a linked worktree, `--repo` must match that worktree's repo.
Soak prints `worktree: <path>`, `created: true`, and `branch:`. When the
session is not inside the worktree, it also prints
`instruction: cd <path> and work in that directory from now on`, and its
help lines carry `--session <id>`. The session changes into that directory
before it takes work. If creation fails (setup fails, the
`[limits].minFreeGB` check fails, or trunk cannot be fetched), soak signs
nothing on, removes the partial worktree and its branch, and prints the
cause. The address is `wt:<trap>`. The registration records
`createdWorktree: true`, and `.lobstah-trap` records `createdBy: "soak"`,
the session id, the repo, and the branch.

Soak is idempotent. A session that already mans a trap re-uses it when it
runs `soak` or `soak --wait` outside a linked worktree: the trap is resolved
from the session id, and no second worktree is created. A worktree that soak
created for the same session and repo is also re-used after a ghost sweep.
From outside the worktree, `soak --wait`, `report`, and `stow` find the
trap by session id (`--session <id>`, or `$CLAUDE_CODE_SESSION_ID`), and
`send session:<id>` addresses it. With `--session`, or from inside the worktree, `report done` records the
worktree's HEAD commit and branch in evidence.

`stow` removes a worktree only when soak created it and nothing in it exists
elsewhere. It keeps the worktree and prints `worktree: kept` and a `reason:`
when soak did not create the worktree, or when the worktree has uncommitted
changes, untracked files that are not ignored, commits its upstream lacks,
or no upstream. Ignored files do not block removal. `stow --force` explicitly
allows removal of unsaved checkout files; `--keep` still keeps the checkout.
Stow runs the removal from the primary checkout, so it works from inside
the worktree. On removal it prints `worktree: removed`, `path:`, and
`returnTo: <primary checkout>`, with a help line `cd <primary>`. It
deletes the branch only when every commit on it is on its upstream (with no
upstream: on some remote branch);
otherwise it prints `branchKept: <branch> (<reason>)`. A deleted branch
prints as `branchDeleted:`. `stow --wt <id>` follows the same rules. The
SessionEnd hook (`lobstah stow --quiet`) signs off and keeps the worktree.
Releasing a claim whose last report is `done` or `failed` moves it to `done/`;
only an unfinished catch requeues (a cancelled catch finalizes as failed).

**Identity is the worktree.** Sign-on anchors a short trap id and two-word
name in `.lobstah-trap` and prints both, such as `amber-gull (wt:c32a245d)`; the address
survives session restarts — a new session in the same worktree resumes the
same trap (a *live* foreign session is refused: the session lock). The
name is reserved across all traps known to this lobstah home, including
stowed and swept traps. `--name` sets or changes it; malformed and taken
names are refused. The bare name, `wt:<name>`, and `wt:<id>` all address the
same live trap in `dispatch --for`, `send`, and `stow --wt`. Unknown names
list known names and never turn addressed bait into headless work. The id
remains the key in dispatch and claim records.

A dispatch shows its trap by name wherever it names the trap that claimed
it, ran it, or is addressed to it, including notes such as
`claimed by crisp-heron`. The name comes from the live registration, else
from the name registry, so a signed-off trap keeps its name. A trap with no
known name shows as `wt:<id>`. `lobstah status <id>` and `lobstah catch <id>`
print `trap: crisp-heron (wt:68c5da5f)` and write notes the same way.
`man tend`'s tables print the name alone. In the glass, the name carries
`wt:<id>` as its hover text, and a click opens that trap's modal.

The session id (from the plugin's session-start brief) lives inside the
registration as the liveness principal. The harness (claude or codex) is
inferred — from `CLAUDE*` / `CODEX*` in the environment, and when both are
set (one harness launched inside the other) from the session id's format:
Codex thread ids are UUIDv7, Claude Code session ids UUIDv4 — and
`--harness` overrides; an undecidable case refuses rather than guessing.
Once soaking, the same Stop hook
that parks a lobstah man parks the worker: at turn end it delivers messages
first, then claims bait and wakes with the brief. While it works a catch,
the park wakes it for `lobstah send` messages and cancels instead.

Routing follows ownership, and **addressed work is sticky**:
`dispatch --for wt:<trap>` waits for that trap and never falls back to a
headless spawn — if the trap ghosts, the orphan surfaces as a helm notice
(re-address, release, or cancel; `cancel` finalizes unclaimed queue items
with an audit record). Delivery stamps a receipt into evidence. Unaddressed
bait for a matching repo prefers a parked trap for `[soak].deferSecs`, then
the daemon spawns headless. Conversational steering goes through
`send wt:<trap> "..."` — a message, not bait: no branch, no catch, sender
stamped, bounced to the helm when undeliverable.

A soaking session proves it is alive three ways: its park heartbeat, its
reports, and its **beat**. The plugin's post-tool hook runs
`lobstah soak beat` after tool calls: at most once per 30 seconds it
refreshes the trap's beat and writes the claimed catch's activity. The hook
resolves the trap from the working directory, else from the session id. A
trap that works for an hour without reporting is not swept while it beats.
`[soak].beat = false` turns the hook off.

`lobstah soak` prints `title: <trap name>` at sign-on. When `soak --wait`
delivers work, it prints `title: <name> · <short first brief line>`.
`report done` and `report failed` print `title: <trap name>` again. The
brief text has control and terminal escape sequences removed and is capped
at 40 characters. A trap skill sets an available session-title tool to each
printed title, without retrying a refusal. Stow leaves the current title
in place.

Liveness has two failure shapes with two remedies: a registration that
parked before and went quiet (no park, report, or beat) past `[soak].ttlSecs` is a **ghost trap** —
swept and noticed. An unfinished catch requeues; a `done` or `failed` catch
finalizes in `done/`, never becoming orphaned bait. A soak-created worktree
is removed only when Git verifies a clean checkout with no commits absent
from its upstream. Dirty, unpushed, no-upstream, or unreadable checkouts stay.
The ghost notice includes the path, branch, modified-file count and
unpushed-commit count (or `unknown` when inspection fails). Other worktrees
stay in place. After the daemon's own tick gap exceeds `[soak].ttlSecs`,
it grants a full TTL after resume before sweeping any traps, allowing
sessions to renew their heartbeats. One that **never parked** is a **defective
enlistment** — noticed with its diagnosis (usually a missing Stop hook →
`soak --wait`) and left standing so the address keeps protecting its work.
Nobody is conscripted: only a worktree whose session ran `soak` ever
receives work.

### Reserving a trap before its session starts

```bash
lobstah trap reserve --repo <key>       # reserve a trap; prints its name, id, and a one-time ticket
        [--harness claude|codex]        # print only that harness's start command
        [--name amber-gull]             # choose the name
        [--deadline 180]                # seconds the session has to sign on (default 180)
lobstah soak --ticket <ticket>          # in the new session: sign on as the reserved trap
lobstah stow --wt amber-gull            # withdraw a reservation no session has redeemed
```

`trap reserve` picks the two-word name and the `wt:` id before any session
exists and writes a **starting** reservation (`soaking/<id>.starting`) with a
deadline. `dispatch --for <name>` works on it at once: the work waits, as it
does for any addressed trap. `man tend` and the glass show the trap as
`starting`.

The output holds a one-time ticket and the command that starts the session in
the repo's primary checkout:

```bash
cd <repo> && CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1 claude "/lobstah:soak --ticket <ticket>"
cd <repo> && codex '$lobstah:trap soak --ticket <ticket>'
```

Nothing starts the session for you: a person runs the command. The session's
soak redeems the ticket, from `--ticket` or from the `LOBSTAH_TRAP_TICKET`
environment variable. It creates a worktree named after the reserved id,
signs on under the reserved name and id, and deletes the reservation. The
ticket then redeems nothing. A spent ticket left in `LOBSTAH_TRAP_TICKET` is
ignored; a spent `--ticket` is refused, except in the session that redeemed
it. A session that already mans a trap cannot redeem a ticket.

A reservation still unredeemed at its deadline **fails**: the daemon posts one
`trap-start-failed` notice, and the glass shows the trap as `start failed`
with the reason. Work addressed to it stays queued. The ticket still redeems
after the deadline. `lobstah stow --wt <name>` withdraws the reservation; its
addressed work is then orphaned bait and the helm gets a `bait-orphaned`
notice.

### Asking for a trap from the glass

The Traps tab and the deck's traps block have a **+ New trap** button. It
opens a small form: a repo (from the configured repo keys) and a harness
(`claude` or `codex`). Submitting it files a **trap request**: the glass POSTs
`{ kind: "trap-request", payload: { repo, harness } }` to `/requests` with
the same same-origin and page token guard as the open-window button. The
server checks the repo and harness, writes `~/.lobstah/requests/<id>.json`
(kind `trap-request`), and runs nothing. `/requests` refuses a body larger
than eight attachments (`[limits].attachmentMaxBytes` each, as base64) plus
room for text, with 413. After it reads the kind, it refuses a `trap-request`
larger than 4 KB with 413.

A request wakes the helm's `man wait` (and the Stop-hook park) as a
`trap-request` event with the request's id, repo, and harness. An open
request also wakes a helm that signs on later. The glass shows it at once as a
greyed card: `requested · <repo> · <harness> · waiting for the helm`, or
`waiting for a helm` when no helm is signed on.

```bash
lobstah trap requests                  # open trap requests
lobstah trap reserve --request <id>    # reserve what the request asks for, and close it
```

`trap reserve --request <id>` takes the repo and harness from the request,
records the request on the reservation, and closes the request. The card
becomes the starting card, then the live trap when the session signs on.

Every starting card shows the start command `trap reserve` prints, with a copy
button: paste it into a terminal to start the session by hand. The ticket in
it is kept in `soaking/<id>.ticket` (mode 0600) until the reservation is
redeemed or withdrawn. The glass sends it only to a page on this machine's
own glass address, only on the starting card, and no notice or log carries
it.

### The terminal tab name

At sign-on, soak names the session's terminal tab after the trap. It finds the
tab by the tty recorded in the registration's window: a Terminal.app tab gets
the name as its custom title, an iTerm2 session gets it as its session name.
Other terminals are left alone. `lobstah stow` clears the name.
`LOBSTAH_TERMINAL_TITLE=0` turns naming off.

Claude Code writes its own title to the tab, and in Terminal.app that title
replaces the custom title. `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` on the
command that starts Claude Code stops that for that one process; the start
command `trap reserve` prints sets it. Codex also sets the terminal title.

### Culling and disk space

Worktrees are 1 to 8 GB each. `lobstah cull` sweeps what is finished: `done/`
entries older than the window (`--older-than <days>`, default 14), worktrees
whose dispatch is finished or gone, stale state files, merged or closed PR
records, and orphaned acks. It never touches queued or active work, and
`git worktree remove` keeps each dispatch's branch. A worktree that soak
created counts as in use while a trap registration anchors it. After that,
the cull and the daemon's retention and free-space culls can remove it only
when the same clean-and-pushed safety check passes; unsaved soak checkouts
remain protected even without a registration. A worktree that follow-ups
reused is one worktree shared by the chain: it stays while any dispatch in
the chain is queued or active, and it ages from the newest dispatch that
used it.

Without `--apply` it is a dry run: it measures each target and prints the
sizes. A worktree is measured with one `du -sk`; where `du` is missing
(Windows) a file walk measures it instead. `--apply` measures nothing. It
deletes, then prints the count and the change in free space on the worktrees
volume.

```
$ lobstah cull
cull[2]{kind,id,ageDays,bytes}:
  done,6a1f…,21,4120
  worktree,6a1f…,21,3221225472
totalBytes: 3221229592
total: 3 GB
dry run — pass --apply to remove
```

The daemon can do this on its own. Two `[limits]` keys turn it on
([configuration](configuration.md#limits)); both are off by default:

- `retentionDays` — once an hour at most, the daemon culls finished
  dispatches older than this, 10 at a time. A dispatch whose PR is still open
  is kept.
- `minFreeGB` — before it claims work (each claim creates a worktree), the
  daemon reads free space on the worktrees volume. Below the limit it removes
  finished worktrees, oldest first, until the limit is met. If space is still
  short, the work stays queued. `man tend` shows it as
  `held (3.2 GB free, needs 10 GB)`, the glass shows the same reason in the
  note column, and one `disk-held` notice reaches the helm. When space
  returns, one `disk-cleared` notice follows and claiming resumes.

A third key, `releaseOnMerge`, frees a worktree as soon as its PR merges
instead of waiting out `retentionDays`. When a PR watch records `merged`, the
next cull pass removes the worktree of the dispatch that owns the PR and of
every dispatch in its follow-up chain that ran on that PR. It checks first:
every dispatch in the chain is finished, the worktree is clean, and its HEAD
is on the remote after a fetch. A worktree that fails a check is kept and
listed as `kept: unpushed work`. A PR closed without merge releases nothing,
and a trap's worktree is never released. Branches and the dispatch record
stay; `lobstah catch` says `worktree: released on merge (<time>)`. One
`worktree-released` notice per pass lists what went.

`lobstah doctor` prints a `disk` row: free space on the worktrees volume, the
limits, the count and age of the worktrees a cull could remove, and any
merged PR's worktree that `releaseOnMerge` kept, with the reason:

```
disk  warn  412.3 GB free on ~/.lobstah/worktrees; minFreeGB 10; retentionDays 14; 3 cullable worktree(s), oldest 9d; releaseOnMerge on; kept: unpushed work (1 worktree(s) of merged PRs: 6a1f0c2e HEAD is not on the remote)
```

## What the daemon gives your liaison for free

- Parallel work that can't collide — worktree per dispatch.
- A crew that survives crashes: dead runners respawn (bounded), wedged ones
  are killed and forked with a nudge, and everything reconciles from disk
  after a reboot.
- An honest six-verb status contract, validated at the write path, so the
  liaison never has to parse prose to know where things stand.
