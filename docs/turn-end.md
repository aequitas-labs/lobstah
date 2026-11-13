# The turn-end contract

A harness starts every Stop hook together and continues the session only
when all of them have returned. Two tools whose Stop hooks each wait for
their own news hold each other up, for hours. Codex measured this on
5 November 2026. A background command doesn't help in Codex either: one
that finishes after the turn ends starts no new turn.

So one tool owns a session's turn end. Every other tool that would wait
there registers a wait for the owner to run instead. Neither tool names the
other. In a lobstah trap, lobstah's park is the owner.

## The files

```
~/.agent-turn/<session>/owner.json       the owner
~/.agent-turn/<session>/waits/<n>.json   one registration per waiting tool
```

`<session>` is the harness's session id, which every hook gets in its
input (`session_id`). `AGENT_TURN_HOME` moves the folder.

`owner.json`:

```json
{ "owner": "lobstah", "since": "2026-11-12T07:00:00Z", "cwd": "/path/to/worktree", "waits": "/Users/me/.agent-turn/<session>/waits" }
```

A registration, written into `waits` (one file per tool, any name ending in
`.json`):

```json
{ "from": "ume", "wait": "ume await a1 --since {cursor} --turn-line", "read": "ume feedback a1", "cursor": "30" }
```

| Field | Meaning |
| --- | --- |
| `from` | The tool's name: lower-case letters, digits, `.`, `_`, `-`. |
| `wait` | A command that blocks until there is something new, prints one JSON line, and exits. |
| `read` | What the agent runs to see what's new. |
| `cwd` | Where to run `wait`. Optional; the owner's `cwd` otherwise. |
| `cursor` | Where `{cursor}` starts. Optional. |

`wait` prints `{ "cursor": "<next>", "summary": "<one line>" }` and exits 0.
With nothing new by its own deadline, it prints nothing and exits 0 or 2.
Any other exit is an error, with the reason on stderr. The owner
replaces `{cursor}` in the command with the last cursor it printed (the
registration's `cursor` the first time), quoted for the shell. `wait` must
not move what `read` shows the agent: the agent reads it later.

## The rules

1. **One owner per session.** The tool that holds the turn end writes
   `owner.json`. A session another tool already owns stays theirs.
2. **Everyone else registers a wait instead of waiting.** A Stop hook that
   would wait first reads `owner.json`. If another tool owns the turn end,
   it writes its registration into `waits` and returns at once. With no
   owner, it behaves as it always has.
3. **The owner runs the waits.** When a wait prints, the owner wakes the
   session with a pointer to `read`, never the content.

## What lobstah does as the owner

- A trap's sign-on writes `owner.json` for its session; stow and a ghost
  sweep remove it. Registrations stay, so a wait for a trap that went away
  still runs.
- The daemon keeps one record per registration in
  `~/.lobstah/turn-waits/`, tied to the trap and the dispatch it worked when
  the wait registered, and runs each `wait` as one child process at a time.
- When a wait prints, a live trap gets the pointer in its dispatch's inbox
  (its own inbox between dispatches), which wakes its park: "ume has
  something new: Chris picked an option. Run `ume feedback a1` to see it."
  A trap that's gone gets a continuation of its dispatch, one at a time.
- A pointer still unread after 15 minutes raises one `trap-not-receiving`
  notice to the helm: the trap has stopped receiving.
- A wait that ends without printing, with exit 0 or 2, timed out quietly
  and runs again. Any other exit code is a failure, however long the wait
  ran: it retries after 5 s, doubling to at most 5 minutes, and the record
  keeps its last stderr line for doctor.
- A record ends when its registration file is removed while the trap is
  live, or when its dispatch finishes.

## Doctor

`lobstah doctor` has a `turn waits` row. It names no tool:

- It lists every Stop hook a harness loads that isn't lobstah's: from Claude
  Code's `settings.json` and its other enabled plugins, and from Codex's
  `hooks.json` and its other enabled plugins (the newest cached version),
  each with its timeout.
- A Stop hook longer than 60 seconds, or with no timeout, whose program has
  never registered a wait with a trap makes the row `warn`: in a trap it may
  hold the turn end beside lobstah's park. The program is the command's
  first word, matched against the `from` of every registration lobstah has
  seen (`~/.lobstah/turn-waits/tools.seen`).
- It shows each wait lobstah runs, and makes the row `warn` when one has
  failed three times in a row.

It only reports and changes nothing.
