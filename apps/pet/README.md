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
`landed`, or nothing for a question or a decision (its title only). Clicking a PR pet (`pr:*`) opens the
PR in your browser instead of the helm; right-click adds **Open PR**.
Clicking a decision pet opens the glass at the decision's card; the card
stays until the decision is answered or withdrawn.
Clicking a report pet opens the glass at the report. Opening a report in
the glass does not acknowledge it. Any pet
click also acknowledges the item (`lobstah attention ack <key> --by pet`),
so that pet stops walking until the item's state changes; right-click
**Acknowledge** does only that. The pet hides a clicked item itself at
once, keyed on its `stateHash` like the glass's clicked lobs, so a slow or
failed ack never leaves it walking. Acks are display-only — the helm is still
woken for every standing question. Each
stops walking once its clear condition holds (docs/vocabulary.md,
"Attention contract").

The pet reads lobstah state: `lobstah attention --json` every six seconds,
plus the helm registration files. `attention --json` prints only the
attention list, with the same items and fields as `man tend --json`. When it
fails (an older CLI does not know `--json` there), the pet runs
`lobstah man tend --json` instead. The pet steers nothing and consumes no
cursor; quieting a pet means answering its question.

The pet reads a child's standard output while the child runs, so output of
any size works. Standard error goes to the null device. A read that takes
more than 10 seconds is stopped (SIGTERM, then SIGKILL); the pet keeps its
current windows and tries again on the next poll.

## Diagnose

- `lobstah doctor` prints a `pet` row: installed or not, running or not, and
  whether the last read worked, with the reason when it did not.
- After three failed reads in a row the pet writes one line with the reason
  (timed out, exited with a status, or output that does not decode) to
  `~/.lobstah/logs/pet.log`. It writes one more line when reads work again,
  and one line naming the command that works.
- `~/.lobstah/pet/state.json` holds the last read's result. It is the pet's
  only write; the CLI writes acknowledgements (`lobstah attention ack`).

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

## Build and test

```bash
cd apps/pet
swift build -c release   # the app
swift test               # LobstahPetCore: runCommand, the attention read, the read monitor
```

`LobstahPetCore` holds the code that runs without a window: child processes
(`execute`, `runCommand`), the attention read and its fallback, and the read
monitor. `LobstahPet` is the app on top of it.

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
