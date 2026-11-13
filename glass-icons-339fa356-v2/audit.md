# Dispatch icons and Boats demo

Only queued, limited and unknown gain state icons. The original six dispatch icons stay unchanged. Trap, review, PR, generic-card, wharf-request and boat status icons match main. No PR is open.

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

Boats keeps its grid and Slack/Account sections; the value now says “Last check-in: 30s ago” without repeating “checked in”. The source is [ce3d1544](https://github.com/aequitas-labs/lobstah/tree/ce3d1544).

## Pick the fish

[Four candidates at 16, 20 and 32px, plus each at 16px in a Dispatches tab](fish-candidates.png)

| Name to choose | Candidate | License and source |
| --- | --- | --- |
| A · Lucide Fish | [SVG](lucide-fish.svg) | [ISC license](https://github.com/lucide-icons/lucide/blob/c55aab36b553a7de50a0050e7042fd7b2d64664e/LICENSE), [drawing](https://github.com/lucide-icons/lucide/blob/c55aab36b553a7de50a0050e7042fd7b2d64664e/icons/fish.svg) |
| B · Lucide Fish symbol | [SVG](lucide-fish-symbol.svg) | [ISC license](https://github.com/lucide-icons/lucide/blob/c55aab36b553a7de50a0050e7042fd7b2d64664e/LICENSE), [drawing](https://github.com/lucide-icons/lucide/blob/c55aab36b553a7de50a0050e7042fd7b2d64664e/icons/fish-symbol.svg) |
| C · Tabler Fish | [SVG](tabler-fish.svg) | [MIT license](https://github.com/tabler/tabler-icons/blob/6e68709e20ad8878de0332c64fcfb32d24e2b304/LICENSE), [drawing](https://github.com/tabler/tabler-icons/blob/6e68709e20ad8878de0332c64fcfb32d24e2b304/icons/outline/fish.svg) |
| D · Simple side-view | [SVG](simple-side-view.svg) | Original body, tail and eye drawing |

The glass's current map identifies its drawings as Feather. No Lucide or Tabler import or dependency was found in the glass directories or lockfile. Upstream SVGs are pinned to the revisions above; full [Lucide](lucide-license.txt) and [Tabler](tabler-license.txt) license notices accompany this demo.

All candidates use a 2px stroke on a 24px grid, matching the glass. No candidate has been chosen. Dispatch screenshots retain the provisional fish; the final dispatch kind waits for Chris's pick.

## Before and after

Playwright CLI only, with fixtures. Desktop: 1440×1000. Phone: 375px wide; the Dispatches capture is 1400px tall so all nine states fit, and Boats is 1000px tall.

| View | Desktop before | Desktop after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| Dispatches | [Before](before-desktop-dispatches.png) | [After](after-desktop-dispatches.png) | [Before](before-mobile-dispatches.png) | [After](after-mobile-dispatches.png) |
| Fish at 16, 20 and 32px | [Before](before-desktop-fish-sizes.png) | [After](after-desktop-fish-sizes.png) | [Before](before-mobile-fish-sizes.png) | [After](after-mobile-fish-sizes.png) |
| Boats | [Before](before-desktop-boats.png) | [After](after-desktop-boats.png) | [Before](before-mobile-boats.png) | [After](after-mobile-boats.png) |

## Validation

Full build and lint pass. Root: 3,920/3,920 tests across 320 files. Wharf: 169/169 tests across 16 files. The reduced branch also passes 163 focused behavior tests. Three formatting fixes inherited from main are retained because the required lint check flags those files; they change no behavior or icons.

Please pick a fish by name (A–D) and approve this smaller set and Boats layout before the ready PR opens.
