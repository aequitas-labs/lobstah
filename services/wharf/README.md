# Wharf — phase 0

An optional coordination authority, separate from telemetry. One person's account
is one SQLite Durable Object; R2 holds evidence files. Briefs, messages, reports
and explicitly uploaded evidence go to the chosen wharf. Checkouts, harness
credentials and local env are not automatically uploaded. Local files remain the default.
This service has not been deployed. There is no domain, sign-in UI, OAuth, billing,
second runtime, socket, alarm or background timer.

## Local development and tests

Use Node 24 and pnpm. `pnpm --filter @lobstah/wharf test` runs in the
Workers runtime with local SQLite and R2. Test credentials are test-only fixtures.
For local HTTP development, supply secrets in ignored `services/wharf/.dev.vars`
and run `pnpm --filter @lobstah/wharf exec wrangler dev --local`.
Never use real PATs in tests or pass secrets in process arguments.

## Settings for a maintainer's eventual deployment

Choose the service address outside the repository. Provision an R2 bucket, replace
the placeholder bucket name in wrangler.jsonc, and use the `v1` SQLite migration.
There are no real Cloudflare account ids or resource ids in the repository.

Two secrets are required:

- `HELM_PAT_HASHES`: JSON mapping each account identifier to an array of SHA-256
  hashes of independently generated, high-entropy personal access tokens. Give the
  plaintext PAT to that person's helm through a secure channel. The operator
  provisions/removes hashes; no public registration API exists in phase 0.
- `TOKEN_SECRET`: a separate high-entropy signing secret for retryable dispatch
  capabilities. Rotating it invalidates reconstruction of an old claim response;
  existing token hashes remain valid until their leases expire.

Keep secrets outside git and logs. Use Cloudflare's secret settings at deployment;
this build requires no login, resource creation or deployment.

Limits are configurable non-secret vars: 120 authenticated requests/minute/account,
10,000 stored rows, 100 MiB account storage, and 25 MiB/file. Limits are abuse caps,
not paid tiers. JSON bodies are bounded at 64 KiB. Rate limits are durable account
windows, not IP identities. Store/R2 failure returns an unavailable error; clients
must retain results and must not infer success or claim locally during an outage.

## Authority and protocol

All routes are under `/v1/accounts/<account>/`, authenticated with a bearer token.
All mutations require `Idempotency-Key` (1–128 identifier characters). Reusing a
key with a different request fails. Keys are scoped to authenticated principals.
Helm mutations require a live helm lease and `X-Lobstah-Helm: <session>`; credential
administration uses the account PAT. A different live helm needs explicit takeover.

| Scope | Route | Operation |
| --- | --- | --- |
| Helm PAT | POST helm/take, helm/renew, helm/release | Exclusive, fenced helm session |
| Helm PAT | POST/GET boats; POST boats/:id/revoke | Issue once, list metadata, revoke |
| Boat | POST workers/sign-on, workers/renew | Bind a logical worker to this boat |
| Boat | POST claims | Atomically claim eligible dispatch; receive agent token |
| Helm | POST/GET dispatches; GET dispatches/:id | Enqueue/follow-up, bounded list/read |
| Helm | POST dispatches/:id/cancel | Cancel, fence the worker |
| Agent | POST dispatches/:id/heartbeat, report | Renew live lease; six report verbs with evidence |
| Agent | POST dispatches/:id/recovery | Preserve stale result; never finalise replacement |
| Helm | POST dispatches/:id/messages | Send an instruction |
| Agent | GET dispatches/:id/messages; POST dispatches/:id/messages/:message/receipt | Read without side effects, then explicitly receipt |
| Agent | POST dispatches/:id/files | Bounded binary upload; X-File-Name header |
| Helm/agent | GET dispatches/:id/files/:file | Authorized download, attachment and nosniff |
| Helm PAT | DELETE account root | Delete rows/files; persistent tombstone prevents recreation |
| Helm | GET events?after=:cursor | Up to 100 wharf-ordered events; returned opaque cursor |

Boat credentials are named, revocable, hashed at rest and shown once. A lost
issuance response is retried for metadata only; revoke/reissue to receive a new
secret. Boats cannot read dispatch content, enqueue, cancel, manage credentials,
take helm or delete accounts. Coding agents receive only the token returned by a
claim, not their boat credential or the PAT. Agent tokens cannot claim.

Claims last 90 seconds and carry a monotonically increasing dispatch epoch.
Renew before expiry. Revocation rejects the next boat request and prevents
agent lease extension, but lets the current agent report until its original
deadline. Addressed work never falls back to a different worker. Each worker can
hold one open catch. Pauses protect ownership until their deadline (default one
day), but do not make an expired execution token valid. Expired work is unknown,
not done; a replacement epoch fences old reports, not external Git pushes.
Recoveries are stored separately for helm reconciliation.

Event cursors are opaque, account-generation scoped and ordered by SQLite sequence,
not client clocks. Polling requests finish immediately; the DO can sleep idle.
Report evidence is data, not hosted executable HTML. No GitHub polling or worker
execution is moved into this service.

Files are immutable by idempotency key and dispatch-scoped, including report
Markdown and images. Downloads force octet-stream, attachment disposition,
nosniff and a sandbox CSP; no cookies, public file URLs or executable report pages.
Reading messages does not mark them received. `done` refuses unreceived messages.

Account deletion serialises with uploads, rejects new requests, deletes every
account-prefixed R2 object and clears coordination rows. A retry resumes cleanup
after an R2 error. Only the hashed deletion-key tombstone remains to prevent a
still-provisioned PAT from recreating deleted data. The operator should remove
that account's PAT hashes. There is no cross-account cleanup or automatic timer.

## Opt-in CLI routing

Configure named wharves and choose one per grounds; omission keeps local files.
Credentials are looked up per wharf, never stored in this TOML:

```toml
[wharves.dev]
url = "http://127.0.0.1:8787"
account = "person"
tokenEnv = "LOBSTAH_DEV_TOKEN"

[grounds.desk]
repos = ["local-repo"]

[grounds.away]
repos = ["remote-repo"]
wharf = "dev"
```

Remote HTTPS is required except for loopback development. The chosen grounds'
repos must also exist in the normal repo configuration. Multiple wharves can be
used simultaneously; no command silently fails over to local state.

With the PAT in the configured environment variable, take the helm using
`lobstah man helm --grounds away --session <id>`, then dispatch/send/cancel with
the same grounds/session. `lobstah wharf issue-machine <name> --grounds away`
issues the trusted launcher's one-time credential. On that machine, set its
credential (not the PAT) in the wharf's token environment variable and use
`lobstah soak --grounds away --worker <id> --repo remote-repo --wait`.
The claimed brief includes the epoch, expiry and dispatch capability.

The trusted launcher must hand **only** that capability to the agent. The core's
`agentEnvironment` removes every named wharf's credentials and installs the
selected dispatch token plus `LOBSTAH_GROUNDS`. Phase 0 exposes claim/renew for a
trusted launcher; it does not move local harness execution or Git worktrees to
the service. Renew with `wharf renew --worker <id>` while execution is alive;
the agent can use `wharf heartbeat <dispatch>` and its post-tool hook.

Agents report with the existing six-verb `report` command. `inbox` reads without
acknowledging; `wharf receipt <dispatch> <message-id>` acknowledges explicitly.
Upload evidence using `wharf upload <dispatch> <file>`, then `report ... --file-id
<id> --pr <url>`. `man wait --after <opaque-cursor>` polls ordered wharf events
and renews its helm lease; keep the returned cursor for the next wait. Use
`--request-key <id>` to retry a mutation without writing twice. Expired results
go through `wharf recover <dispatch> <report.json>`, not a new final report.

The daemon's existing cadence refreshes independent observational wharf caches.
Glass and tend show local and remote work together, labelled by grounds/wharf;
the pet reads the same attention feed. An unreachable wharf shows unknown state
without blocking local work. Wharf grounds reject unsupported local operations
(pools, cull, harness attach, PR watches) rather than mutating local authority.
