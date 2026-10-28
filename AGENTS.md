# Working on lobstah

See [CONTRIBUTING.md](CONTRIBUTING.md) for plugin parity and PR evidence.

## PRs

- A PR carries only its change.
- Edit `docs/` only for a new or changed command, flag, config key, file, event, or behavior people rely on. Styling, layout and bug fixes get no doc edits.
- Do not test CSS or computed styles.
- A logic or data fix does not change the glass UI. When an existing renderer can show the result, fill its fields and leave components, layout and styles alone.
- Screenshots never go on a PR branch or `main`.

## UI and art

- The glass, the wharf and the sign-in pages are dark mode only. Use the existing color tokens.
- Write headlines and UI copy in sentence case, with no trailing period.
- The lobster and the star always stay together. Crop around both.
- Use the lobster-with-star logo on a transparent background, never on a filled square.
- The glass header and footer keep the 🦞✨ emoji. Only the pet that runs across the glass, and the macOS pet, use the pixel sprite with its star.

## Releases

- Cut a release only on the owner's explicit go.
- Releases are minors until the hosted wharf goes live. That release is the next major.
