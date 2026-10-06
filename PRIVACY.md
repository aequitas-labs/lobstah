# Privacy

Published by aequitas labs LLC. Last updated: 2026-10-07.

## What runs

The Claude Code and Codex plugins provide skills that tell your coding agent
how to run the local `lobstah` CLI. Their hooks run `lobstah hook` commands at
session start, prompt submission, after tool use, turn end and session end.
These commands supply fleet context, remind the helm to use decision cards,
record worker liveness and activity, deliver work and messages, and sign off
workers. Post-tool hooks can also look up a worker's PR through `gh`.
The CLI and daemon coordinate local workers, create Git worktrees and run
coding-agent CLIs or SDKs for assigned work.

## Local data

By default, lobstah stores its configuration and operational data under
`~/.lobstah`; `LOBSTAH_HOME` can select another directory. This includes
dispatch briefs, messages, session and repository identifiers, local paths,
status notes, activity and event logs, PR/watch metadata, decision cards and
answers, reports and supplied attachments, and local catch counts. Headless
event logs can include assistant text. Worktrees contain repository files
and edits; configured repositories can live elsewhere, and Git bookkeeping
is also written in their Git directories.

Credentials come from your existing agent/`gh` setup or configured token
environment variables, files or commands. For headless Codex runs, lobstah
creates `~/.lobstah/codex-home` and links the existing `~/.codex/auth.json`
(or copies it where symlinks are unavailable). Agent tools may keep their
own session files separately. Treat briefs, logs and attachments as
potentially sensitive; activity-summary redaction does not sanitize all
stored content.

Local records remain until removed by cleanup commands or applicable
retention settings. Finished work has no age-based retention cleanup by
default. Finished chore records default to seven days, but their separate
state and logs can remain. Local aggregate catch counts can survive cleanup.

## What can leave your machine

- **GitHub:** PR watches use your `gh` CLI to read PR and review/check
  metadata. Optional GitHub pickup calls `https://api.github.com` using your
  configured token to read issues and PR feedback and write labels, comments
  and, when configured, merges. Comments can contain status notes, activity
  summaries, commit summaries, branch names and PR links. Workers and the
  runner can push commits and create PRs using your Git/`gh` setup.
- **Linear, if configured:** pickup calls `https://api.linear.app/graphql`
  with your token to read issues and comments, update issue states and post
  progress comments, including notes, activity/commit summaries and PR links.
- **Your coding-agent services:** dispatch briefs, messages and attachment
  paths are passed to Claude Code or Codex through their CLIs or SDKs.
  Those agents can read repository files and attachments and send content
  to the providers or services configured for them. Their data handling
  is separate from lobstah's.
- **Destinations you configure:** Git clone/fetch/push contacts your
  repository remotes. Setup, watch/stream, token and notification commands
  can contact other services; notification commands receive dispatch
  identifiers and status notes. Tasks can also instruct agents to use other
  tools or services. Opening external links in the glass or pet contacts
  the linked site through your browser.

The glass serves local state and reports on `127.0.0.1`; its browser requests
go to that local server. The separate telemetry behavior is described below.

## Telemetry

lobstah shares one small, anonymous count of its work once a day. It is **on
by default** and turned off by any one of the switches listed below.

> **Status in this version:** the endpoint is not set, so no version of
> lobstah released so far sends telemetry. `lobstah telemetry status` shows
> `endpoint: (none — this build sends nothing)`. This section describes what
> happens once a release sets the endpoint.

### What is sent

Once per UTC day at most, the lobstah daemon sends one HTTPS `POST` with this
JSON body and nothing else:

```json
{
  "schema": 1,
  "version": "0.6.9",
  "os": "macos",
  "arch": "arm64",
  "installId": "3b0c8f9e-6a1d-4c2e-9f3a-1b2c3d4e5f60",
  "date": "2026-10-06",
  "catches": { "today": 3, "total": 40 },
  "helm": { "harness": "claude", "model": "opus", "config": { "effort": null, "permissionMode": "default" } },
  "traps": [{ "name": "kind-crab", "today": 2, "harness": "codex", "model": "gpt-6.1-sol", "config": { "effort": null, "permissionMode": "default" } }],
  "byWorker": [{ "today": 1, "harness": "claude", "model": "sonnet", "config": { "effort": "high", "permissionMode": "bypassPermissions" } }]
}
```

| Field | What it is |
| ----- | ---------- |
| `schema` | The payload format version, `1`. |
| `version` | The lobstah version. |
| `os` | OS family: `macos`, `linux`, `windows`, or `other`. |
| `arch` | CPU architecture: `x64`, `arm64`, or `other`. |
| `installId` | A random UUID created on this machine the first time it is needed and stored in `~/.lobstah/telemetry.json`. It is not derived from the machine, the user, or any repository. Delete the file to get a new one. |
| `date` | The UTC date of the send. |
| `catches` | `{today, total}`: catches (dispatches that finished `done`) so far on the UTC day and all-time, read from `~/.lobstah/stats.json`. Includes headless catches and traps omitted from the list. |
| `helm` | One live signed-on helm's `{harness, model, config}` snapshot. Null if no live helm or multiple grounds hold live helms (no representative is guessed). No grounds name or session id is sent. |
| `traps` | Up to 100 `{name, today, harness, model, config}` entries for that UTC day, only automatically generated names with recorded provenance and at least one catch. Current session metadata when signed on, otherwise the last catch's snapshot. Sorted by count descending, then name; excess entries are omitted without reducing `catches`. |
| `byWorker` | Headless UTC-day catches grouped by `{harness, model, config}`, with a positive `today` count per combination. Up to 100 combinations; overflow folds into an unknown/null bucket without dropping catches. |

`harness` is `claude`, `codex`, `other`, or null when unknown. Model ids must
match a checked, explicit catalog in `packages/core/src/worker-profile.ts`,
start with a lowercase letter or digit, contain only lowercase letters,
digits, `.`, `_`, or `-`, and be at most 64 characters. A custom or
unrecognised model becomes `other`, even if it looks like a standard id.
No provider prefix, user-typed identifier, account id or API host is copied
through. A missing model observation is null. Both client and server enforce
this boundary.

`config` has exactly two fixed-choice fields, each nullable: `effort`
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`) and
`permissionMode` (`default`, `acceptEdits`, `plan`, `dontAsk`,
`bypassPermissions`, `auto`). Telemetry reads metadata already recorded on
local helm/trap registrations and headless attempt evidence, not a second
session detector. Hooks record supplied model and permission-mode fields
under `~/.lobstah/session-workers` and refresh the registrations; they never
read transcripts or settings files for telemetry. Claude SessionStart can supply
model; Codex's common hook input can supply it on later events too. Neither
documents reasoning effort, so live-session effort stays null. Older hooks
or omitted fields produce null, not an inferred harness default.

Headless workers snapshot resolved model/effort options per attempt, after
cross-harness model filtering. Claude's stream init can refine the model;
Codex's event stream does not expose the resolved model. Unspecified model
or effort defaults stay null. Arbitrary dispatch flags can override options,
so these settings are null when flags are present unless the stream later
observes the model. Claude's fixed headless permission mode is
`bypassPermissions` without overrides; Codex permission mode stays null
(its adapter's approval/sandbox options are not mapped to a hook mode).
Trap day counts carry a session snapshot, not a per-model history of that
trap's individual catches.

Trap names are not always generated: `--name` lets a user choose or change
one. A reservation records whether it was generated automatically from
lobstah's two built-in word lists. Only names with that explicit provenance
are sent. Custom names (even if they look generated), and older names with
unknown provenance, stay local; their catches still count in the totals.
Names are not hashed. Both client and server enforce two lowercase words
of 2–8 letters joined by a hyphen (5–17 characters), positive daily counts,
and the 100-entry cap. The server rejects duplicate names, unknown nested
keys, or a sum of trap and headless counts greater than `catches.today`.

`lobstah telemetry show` prints the exact JSON that would be sent now.

### What is never sent

Repository names or paths, code, briefs, custom or unknown-provenance trap
names, worktree paths, session ids, PR URLs, hostnames, usernames, or any per-dispatch
record, prompts or system prompts, environment values, API hosts, account
or organisation identifiers, or arbitrary config text. The client serialises only the ten fields above, a test fails if
any other key appears, and the server rejects any request with another field.

### When it is sent

- Only by the daemon (`lobstah daemon`), never by a hook or by a command you
  run.
- Only after the first-run notice has been printed on an interactive run of
  `lobstah` in a terminal. The notice is printed once, to stderr:

  ```
  lobstah telemetry: once a day the lobstah daemon sends an anonymous count of
  catches (dispatches finished done): the UTC-day count and the all-time total,
  with the lobstah version, OS family, CPU architecture, the UTC date, and a
  random install id made on this machine. It also sends up to 100 automatically
  generated trap names with recorded provenance and their UTC-day counts.
  It includes the signed-on helm's and traps' harness, known model and fixed-choice
  config (reasoning effort and permission mode), plus headless counts by those
  settings. Missing observations are null; custom/unrecognized models are other.
  Custom names (--name) and older names with unknown provenance stay local;
  their catches still count in the totals. Names are not hashed. It never sends
  repository names or paths, code, briefs, session ids, PR URLs, hostnames or user names.
  See it exactly: lobstah telemetry show. Details: PRIVACY.md.
  Turn it off with any one of: lobstah telemetry disable · [telemetry] share = false
  in ~/.lobstah/config.toml · LOBSTAH_TELEMETRY=0 · DO_NOT_TRACK=1 · CI set.
  ```

- At most one attempt per UTC day, with a 2-second timeout and no retry. A
  network failure is silent and never blocks or fails a command. The next
  attempt is the next UTC day.

### Who receives it, and how long it is kept

The endpoint is a small Cloudflare Worker run by the lobstah maintainers
(aequitas labs LLC). Its source is in this repository at
[`services/telemetry`](services/telemetry). It stores data in Cloudflare D1.
Cloudflare processes the request to serve it.

- **No IP addresses and no request logs are stored.** The Worker writes only
  the validated fields. Workers Logs, invocation logs, and Logpush are
  turned off. Rate limits are keyed on the install id and one global key,
  not on your IP address.
- **Per-install rows** (including the helm snapshot), **per-trap rows**,
  **headless harness/model/config rows**, and the install's attribution
  snapshots expire under the same
  **90-day** rule: the daily job deletes rows dated more than 90 days ago.
- **Daily totals** carry no install id or trap names: for each date, the
  number of installs that reported, the sum of their `catches.today`, and
  how much the installs' `catches.total` grew. A separate daily table keeps
  aggregate catch counts by harness and model only, with no names, install
  ids or config. Omitted traps contribute to an unknown bucket. These totals
  are kept indefinitely. No trap names, linked worker settings or config are
  retained beyond the 90-day expiry pass.

### What it is used for

- A public README badge, `🦞 N`. N is the total catches across every
  install that shares, served as shields.io endpoint JSON at
  `/badge/catches.json`. The badge reveals overall lobstah activity, but not
  who produced it, from which repositories, or what the work was.
- Maintainer totals: catches and active installs per day, plus anonymous
  daily harness/model catch counts, at
  `/v1/stats`, which requires a maintainer token.

The counts are anonymous and self-reported, so they show rough activity and
are not exact. Each install reports separately: one person with two machines
is two installs. An install that stops reporting for more than 90 days and
then starts again is counted as new, so its earlier catches can be counted
twice in the badge total.

### Turning it off

Any one of these turns it off:

| Switch | How |
| ------ | --- |
| Command | `lobstah telemetry disable` (writes the config switch below; `enable` undoes it) |
| Config | `[telemetry]` then `share = false` in `~/.lobstah/config.toml` |
| Environment | `LOBSTAH_TELEMETRY=0` |
| Environment | `DO_NOT_TRACK=1` |
| Environment | `CI` set (any value) |

The daemon usually runs as a launchd or systemd service, which does not
inherit your shell's environment. When any `lobstah` command sees
`LOBSTAH_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI` in its environment, it
records that in `~/.lobstah/telemetry.json`. The daemon then stays off until
a `lobstah` command runs interactively in a terminal without that variable.
Setting the variable in your shell profile is enough to keep it off. To stay
off permanently, use the command or the config switch.

A config file that cannot be read, or a `share` value that is not `true` or
`false`, also counts as off.

`lobstah telemetry status` shows whether sharing is on, every switch in
effect, the endpoint, whether the notice was shown, your install id, and the
date of the last send.

### Local stats

`lobstah stats` reads `~/.lobstah/stats.json`. Its glass and CLI counts use
the local calendar day; telemetry uses a separate UTC-day total and per-trap
table and headless worker buckets in that file. Both survive dispatch culling. On upgrade, new UTC
counters backfill from retained dispatch history; all-time totals are kept.
The telemetry payload is only the bounded, provenance-filtered snapshot
above, not the whole stats file or its worktree ids.

## Contact

For privacy questions or support, use
[GitHub issues](https://github.com/aequitas-labs/lobstah/issues).
Issues are public, so do not include secrets, private code or sensitive logs.
