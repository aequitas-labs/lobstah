# Privacy

Published by aequitas labs LLC. Last updated: 2026-10-10.

## Local work and connections

lobstah's plugin hooks and skills run its local CLI to coordinate coding
agents. Configuration, task material and operational records are stored
locally, normally under `~/.lobstah`. Logs and attachments can contain
sensitive content.

lobstah contacts your configured code host and optional issue tracker to
coordinate work. Git operations, coding agents, commands and tools you
configure or ask workers to use can contact other services and send task
material. Those services have their own data-handling policies.

## Optional wharf

Local files are the default. If you choose a wharf, your selected server
stores coordination material: task briefs, messages, decisions, reports and
files you upload, along with repo identities, boat and worker metadata and
authentication records. GitHub sign-in contacts GitHub; the wharf uses
Cloudflare storage. Coding agents and Git worktrees still run on your boats.

Each account is one person's grounds. The signed-in person and credentials
granted read or steering access can read account state through the API;
worker tokens access only their assigned catch. The server operator and
hosting provider also handle this stored data. Upload only material you
intend to store there. Access controls do not make it anonymous telemetry.

Operational data is kept until account deletion, subject to storage limits;
there is no automatic retention deadline. Account deletion removes task
records, uploaded files and the account's sign-in identity and sessions. A
minimal hashed receipt remains
to make retries safe and prevent old credentials reopening the account.
Revoking a boat stops its credential; logging out removes the local login,
not the server's work. See the [wharf source and setup](services/wharf).

## Usage statistics

lobstah can send anonymous, aggregate usage statistics to its maintainers:
counts of completed work, automatically generated worker labels, the kinds
of harness and model configurations used, and version and platform
information. These statistics are tied to a random installation identifier,
not your identity.

Telemetry never sends code, prompts, file contents, file paths, repository
names, user-chosen names, credentials or account identifiers.

Sharing is on by default. We use telemetry to understand lobstah's usage;
we do not sell it or share it for advertising. Installation-linked data is
kept for a limited period. After that, only aggregate counts remain, without
installation identifiers or worker labels.

Run `lobstah telemetry show` to see the exact current contents. The
[client](packages/core/src/telemetry.ts) and
[service source](services/telemetry/src/index.ts) describe the current
collection, controls and retention.

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
