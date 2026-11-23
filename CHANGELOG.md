# Changelog

## 0.8.17 — 2026-11-23

### Slack

- Cards from a grounds on the Mac that mirrors to a wharf now reach the wharf
  and Slack, and can be answered there. (#608)
- Slack messages post again. Card messages, receipts and the grounds question
  had failed before they left the wharf. (#609)
- Each Slack message gets a ⭐ at once, and lobstah answers only with links to
  the glass. (#610)
- Slack links to the person on their wharf, with no grounds list. Cards from
  every boat and grounds on the account arrive, each naming its grounds and
  boat. (#612)
- A person has one helm at a time, on the Mac or the wharf, and every Slack DM
  goes to it. (#613)
- The glass's Slack row has a Send to Slack choice of which kinds of card
  arrive. (#614)
- A review card in Slack can submit a drafted review, or approve it when the
  draft approves, after Slack asks you to confirm. (#615)

### The glass

- Answering a card or messaging the helm shows as done at the click, even when
  the machine is busy. If delivery fails, a toast opens the card or thread with
  your draft to send again. (#604)
- Helm messages in a thread render as Markdown, long card titles wrap, and the
  new decisions alert stays hidden on the Threads page. (#606)
- The hosted glass shows PR evidence images from raw.githubusercontent.com.
  (#607)
- A line typed into an interactive run from the hosted glass reaches the
  script. (#616)

### Traps, run cards and the wharf

- A trap announces that it is free once per free period, and stays quiet while
  it holds work. (#603)
- A finished run card records its outcome as an answer the helm acknowledges,
  and leaves the open-card lists. (#611)
- The wharf deploy script applies the migrations it lists after one confirm.
  (#616)
- `lobstah wharf login` keeps waiting for approval instead of failing after
  about 2.5 minutes. (#617)

## 0.8.16 — 2026-11-21

### Threads and reviews

- The helm can start a thread and link cards, dispatches and a chat summary to
  it. Standing cards can be answered inside the thread. (#596)
- GitHub review cards show the GitHub logo beside the repo and PR context.
  (#600)
- New reviewer feedback gives PR repairs a fresh retry budget. (#599)

### Traps and run cards

- A trap waiting for an ume review uses its own ume project. (#597)
- Parked Claude traps wake when their own background task finishes. (#601)
- Run cards use the interpreter named by the script's shebang. (#594)
- Run cards can find the repo when the glass runs a copy of the deployment
  script. (#595)

## 0.8.15 — 2026-11-20

### Talking to the helm

- Messages from the glass become threads on their grounds and wake the helm.
  The helm can triage, keep notes, ask on a card in the thread and resolve it
  with an outcome. Unanswered messages are repeated, and idle threads without
  open cards close after seven days. (#557)
- The glass has a Threads page with one list of compact thread cards and a
  ship's wheel button that opens one message composer. Thread replies use the
  card composer, with the same attachments, paste handling and saved drafts.
  (#558, #567)
- Wharf grounds store the same threads as local grounds, and phone attachments
  upload to account storage. (#560)
- Unread helm replies show under Response waiting until they are on screen.
  Reading or dismissing a reply does not answer a linked card. (#561)
- `lobstah man say` lets the helm reply in a thread. A thread reads as one chat:
  your messages on the right, the helm's on the left, and its notes pinned on
  top. Linked work shows its kind's icon and its state. (#572)
- When the helm resolves a thread while linked work is still running, the
  thread moves to Tracking and closes when the work finishes. If the work
  stalls, the thread comes back to you. (#575)
- A Slack message's Open in glass button opens the helm thread it started.
  (#571)

### Decisions

- Decisions can show the report and PR cards needed to answer them. Opening one
  and coming back keeps your unsent answer. (#554)
- An answer to a decision card stays in front of the helm until the helm
  acknowledges it with `lobstah man ack`. (#573)
- A card asked about a PR shows a tag naming that PR. Merge when green on the
  PR card closes the decision card. (#589)
- Previous and Next work on an answered card handed to the helm. (#591)
- A worker question already covered by an open card wakes the helm once, not on
  every reminder. Cards stay visible while the worker moves on. (#563)

### Reviews and PRs

- Review buttons say Approve, Request changes and Publish comment again. A PR
  you are no longer asked to review leaves Needs your review and stops
  drafting. (#565)
- When a re-review finds one of your own threads fixed, lobstah resolves it as
  soon as the draft finishes. (#568)
- Needs your review and Waiting on response count every review they hold. The
  PRs page splits PRs into Open and Closed. (#579)

### Dispatch and traps

- The helm's dispatches go to traps by default. `--headless` asks for a
  one-off headless worker. (#581)
- The helm's Stop lists every open card each time, so a missing card means it
  was answered or withdrawn. (#582)
- A `--when "dispatch:<id> ..."` trigger on a finished dispatch is refused and
  names the follow-up to wait on. (#583)
- A trap's catch stays addressed to it through a fresh-session swap, so another
  trap cannot claim it during the handover. (#584)
- Codex traps get past another plugin's hook review without trusting those
  hooks, and the helm is told which plugin it was. (#566)

### Glass speed and order

- With one page open, the glass uses about 5% of a CPU instead of 56%.
  `man wait --peek` and `attention --json` do much less work per call. (#576)
- In-flight dispatches are ordered by their last real update, so the list stays
  put between polls. (#580)

### Maintenance

- Fixed two CI test failures. Tests that run built code fail early when the
  build is older than the source. (#590)

## 0.8.14 — 2026-11-19

### Glass actions and views

- Browser Back and Forward follow decision cards and restore the selected tab
  and scroll position when returning to the list. (#529)
- Review action errors appear in plain toasts. Re-draft stays available on
  review cards, rows and PR views; publishing waits until drafting finishes.
  (#530)
- Running cards show elapsed time and recent output. Stop asks for confirmation,
  keeps captured output and stops descendant processes. (#531)

### Reviews and PR feedback

- Verified base-only updates can automatically restore the configured reviewer's
  approval. Uncertain updates show that another review is needed. (#533)
- Pending review drafts stay visible and refresh automatically when stale.
  Edited comments survive replacement, and repaired drafts require Publish.
  Reviews group branch stacks in expandable cards with per-PR actions and
  navigation between drafts. (#539)
- Stack merges retry transient GitHub failures with backoff and refresh PR
  state before each attempt. (#537)
- Submitted reviews and inline comments wake feedback rounds, with related
  comments grouped and unresolved thread context included in the brief. (#545)

### Dispatch and trap sessions

- Headless work clocks pause while waiting for a person's answer. Unanswered
  questions park without failure and release their slot; late answers resume
  the same session. PR-bound questions accept answers through terminal, Glass
  or matched human PR replies. (#548)

### Maintenance

- Small cache cleanups stay quiet. Above the dispatch disk floor, pressure
  cleanup runs at most once per trap per hour. (#534)
- Finished review chores release clean, published checkouts. A background cull
  worker drains eligible worktrees while preserving dirty or unpushed work.
  (#535)
- Disk pressure can clear caches and remove clean, published PR checkouts
  waiting only for review. Branches and records remain available, and disk
  holds report their elapsed wait. (#540)
- Cull previews and stops idle worktree servers and containers while protecting
  active workers and shared services. (#544)
- Doctor checks GitHub with the configured pickup token and keeps token values
  out of diagnostics. (#538)

## 0.8.13 — 2026-11-17

### Glass actions and views

- The PRs tab shows PRs opened by you or traps, with shared PR and review tags
  and one purple Merged tag. Review actions share progress across views, and
  switching tabs keeps the page position. (#523)
- Merge when green shows its short state or active hold reason on PR cards,
  review rows and the PR view. Cancel merge stays available. (#524)
- On deck shows active traps as compact buoys with harness marks, status icons
  and repo names. Hover, focus or touch shows work and model details; Traps
  counts signed-on workers. (#525)
- Dropdown actions center their icons and labels together, with consistent row
  sizes and full-width hover and focus highlights. (#527)

### Reviews

- Later review rounds keep unresolved threads, replies, earlier findings and
  verdicts. Explicit author re-requests can open a round at the same head;
  equivalent patches retain approvals, and push bursts wait for a quiet period.
  Stable finding IDs prevent duplicate blocking and inline comments. (#526)

## 0.8.12 — 2026-11-16

### Glass actions and views

- Phone menu links keep the selected page. On deck shows every open decision
  and repo capacity; report chevrons open reports inside Glass, and todo swipes
  follow the finger with a larger revealed Snooze target. (#504)
- Confirmations disappear after 2.5 seconds; decision notices stay until opened
  or dismissed. Toasts support swipe dismissal, and opening a review clears its
  notification while keeping the draft. (#505)
- Section headings keep spaces around counts and arrows. PR details put the
  drafted review above the description, simplify the header and keep description
  disclosure markers beside their text. (#507, #509)

### Reviews and merge authorization

- Review rounds retain drafts at an unchanged head, recognize submitted reviews,
  and distinguish merged, closed and withdrawn requests. A standing request
  opens a new round only when the PR's own diff changes. (#510, #517)
- Review drafts collect decisions separately from findings. Answer every decision
  before posting; saved answers survive reloads and matching redrafts. **New
  review** starts a fresh review after Skip or Dismiss. (#515)
- The Reviews badge counts actionable rows, marks them with a dot and puts them
  first. **Approve anyway** confirms and posts an approval at the current head.
  (#520)
- Empty comment drafts are rejected before completion so the drafter can fix
  them. Secondary GitHub rate limits without a retry time back off from one
  minute to fifteen minutes. (#521)
- Merge-when-green authorization records its source, method and holds, survives
  session changes, and appears on PR and review views with **Cancel merge**.
  Stacked PRs merge from the bottom with fresh checks between merges. (#519)

### Dispatch and trap sessions

- Parked Codex traps stay registered through long reviews. Ending hooks cannot
  sign off a replacement session, and ghost recovery stops the old process
  before starting another. (#506)
- Turn-wait wakes return to the original dispatch and owning trap, restoring a
  stowed or ghosted owner with its saved context instead of starting a headless
  follow-up. (#508)
- Codex traps keep working after acknowledging a claim. Unread messages wake
  idle traps, and a stalled working trap gets one automatic recovery prompt
  before the helm is alerted. (#518)
- Departed tmux traps save their last 200 terminal lines before dead panes are
  closed; failed cleanup retries without disturbing live panes. (#511)

### Headless Codex jobs

- Configure the headless sandbox and model globally or per repo. PR review
  drafts default to fresh headless Codex jobs; the existing trap option remains
  available. (#512, #513)
- Headless SDK runs use the host's PATH Codex, with `cli_path` for an explicit
  executable and a warning before falling back to the bundled CLI. (#516)

### Maintenance

- The release cut script checks the GitHub API exit status so a missing tag is
  not mistaken for an existing release. (#503)

## 0.8.11 — 2026-11-13

### Glass actions and views

- Glass actions now share sending, refusal and success feedback, including a
  toast that keeps resolved results visible after an editor closes. Drafted
  review verdicts post on the first click. (#486)
- Snooze todos from a clock on every open todo, including On deck; on phones,
  swipe to reveal the same action. Request an immediate todo and goals pass
  with **Recheck all**. (#493, #489)
- Group traps by repo, harness or status, with collapsed history and a repo
  overview of capacity and available workers. On deck shows traps that need
  attention. (#495, #496)
- Glass section and page headings use a shared scale, sentence case, counts,
  links and `+N more`. PR cards open to detailed PR views; phone dialogs use
  sheets, and jobs open to their own detail views. (#497, #498, #499, #500)
- Card menus put Mute and Skip beside the action they affect. (#501)
- Fine-pointer controls are compact while touch controls keep their larger
  targets. (#490)

### Dispatch and trap sessions

- Unaddressed dispatches start fresh sessions; addressed work and follow-ups
  keep their session. `dispatch --fresh` and `--continue` override the choice;
  `send --compact` queues compaction for supported sessions. (#485)
- Hooked traps keep waiting in the shell through quiet timeouts. The daemon
  auto-stows idle, free traps while retaining their worktrees and roster. (#487)
- Open cards now live in `man tend`; the Stop hook shows a paced section of
  those same rows. (#484)

### Helm and reviews

- Helm Stop output focuses on lifecycle notices and paced paused-dispatch
  reminders; `man tend` keeps the full roster and card lists. (#488)
- Clean review drafts approve without process commentary when there are no
  blockers or useful inline comments. (#492)

## 0.8.10 — 2026-11-13

**Upgrade every Mac to 0.8.10 before the wharf is redeployed.** The wharf, the
hosted glass and the Mac's mirror now talk over one WebSocket (`lobstah.2`).
Once the new wharf is up, it answers an older CLI's mirror with 426 or 410 and
the minimum version, and that Mac's fleet stops showing on the hosted glass
until it upgrades. Deploy the new wharf the same day: until it is up, a 0.8.10
boat on wharf grounds falls back to reading every 30 seconds.

### The wharf, the hosted glass and the mirror share one socket

- The wharf speaks one socket protocol, `lobstah.2`, for both the Mac's mirror
  and the hosted glass. A dropped socket resumes from where it was, so a drop,
  a deploy or the wharf going idle loses nothing. One alarm replaces the wharf's
  polling for expired calls and files. (#453)
- The hosted glass reads its socket: each boat's snapshot is pushed to every
  open tab, relayed calls and their answers go over the socket, and the page
  polls nothing while the socket is open. It goes back to polling at once when
  the socket drops. (#455)
- The Mac's mirror keeps one socket open to the wharf, instead of polling every
  two seconds. The wharf pushes the calls addressed to it, when a hosted glass
  is watching, and the other boats' lists for the pet. While no hosted glass is
  open, the mirror sends the wharf nothing. (#457)
- A boat on wharf grounds, a hosted trap and a waiting helm learn of work from
  events the wharf pushes on the socket, instead of polling it, and read over
  HTTP only when something changed. (#459)

### The PRs tab

- A stack of several PRs is one card: its title, a summary ("ready to merge",
  "1 failing", "2 of 3 green"), how many PRs it holds, its repo and last
  update, and Ack stack. A click opens it to each PR's own card, the bottom of
  the stack first. A lone PR is an ordinary card. (#456)
- Every PR, review and stack card has a small avatar chip at its top right: the
  PR's author, or who asked for the review. The name shows on hover. (#456)
- A PR's "checks 3/4" chip shows the checks' breakdown on hover, and the card no
  longer repeats it. (#458)
- Merge when green is one click to ask and one to cancel ("Cancel merge"). It
  always merges the repo's way, which its hover names. (#458)
- ↗ Open sits at the right of the bottom bar on PR, stack, review and trap
  cards. A report card opens from an arrow at its top right. A trap card shows
  its catches on its repo line. (#458)

### Dispatch and run cards

- An in-flight dispatch shows its verb as an icon in a small pill: an amber
  spinner while working, a blue hand when it needs a decision, a red stop sign
  when blocked, a grey pause, a green check when done and a red X when it
  failed. Its hover says the verb, how long it has been in it, and what it
  waits on. (#468)
- One colour meaning everywhere: amber is in progress, so a working trap is
  now amber, not green. Green is done or idle and listening, grey is paused,
  not listening or signed off, red is blocked or failed, and blue needs a
  decision. Trap chips stay words, in these colours. (#468)
- Recent runs shows each run's status icon, as the run card does: a check, an
  X, a clock for a timeout, or a square when stopped. (#462)

### Traps, hooks and waits

- A lobstah hook fails open: on any error it writes one line to stderr,
  records the error, and exits 0, so the turn goes on. `lobstah doctor` fails
  the hooks row for a hook command this CLI doesn't know, or one that failed
  since its last run. (#464)
- `report paused --waiting-on review --link <url>` with a link that isn't a
  GitHub PR (a plan or spec under review in its own tool) is accepted and
  wakes nobody: no helm wake, reminder or card. A wait on a person is still
  `needs-decision`. (#465)
- Lobstah owns a trap's turn end. Other tools register a wait under
  `~/.agent-turn/<session>/` instead of adding their own Stop hook, and the
  daemon runs it and points the trap at what's new. `docs/turn-end.md` is the
  contract. (#466)
- `lobstah doctor` has a `turn waits` row. It lists every other Stop hook a
  harness loads, warns about a long one whose tool never registered a wait,
  and shows the waits lobstah runs, warning about one that keeps failing.
  (#469)
- `lobstah doctor` and a stalled `lobstah throw` now name untrusted or changed
  hooks installed by another Codex plugin, while respecting disabled hooks and
  leaving the other plugin's trust alone. (#470)
- A registered wait that exits with an error is a failure even when it takes
  more than ten seconds; its stderr is kept for doctor and retries back off.
  Quiet exit codes still retry at once. (#471)
- When a heavy command finishes, its paused traps wake durably, including after
  a restart. A failed wait does not lose the completion. (#477)

### The glass

- Run cards lead with a terminal icon on the deck. Run, Decline, Stop, Run
  again and Dismiss sit in one row in the open card. (#472)
- Reports open in a sheet over the glass, with Back, Escape, browser back and
  the phone back gesture returning to the same tab and scroll position. (#473)
- Card buttons share one size and one main action; Open is an icon at the right
  of the bar. Opening a card acknowledges it. (#474)
- PRs leave On deck for the PRs tab, where a whole stack can merge when every
  PR is green. (#475)
- Glass buttons use one shared Button component, keeping behavior and sizing
  consistent. (#476)
- Settings, dialogs and navigation are easier to use across desktop and phone;
  boat actions, permissions and configuration have clearer sections. (#478)
- The helm's turn-end reminder lists open cards, including standalone run
  cards and cards attached to paused work. (#482)
- Dispatches show queued, limited and unknown states with distinct icons, and
  boat status, check-in details and actions are clearer. (#483)

### Wharf mirrors

- A mirror reloads its saved boat credential on reconnect, retries reads after
  a socket failure and reports a long outage once, so replacing a credential
  can recover without restarting the daemon. (#479)

### Usage limits and harnesses

- Claude allowance exhaustion appears as a limited state with a reason and
  reset time; pickup avoids the limited account. Live catches can move between
  harnesses with `lobstah swap`, retaining their work and inbox. (#481)

### Reviews

- Review rounds can be dismissed or muted, with per-verdict automatic posting
  controls and a GitHub identity check. Posted reviews show their timestamp and
  link. (#480)

### Also new

- `lobstah man wait` with a short timeout ends on time: `--timeout 1` takes
  about a second, not 1.7. (#454)

### Docs

- The README's "Choose your approach 🧭" puts the background router and the
  lobstah man side by side in a table. A new Glass section shows the glass at
  phone size with On deck in view, and covers the hosted glass. Telemetry is
  one paragraph, with the full text in `docs/telemetry.md`. (#463, #467)

### Maintenance

- CI runs the Windows tests only when a change can affect Windows; a push to
  main always runs them. (#451)

## 0.8.9 — 2026-11-12

### The PRs tab leads with yours

- The PRs tab puts your PRs first, under Yours, and a stack stays together if
  any PR in it is yours. Every other watched PR sits under Other PRs, closed
  until you open it. A watched PR is yours when `gh` says you wrote it, or a
  dispatch opened it. A PR you opened by hand joins with
  `lobstah watch add <url>`. (#438, #439)
- On a phone, the bottom bar shows Reviews and PRs side by side, each with its
  own icon. Search and Menu are icon buttons. The PRs tab counts your open PRs
  that need you: failed checks, a conflict, or a repair that stopped. In a
  narrow desktop window, PRs stays in the bar beside On deck and Reviews, in
  the same order. (#439, #446)
- Merge when green: each open PR of yours has a button that merges it once its
  checks pass and nothing below it in its stack is open. A PR with a conflict or
  failing checks is repaired first. A PR no dispatch opened gets one repair
  dispatch per head, and a stopped repair sends the helm one notice. The method
  is `[repos.<key>].mergeMethod`, else `[pickup.github.merge].method`, else
  squash. The hosted glass offers it too. (#441)
- PR and review cards share one layout: the PR icon in the PR's color and the
  title, then status chips, then a gray line with the repo, age, number, trap
  and checks, and the card's buttons along the bottom. (#446)

### Run cards

- A run's output shows as a terminal showed it, on the card and in the helm's
  answer. Carriage returns, colors, erasing and cursor moves are applied, so a
  spinner or an answered prompt shows once, without escape codes. The raw
  `output.log` is kept as it was. An emoji in an interactive run is no longer
  garbled. (#444)
- A finished run leaves the glass two minutes after it ends. Runs from the last
  week sit under a closed Recent runs on the deck, each opening its card
  read-only. The daemon prunes run history older than
  `[limits].runRetentionDays` (14), and proposals the helm never posted after a
  day. (#445)
- A run card shows its status as an icon: a green check, a red X for a failure,
  a red clock for a timeout, a spinning amber circle while it runs, a grey
  square when stopped, and a slashed circle when declined. (#448)

### Also in the glass

- Ctrl+Enter, or ⌘+Enter on a Mac, sends from a card's answer box and from the
  hosted glass's box for messaging the helm. (#448)

### Reviews judge the code

A drafted review's verdict is about the code alone. A merge gate, required
check, submit or approval label, or CI status that is red, pending or older than
the head never turns an approve into a comment. The review never mentions one
or asks for a rerun. A test the change breaks is still a finding. (#432)

### The wharf

- It no longer writes a SQLite row on every request. Request budgets and the
  hosted glass's watch are counted in memory, so a poll writes nothing and a
  snapshot put writes at most two rows. A busy day had come close to the
  Durable Objects' daily limit, past which the hosted glass breaks. (#447)
- Its records of retried commands expire after a day, so they no longer count
  toward an account's row limit. (#450)
- `SLACK_CLIENT_ID` is set once on the Worker, like `GITHUB_CLIENT_ID`, and
  kept across deploys. Before, `wrangler.jsonc` listed it empty, so every
  deploy blanked it and the glass offered no Slack link. (#442)
- `services/wharf/scripts/deploy-from-main.sh` deploys main: it checks the
  live version and pending migrations, applies them, deploys, checks health
  and prints the rollback. `--set-var SLACK_CLIENT_ID` sets that var from
  stdin. (#449)
- `lobstah wharf <command>` without `--wharf` acts on the one wharf this Mac's
  mirror is logged in to, and otherwise says to add `--wharf` with the names.
  (#449)

## 0.8.8 — 2026-11-11

### Run cards

The helm can hand a person a command to run as a run card:
`lobstah man ask --run <script>`, with `--input NAME:secret`, `--interactive`,
`--cwd`, `--timeout` and `--output scrubbed|exit`. The glass shows the whole
script. The person confirms it with a passkey on this Mac, and the glass runs
it here with its inputs on stdin and its output scrubbed of every secret. An
interactive card takes answers to its prompts from a console on the card. Each
attempt is kept, with Stop, Run again and Dismiss, and prev and next still work
after a run ends. The helm's brief tells it to offer a run card whenever a
person must run something on the machine. (#376, #379–#381, #390, #392, #427)

### Run cards from the phone

A phone can run this Mac's cards from the hosted glass. Pair it once with
`lobstah run passkey add --hosted`, which prints a link to open on the phone.
One passkey confirmation covers 15 minutes of runs on that page. Secret inputs
are sealed to the Mac's key in the page, so the wharf only relays sealed
values. Stop, Run again and Dismiss work there too. An interactive card can be
answered from the phone: each line is sealed to the Mac and signed by the page
that started the run, so the wharf can't read, forge or replay one. (#411–#414,
#428, #429)

### Cards in Slack

The wharf carries a person's cards into their Slack DM. A person links their
own Slack from the signed-in glass. A link serves the grounds they choose. The
wharf keeps one card per glass item and sends it through a durable outbox, and
a boat restates its own cards (permission requests, local decisions, PR
attention, notices) to the wharf of their grounds. From the DM a person can ask
for work, which the helm answers, and answer a card with its buttons. A boat
applies a Slack answer once, only while its card still stands as answered.
Allow from Slack is on for each enrolled boat, and
`[wharves.<name>] remoteAnswers = false` keeps Allow in the boat's own glass.
(#301, #303, #305, #307–#311, #398)

### The glass on a phone

- Every glass draws the same short cards for traps, dispatches, decisions, PRs,
  reviews, reports, grants and boats. (#400, #401, #403, #404)
- On a phone the header is one line, the views move to a bottom bar, and
  decision and run cards open as a full page. (#405, #406)
- Approving a boat opens its own page. Signed out, it shows the sign-in card
  alone, then a large code. (#393, #407)
- The decision dock is one composer, with attach and Send as icon buttons.
  Decisions are single clickable rows, and titles drop their leading #.
  (#423, #424)
- Cards show a PR's status under its title, gray subtitles, and trap and repo
  icons. A dispatch card shows the PR of its current work, not the first one it
  reported. (#391, #436)
- Links that leave the glass open in a new tab, marked ↗. (#422)
- The todo count counts open todos only. Today's done todos are a quiet line on
  the deck and a closed Done today section on the TODO page. (#435)
- Plain words on the glass and the wharf, and one name for a dispatch. (#409,
  #410)

### The hosted glass

- Its configuration stays read-only, as on the local glass. (#396)
- A boat's report opens on its own page, the Reviews tab shows each asker's
  avatar, and ↗ Open shows on the traps of the boat the browser runs on. (#397)
- Opening a job no longer stacks relayed reads into a 429. (#425)
- With the `attention` grant, the pet walks every mirror boat's items, as the
  hosted glass shows them. The glass's lobs and the pet walk the same list, and
  clicking a lob acknowledges it everywhere. (#399, #420, #421)

### Reviews

- A finished review draft waits on the Reviews page, outside the helm's
  decisions. (#418)
- Turning on automatic reviews no longer starts jobs for old requests, a mode
  change takes effect on rounds in flight, and cancelling a review reaches its
  trap without waiting for it to park. (#394)
- Review feedback is no longer held behind a round paused on its reviewers.
  (#430)
- The daily cap (`[reviews].maxPerDay`) stops only automatic reviews. A review a
  person asks for always runs. (#431)

### Traps

- A Codex trap that claims work and goes silent is woken after
  `[soak].codexClaimWakeSecs` (120), and its work goes back to the queue after
  `[soak].codexClaimReleaseSecs` (600), with one notice to the helm. Hook trust
  is refreshed when the Codex plugin changes. `man throw` won't start a second
  Codex on a trap's conversation, and `man throw --stop-stale` stops the one
  holding it. `lobstah man tidy-panes [--apply]` closes dead, duplicate and
  leftover Codex panes. (#433)
- A repo's trap cap counts only traps in use. Stowed and ghosted traps show
  apart, and a trap never parks on its own PR's CI or review. (#434)
- A permission card retires when its tool call ends, and a late answer makes no
  grant. (#415)

### Also new

- Dispatch progress (queued too long, stalled, idle while working) walks on the
  pet and the glass only when `attentionKinds` names `dispatch-progress`. The
  helm always gets it. (#426)
- Stacks merge into the repository's default branch, and every dispatch PR
  stays tracked through retargets. (#388)
- A notice nobody owns is consumed without replaying later events. (#389)
- Contributors: agents read the writing skills before product text, and the
  wharf's wrangler wrapper runs without `--`. (#384, #385, #395)

## 0.8.7 — 2026-11-10

### The hosted glass shows this machine's fleet

A boat can now mirror its own glass to a wharf while its fleet stays on local
grounds. With `[glass] mirror = "<wharf>"` and
`lobstah wharf login --wharf <wharf> --mirror` (mirror and read access only),
the daemon puts the glass snapshot on the wharf, without the page token. It
does so within seconds of a change while a hosted glass is open, and every five
minutes otherwise. It carries out on the local glass the reads and writes made
there, and a relayed answer is recorded `by: wharf`. On one boat the hosted
glass renders exactly what the local glass does, in every tab: PRs, TODOs,
Notices, Grants, Stats, Settings and the rest. Several boats show at once as one
fleet, each row naming its boat, and each call goes to its row's boat. A boat
asleep for over two minutes shows its age, and its rows are read-only. ↗ Open is
never relayed: it shows only on the trap rows of the boat the browser runs on,
which a loopback probe finds. `lobstah wharf whoami --wharf <wharf>` and
`lobstah doctor` say how fresh the mirror is. (#372, #375, #377)

### A question and a permission request are two cards

A trap that asks a question and has a permission request pending gets both: a
decision card that takes options or text, and a permission card with Allow once,
Allow always and No. Either can come first. Answering one never answers or
clears the other. (#371)

### One Open per trap

Every trap row shows a single ↗ Open, which takes the trap's best route: raise
its window on this Mac, else its live link, else its session link. The trap
modal lists every way in, each with where it works. (#373)

### Stale builds are caught

- A running glass or daemon reports the version it started with, so after an
  upgrade `lobstah daemon restart` restarts a detached glass that still serves
  the old page, and `glass status` and `doctor` flag one. (#367)
- `lobstah pet install` builds the desktop pet from the sources the npm package
  now ships, and stamps it with the CLI version. `doctor` warns when the pet is
  behind, and the daemon rebuilds a stale one. (#370)

### Also new

- A trap whose command waits or runs in the heavy line is working: no
  `idle-while-working` notice until the run ends and the grace period passes.
  (#368)
- Trap briefs and skills suggest summarizing a long heavy run through a subagent
  (the Agent tool, or Codex's `spawn_agent`). (#369)
- lobstah's ume plans and reports wear the glass's look (`.ume/theme.css`).
  (#374)

## 0.8.6 — 2026-11-09

### The hosted glass is the local glass

The wharf's glass now runs the local glass's own UI: its header, tabs, deck,
dispatch table and modal, decision modal, report pages, traps and reviews. It
shows only the tabs and controls the wharf can fill, and adds just its sign-in,
Boats and boat approval. The shared UI lives in `packages/glass-ui` behind one
backend interface, and a parity test fails the build when the two glasses
render a view differently. (#355–#360)

### A glass Allow is the go in auto mode

In Claude Code's auto mode, the classifier never sees a glass answer, so it
refused commands already allowed there. A refused call now files a card through
a new PermissionDenied hook. For a trap, PreToolUse honours Allow once and Allow
always. For the helm, the card reads `The helm wants to run: <command>`, and
Allow once covers that exact command for its session. (#364)

### Checklists and images on cards and reports

Task lists in a card's detail or a report are checkboxes. Ticks are saved beside
the document, show on desktop and phone, and never answer the card;
`man ask --show <key>` prints them. A withdrawn card keeps a read-only archive
at its link. Card details show remote `https:` images inline, with a plain link
when one won't load, and `man ask --detail` maps relative image links to its
`--attach` files as `man file` does. Reports show attached images where the
text names them. The glass page sends a strict Content-Security-Policy.
(#352, #353)

### Also new

- Wharf deploys keep the deployment's ids out of git: they live in a
  git-ignored `wrangler.local.jsonc`, and
  `pnpm --filter @lobstah/wharf run deploy` merges them in. (#363)
- CI retries a failed Windows test run once on one worker. (#361)

## 0.8.5 — 2026-11-05

### The desk: traps without a repo

A `[traps.<name>]` profile is a worker that serves one grounds from a plain
folder, with no git checkout, setup or culling. `soak --trap <name>` signs one
on and keeps it through stow, and `dispatch --for trap:<name>` queues work only
for it. The helm can send a desk step with `--assist`, and its findings and
attachments reach the original dispatch exactly once. A Claude Desktop profile
that isn't running gets one card with a prefilled link to start it. (#339, #343)

### The glass puts trap names first

Trap names lead headers, lists and cards. The repo or profile sits beside them,
and Claude Code and Codex show as their icons on trap cards and rows. A
read-only Settings tab shows the effective config, with secrets masked. Todos
show when they're due, and a row can set or snooze their time. Code on a card
has a copy button. Below 900px, every tab except On deck and Reviews sits behind
More. (#299, #314, #334, #337, #341, #345, #346)

### Intent grants: approve a kind of action once

A trap can propose the commands it needs on its card, as patterns with a
one-line label. Besides Allow once, the card offers **Allow this kind for 1h**,
for this trap, and **Always allow this kind**, for every trap in the repo. A
call matching the patterns runs and is recorded. Anything else goes to the
harness's own reviewer, unchanged. Broad patterns are refused: a bare command,
shell syntax, or a command that runs other commands. The Grants tab lists every
grant with its uses and a Revoke button. `lobstah grant ls` and `grant revoke`
do the same from the CLI. (#347, #348)

### Allow cards name the trap and command; reports never need one

A command card now reads `<trap> wants to run: <command>`, with the full command
first and the trap's own description after it. A trap's `lobstah report` never
becomes an Allow card, so a held question always reaches the helm. A tool card
can be allowed always, for every trap. Codex connector calls no longer file a
card before Codex's reviewer decides. The helm's `dispatch` and `send` relays
are allowed by default. (#313, #316, #324, #351)

### Also new

- **tmux traps:** `[soak] terminal = "tmux"` opens traps as panes in lobstah's
  own tmux server, titled with their repo and name. `lobstah tmux [repo]` opens
  an independent view, and a glass click opens a Terminal window on a pane
  nothing shows. (#312, #315, #317, #318, #320)
- **The heavy line:** `lobstah heavy -- <command>` queues full test runs, builds
  and agents' pushes for a few slots per machine. `man tend` and the glass show
  the line. (#326–#329)
- **Todos with a time:** `todo add --at`, `--in`, `--every "weekdays 09:00"`
  and `--when <trigger>`, which waits on a card, dispatch, PR or trap. Each wakes
  the helm once. Due todos and today's goals show automatically. (#323, #325,
  #331–#333)
- **Phones:** `man throw --remote-control` starts a Claude or Codex trap that a
  phone can drive, and the glass offers a phone only what works there. A session
  can hold only one trap and one writer. (#317, #342)
- PR rows and notices show titles, not only numbers. One pet notification per
  stack, on any base. (#300, #336)

### Fixes

- Thrown Codex traps sign on again: hooks are trusted with the hash Codex 0.166
  reports, and a checkout's committed hooks are trusted for the session. (#304,
  #340)
- Traps keep parking after a Mac sleep. (#321)
- A throw never resumes a session another trap holds. (#338)

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
