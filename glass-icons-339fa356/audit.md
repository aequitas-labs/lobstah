# Glass icons and Boats demo

The demo is ready for Chris's review. No PR is open.

Source: [feat/glass-state-icons-fish-339fa356](https://github.com/aequitas-labs/lobstah/tree/4081ace2).

Build and lint pass. Root tests: 3,921/3,921 across 320 files. Wharf tests: 169/169 across 16 files.

Playwright CLI screenshots use fixtures. Desktop is 1440×1000; phone width is 375px (812px tall, or 1000px for Boats so all three sections remain visible).

| View | Desktop before | Desktop after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| Every state icon | [before](before-desktop-state-icons.png) | [after](after-desktop-state-icons.png) | [before](before-mobile-state-icons.png) | [after](after-mobile-state-icons.png) |
| Fish at 16, 20 and 32px | [before](before-desktop-fish-sizes.png) | [after](after-desktop-fish-sizes.png) | [before](before-mobile-fish-sizes.png) | [after](after-mobile-fish-sizes.png) |
| Dispatches | [before](before-desktop-dispatches.png) | [after](after-desktop-dispatches.png) | [before](before-mobile-dispatches.png) | [after](after-mobile-dispatches.png) |
| Deck chips and cards | [before](before-desktop-deck.png) | [after](after-desktop-deck.png) | [before](before-mobile-deck.png) | [after](after-mobile-deck.png) |
| Boats, Slack and Account | [before](before-desktop-boats.png) | [after](after-desktop-boats.png) | [before](before-mobile-boats.png) | [after](after-mobile-boats.png) |
| Limited trap | [before](before-desktop-limited-trap.png) | [after](after-desktop-limited-trap.png) | [before](before-mobile-limited-trap.png) | [after](after-mobile-limited-trap.png) |

Please review the icons and Boats layout. After Chris approves, this branch will become one ready PR, then a merge commit once green.

# State → icon audit

Baseline: main 58c2c5e5, including #478, #480 and #481. Both hosts bundle the shared glass; the wharf adds boat status, request receipts and canonical cards.

| Surface | States | Before | Proposed icon | Change |
| --- | --- | --- | --- | --- |
| Dispatch | working | Spinning arc / reduced-motion dot | Same spinning arc | Existing, moved to shared map |
| Dispatch | needs-decision | Raised hand | Same raised hand | Existing, moved |
| Dispatch | blocked | Stop sign | Same stop sign | Existing, moved |
| Dispatch | paused | Pause bars | Same pause bars | Existing, moved |
| Dispatch | done | Check | Same check | Existing, moved |
| Dispatch | failed | X | Same X | Existing, moved |
| Dispatch | queued | Text only | Inbox tray | New |
| Dispatch | limited | Text only | Hourglass | New |
| Dispatch | unknown | Text only | Question circle | New |
| Dispatch bucket / grant | active | Text only | Activity pulse | New |
| Trap | working, busy | Text chip / colored dot | Spinning arc | Existing drawing, newly applied |
| Trap | requested | Text chip / dot | Bell | New |
| Trap | starting | Text chip / dot | Play circle | New |
| Trap | start failed | Text chip / dot | X | Existing drawing, newly applied |
| Trap | idle, listening, signed on, live | Text chip / dot | Radio signal | New |
| Trap | not listening | Text / grey dot | Radio signal crossed out | New |
| Trap | waiting, parked | Text chip / dot | Clock | Existing run clock, newly applied |
| Trap | limited | Text chip / red dot | Hourglass | New |
| Catch marker | unreported | Text only | Clock | Existing drawing, newly applied |
| Trap | signed off, stowed | Text chip / dot | Archive | New |
| Configured trap | configured | Text only | Sliders | Existing menu drawing, newly applied |
| Configured trap | needs-app-start | Text only | Play circle | New |
| Configured trap | ghosted | Text only | Ghost outline | New |
| Configured trap | missing-config, needs-setup | Text only | Wrench | New |
| Lifecycle notice | stalled | No dedicated state chip in current UI | Alert triangle | New |
| Review | requested | Text only | Bell | New |
| Review | drafting | Text only | Spinning arc | Existing drawing, newly applied |
| Review | drafted / draft ready | Text only | File with check | New |
| Review | stale | Text only | Clock | Existing drawing, newly applied |
| Review | failed | Text only | X | Existing drawing, newly applied |
| Review | posted | Text only | Send | Existing menu drawing, newly applied |
| Review | dismissed | Text only | Slashed circle | Existing run drawing, newly applied |
| Review | withdrawn | Text only | Undo arrow | New |
| Review verdict | approve / approved | Button check only | Check | Existing drawing, newly applied to state |
| Review verdict | comment / commented | Button comment only | Comment bubble | Existing menu drawing, newly applied to state |
| Review verdict | request_changes / changes requested | Button icon only | Alert octagon | New |
| Review markers | needs you | Text only | Raised hand | Existing drawing, newly applied |
| Review markers | muted | Text only | Bell crossed out | New |
| PR | open | Generic PR kind mark, state text only | Pull request | Existing menu drawing, newly applied to state |
| PR | draft | Generic PR kind mark, state text only | Pencil | New |
| PR | merged | Generic PR kind mark, state text only | Merge branches | Existing action concept, shared drawing |
| PR | closed | Generic PR kind mark, state text only | Slashed circle | Existing drawing, newly applied |
| PR / stack | repairing | Text only | Wrench | New |
| PR / stack | repair waits | Text only | Clock | Existing drawing, newly applied |
| PR / stack | conflicts | Text only | Crossing branches | New |
| PR / stack | checks failed, N failing | Text only | X | Existing drawing, newly applied |
| PR / stack | checks unknown, merge unknown | Text only | Question circle | New |
| PR / stack | checks pending, N of M green | Text only | Clock | Existing drawing, newly applied |
| PR / stack | review, unresolved threads | Text only | Comment bubble | Existing menu drawing, newly applied |
| PR / stack | behind | Text only | Back arrow | New |
| PR / stack | green, ready to merge | Text only | Check | Existing drawing, newly applied |
| PR / stack | blocked | Text only | Stop sign | Existing drawing, newly applied |
| PR / stack | merging, merges when green | Text only | Merge branches | Shared drawing |
| Run card | running | Spinning arc / still dot | Same | Existing, moved |
| Run card | succeeded | Check | Same | Existing, moved |
| Run card | failed | X | Same | Existing, moved |
| Run card | timed-out | Clock | Same | Existing, moved |
| Run card | stopped | Square | Same | Existing, moved |
| Run card | declined | Slashed circle | Same | Existing, moved |
| Decision card | unread, read, answered / sent | Highlight / accessible row label / sent text | Closed envelope, open envelope, check | New envelope drawings; existing check |
| Canonical card | standing, in progress, seen | Text only | Flag, spinning arc, eye | New flag/eye; existing spinner |
| Canonical card terminal | answered, resolved, landed, fulfilled | Text only | Check | Existing drawing, newly applied |
| Canonical card terminal | withdrawn | Text only | Undo arrow | New |
| Canonical card terminal | cancelled | Text only | Slashed circle | Existing drawing, newly applied |
| Canonical card terminal | expired | Text only | Clock | Existing drawing, newly applied |
| Wharf request | queued, received, authorized, fulfilled, expired | Text only | Tray, envelope, shield check, check, clock | New tray/envelope/shield; existing check/clock |
| Wharf receipt API | awaiting boat, pending, applied, refused, expired | No separate receipt component in current glass | Clock, clock, check, stop sign, clock | Shared mappings available; visible request rows and pending/delivered messages use state icons |
| Boat | online, asleep, revoked | Text chip only | Radio signal, moon, slashed circle | New signal/moon; existing slash |

The dispatch kind becomes one small-fish SVG everywhere. The existing paper-plane tab mark and fishing-pole slot marks are replaced; dispatch cards, rows and dispatch notices gain the same fish. No trap or repo mark is reinterpreted as a fish.
