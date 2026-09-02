# OpenClaw integration

Lobstah plugs into an [OpenClaw](https://github.com/openclaw/openclaw) fleet at
two seams: a **gateway plugin** that gives agents typed dispatch tools, and the
**pickup loops** that replace hand-rolled tracker polling scripts. Core knows
about neither — both just write the same descriptors into the same directory.

## Install the plugin

On the gateway host (which should also run `lobstah daemon`):

```bash
git clone https://github.com/aequitas-labs/lobstah
cd lobstah && pnpm install && pnpm build
openclaw plugins install ./apps/node
```

Once lobstah is on npm, this becomes a one-liner with no clone:

```bash
openclaw plugins install lobstah-openclaw-plugin
```

## What agents get

Four tools, registered for every fleet agent:

| Tool | Does |
|---|---|
| `lobstah_dispatch` | Queue a supervised dispatch (repo key, brief, optional harness/model/followUp) — returns the id |
| `lobstah_status` | Reconciled state of one dispatch or a table of everything active |
| `lobstah_send` | Drop an instruction into a running dispatch's inbox |
| `lobstah_cancel` | Request cancellation |

Operators get `/lobstah [id]` as a chat command — status without waking a model.

An agent asked in chat to "fix the flaky login test in myapp" hands the work
to lobstah and stays responsive. Later it answers "how's it going?" from
`lobstah_status`. The daemon does the actual supervision the whole time, for
zero tokens.

## Replacing scheduler scripts with pickup

A typical fleet setup polls the tracker from cron/launchd scripts, dispatches
a headless agent, re-arms check-ins, and merges approved PRs from more
scripts. `lobstah pick` replaces that whole layer with one process — see
[pickup.md](pickup.md) for the loops and [the config](pickup.md#dispatch-loop).

The division of labor that falls out:

- **Pickup** owns issue/review dispatch, tracker status comments, drift
  reconciliation, and (opt-in) merges.
- **The daemon** owns worktrees, liveness, wedge detection, restarts.
- **Fleet agents** keep the judgment work: triage, escalation policy,
  answering humans — and reach lobstah through the plugin tools when a request
  becomes a dispatch.
- **Notifications** ride `notifyCommand` — point it at your existing Slack
  helper; lobstah stays vendor-free.

Token minting for GitHub Apps fits the `tokenCommand` source directly
(installation tokens expire hourly):

```toml
[pickup.github]
tokenCommand = "gh-app-token.sh my-app"
```

## Keeping both alive

Two long-running commands on the host, under whatever supervises processes
there already (launchd on macOS, systemd on Linux):

```
lobstah daemon      # supervisor — holds no credentials
lobstah pick        # tracker loops — holds the tokens
```
