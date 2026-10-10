# Wharf — phase 0

An optional coordination authority, separate from telemetry. One person's account
is one SQLite Durable Object; R2 holds evidence files. No code, harness credentials,
local env or checkouts are uploaded by the client. Local files remain the default.
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
