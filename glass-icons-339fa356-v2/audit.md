# Dispatch icons and Boats demo

Only queued, limited and unknown gain state icons. The original six dispatch icons stay unchanged. Trap, review, PR, generic-card, wharf-request and boat status icons match main. 

| Dispatch state | Before | After |
| --- | --- | --- |
| working | Spinner | Unchanged |
| needs-decision | Raised hand | Unchanged |
| blocked | Stop sign | Unchanged |
| paused | Pause bars | Unchanged |
| done | Check | Unchanged |
| failed | X | Unchanged |
| queued | Text chip | Tray — new |
| limited | Text chip | Hourglass — new |
| unknown | Text chip | Question circle — new |

`unknown` can appear on a real dispatch card. [Local glass](https://github.com/aequitas-labs/lobstah/blob/58c2c5e5/apps/cli/src/glass.ts#L373) uses it when there is neither a report nor a claim; [wharf glass](https://github.com/aequitas-labs/lobstah/blob/58c2c5e5/packages/glass-ui/ui/wharf-snapshot.ts#L55) uses it for a non-queued job without a report. `active` is a bucket, not a displayed dispatch verb; it gets no new icon.

Boats keeps its grid and Slack/Account sections; the value now says “Last check-in: 30s ago” without repeating “checked in”. 

## Dispatch fish

The selected simple side-view fish is an original body, tail and eye drawing. One inline SVG is shared by navigation, dispatch cards, deck chips, source links and notices.

[16, 20 and 32px](after-desktop-fish-sizes.png) · [Original SVG](simple-side-view.svg) · [Source e5771328](https://github.com/aequitas-labs/lobstah/tree/e5771328)

## Before and after

Playwright CLI only, with fixtures. Desktop: 1440×1000. Phone: 375px wide; the Dispatches capture is 1400px tall so all nine states fit, and Boats is 1000px tall.

| View | Desktop before | Desktop after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| Dispatches | [Before](before-desktop-dispatches.png) | [After](after-desktop-dispatches.png) | [Before](before-mobile-dispatches.png) | [After](after-mobile-dispatches.png) |
| Fish at 16, 20 and 32px | [Before](before-desktop-fish-sizes.png) | [After](after-desktop-fish-sizes.png) | [Before](before-mobile-fish-sizes.png) | [After](after-mobile-fish-sizes.png) |
| Boats | [Before](before-desktop-boats.png) | [After](after-desktop-boats.png) | [Before](before-mobile-boats.png) | [After](after-mobile-boats.png) |

## Validation

Full build and lint pass. Root: 3,920/3,920 tests across 320 files. Wharf: 169/169 tests across 16 files. The reduced branch also passes 163 focused behavior tests. Three formatting fixes inherited from main are retained because the required lint check flags those files; they change no behavior or icons.

The selected SVG also passes the shared UI build and 67 focused behavior tests. The after screenshots show the selected fish.
