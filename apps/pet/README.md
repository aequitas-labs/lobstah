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
6. no helm at all → the spyglass (`http://127.0.0.1:4949`, or the port in
   `$LOBSTAH_GLASS_PORT`, which `lobstah glass` honors too)

Every attention kind walks (`attentionKinds` in `config.toml` picks them),
its bubble led by a short label: `draft`, `review`, `checks`, `ready`,
`landed`, or nothing for a question. Clicking a PR pet (`pr:*`) opens the
PR in your browser instead of the helm; right-click adds **Open PR**. Each
stops walking once its clear condition holds (docs/vocabulary.md,
"Attention contract").

The pet only ever reads lobstah state — `lobstah man tend --json` every few
seconds plus the helm registration files. It steers nothing and consumes no
cursor; quieting a pet means answering its question.

## Install

```bash
cd apps/pet && swift build -c release && cd ../..
lobstah pet install        # copies the binary under ~/.lobstah/bin and writes
                           # a login LaunchAgent (RunAtLoad; quitting sticks
                           # until next login). `lobstah pet uninstall` removes it.
```

A locally built binary needs no signing or notarization — Gatekeeper only
gates quarantined downloads. Distributing prebuilt pets through GitHub
releases is what would need a Developer ID signature + notarization.

## Run by hand

```bash
LOBSTAH_PET_PREVIEW=1 apps/pet/.build/release/LobstahPet   # show a pet immediately
LOBSTAH_PET_MENUBAR=1 apps/pet/.build/release/LobstahPet   # with the menu-bar 🦞
```

Right-click the walking lobster for spyglass/quit (and Open PR on a PR pet). Needs `lobstah` on PATH
(the LaunchAgent bakes a resolved PATH in) and macOS 13+. Focusing Terminal
or iTerm windows triggers the one-time macOS Automation permission prompt
the first time a pet is clicked.

## Not yet

Codesigned/notarized distribution through the release binary channel,
per-question focus (all pets currently
lead to the helm), and the `lobstah://` protocol handler that would give
the spyglass real deep links. This is the dogfood cut.
