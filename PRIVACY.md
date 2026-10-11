# Privacy

Published by aequitas labs LLC. Last updated: 2026-10-13.

## Local work and connections

lobstah's plugin hooks and skills run its local CLI to coordinate coding
agents. Configuration, task material and operational records are stored
locally, normally under `~/.lobstah`. Logs and attachments can contain
sensitive content.

lobstah contacts your configured code host and optional issue tracker to
coordinate work. Git operations, coding agents, commands and tools you
configure or ask workers to use can contact other services and send task
material. Those services have their own data-handling policies.

## Usage statistics

lobstah can send anonymous, aggregate usage statistics to its maintainers:
counts of completed work, automatically generated worker labels, the kinds
of harness and model configurations used, and version and platform
information. They also describe, in small count ranges and fixed choices,
boats and local or wharf grounds, boat access, and whether completed work
had a live helm. Unobserved history stays unknown. These statistics are tied
to a random installation identifier, not your identity or wharf account.
Signing in does not link the two. A self-hosted wharf receives no telemetry.

Telemetry never sends code, prompts, file contents, file paths, repository
names, user-chosen names, credentials or account identifiers.
It never sends boat identifiers, wharf addresses, grounds names or times
finer than the UTC date. Telemetry uses its own daily schedule and connection,
without wharf credentials or cookies.

Sharing is on by default. We use telemetry to understand lobstah's usage;
we do not sell it or share it for advertising. Installation-linked data is
kept for a limited period. After that, only aggregate counts remain, without
installation identifiers or worker labels.

Aggregate counts are public. Installation identifiers and worker labels are
not published.

Run `lobstah telemetry show` to see the exact current contents. The
[client](packages/core/src/telemetry.ts) and
[service source](services/telemetry/src/index.ts) describe the current
collection, controls and retention.

## What a wharf holds

Local files remain the default. If you use a wharf, that separate service
holds your account, boats, dispatches, messages and files so your machines
can coordinate work. Task material can be sensitive. Account deletion
removes that work and its files; a minimal hashed deletion receipt remains
to make retries safe. Signing out or revoking a boat does not delete the
account's work. The wharf is operational storage, not anonymous telemetry.

## Your choices

Stop sending with `lobstah telemetry disable`. Configuration and environment
opt-outs are also available; `lobstah telemetry status` shows the controls in
effect, and `lobstah telemetry --help` explains them.

To reset the installation identifier, disable sharing, then delete the local
`telemetry.json` file in your lobstah data directory. A new identifier is
created when needed. This does not erase statistics already received.
There is no telemetry deletion API because these statistics are not linked
to a person. This is separate from wharf account deletion above.

## Questions

Contact us through [GitHub issues](https://github.com/aequitas-labs/lobstah/issues).
Issues are public; do not include secrets or sensitive task material.
