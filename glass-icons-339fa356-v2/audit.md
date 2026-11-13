# Dispatch icons and Boats

Queued, limited and unknown dispatch cards gain status icons. The original six dispatch icons stay unchanged. Trap, review, PR, generic-card and wharf-request state icons match main.

| Dispatch state | Before | After |
| --- | --- | --- |
| working | Spinner | Unchanged |
| needs-decision | Raised hand | Unchanged |
| blocked | Stop sign | Unchanged |
| paused | Pause bars | Unchanged |
| done | Check | Unchanged |
| failed | X | Unchanged |
| queued | Text chip | Tray |
| limited | Text chip | Hourglass |
| unknown | Text chip | Question circle |

`unknown` is real: [local glass](https://github.com/aequitas-labs/lobstah/blob/58c2c5e5/apps/cli/src/glass.ts#L373) uses it without a report or claim, and [wharf glass](https://github.com/aequitas-labs/lobstah/blob/58c2c5e5/packages/glass-ui/ui/wharf-snapshot.ts#L55) uses it without a report. `active` is a bucket and gets no new state icon.

## Navigation and Boats

The selected [original simple side-view fish](simple-side-view.svg) appears only in Dispatches navigation, on desktop and phone. Dispatch cards, rows, links, notices and slot chips keep their existing kind presentation.

Boats has aligned permissions and check-in details, actions on their own row, and separate Slack and Account sections. Its statuses are online (radio), asleep (moon) and revoked (slashed circle). The label/value reads “Last check-in: 30s ago”.

Source: [f0d71932](https://github.com/aequitas-labs/lobstah/tree/f0d71932).

## Screenshots

Playwright CLI, fixtures, dark theme. Desktop is 1440×1000. Phone is 375px wide; tall captures show every dispatch state and all Boats sections.

| View | Desktop before | Desktop after | Phone before | Phone after |
| --- | --- | --- | --- | --- |
| Dispatches | [Before](before-desktop-dispatches.png) | [After](after-desktop-dispatches.png) | [Before](before-mobile-dispatches.png) | [After](after-mobile-dispatches.png) |
| Fish at 16, 20 and 32px | [Before](before-desktop-fish-sizes.png) | [After](after-desktop-fish-sizes.png) | [Before](before-mobile-fish-sizes.png) | [After](after-mobile-fish-sizes.png) |
| Boats | [Before](before-desktop-boats.png) | [After](after-desktop-boats.png) | [Before](before-mobile-boats.png) | [After](after-mobile-boats.png) |

[Phone navigation menu](after-mobile-menu.png)

## Validation

Final full build and lint pass. The minimal set passed 3,920 root tests and 169 wharf tests; the final presentation passes all 713 glass tests across 51 files. The report HTTP-test helper now decodes UTF-8 across chunk boundaries, so complete-page comparisons preserve split multi-byte characters. Three formatting-only changes inherited from main satisfy lint.
