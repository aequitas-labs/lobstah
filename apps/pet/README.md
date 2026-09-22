# Lobstah Pet 🦞

Attention questions crawl across your desktop.

While a dispatch stands at `needs-decision` or `blocked`, a pixel lobster
walks along the bottom of the screen — one per question, up to four — each
carrying a star speech bubble with the question. Clicking a pet takes you
to the helm through the focus ladder:

1. exact iTerm2 pane (from the `ITERM_SESSION_ID` the helm recorded)
2. exact Terminal.app tab (matched by the recorded tty)
3. exact VS Code / Cursor window (`open -b <bundle> <cwd>`)
4. the recorded app, by bundle id
5. a stale helm revives instead: fresh Terminal window running
   `claude --resume <session>` (or `codex resume`) in the helm's cwd
6. no helm at all → the spyglass (`http://127.0.0.1:4949`)

The pet only ever reads lobstah state — `lobstah man tend --json` every few
seconds plus the helm registration files. It steers nothing and consumes no
cursor; quieting a pet means answering its question.

## Run

```bash
cd apps/pet
swift build -c release
.build/release/LobstahPet            # menu-bar 🦞: preview toggle, spyglass, quit
LOBSTAH_PET_PREVIEW=1 .build/release/LobstahPet   # show a pet immediately
```

Needs `lobstah` on PATH and macOS 13+. Focusing Terminal or iTerm windows
triggers the one-time macOS Automation permission prompt the first time a
pet is clicked.

## Not yet

Codesigned/notarized distribution through the release binary channel, a
`lobstah pet install` LaunchAgent, per-question focus (all pets currently
lead to the helm), and the `lobstah://` protocol handler that would give
the spyglass real deep links. This is the dogfood cut.
