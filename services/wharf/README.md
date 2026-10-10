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

## Permission layers

Person credentials carry `read`, `helm` and `admin`, never `work`: boats fish,
people steer and administer. Worker sign-on, claim and renew refuse a person
credential with an enrolment instruction. The sign-in slice will replace the
temporary operator-provisioned PATs, not expand their work authority.

Boat credentials carry independent permissions, chosen on issue or rotation:

| Permission | Allows |
| --- | --- |
| read | Account job state, messages, events, boats and evidence downloads |
| work | This boat's worker sign-on, claims and renewals |
| helm | Dispatch, message, cancel and exclusive helm lease operations |
| admin | Issue/revoke/rename/remove boats, change permissions, delete account |

Omission defaults to `work`. `POST boats` accepts `permissions`; `POST
boats/:id/permissions` replaces them (an empty array removes all grants).
An `admin` grant additionally requires `confirmAdmin: true`. The CLI uses
repeated `--permission read|work|helm|admin` on `wharf issue-boat <name>` or
`wharf boat-permissions <name>`; `--clear` removes all grants. Admin requires
`--grant-admin` and prints a warning about credential management and deletion.
Permissions do not imply one another: a helm boat also needs `read` for views.

Checks precede idempotency replay, so removing a permission immediately fences
new requests and retries. A helm seat is bound to both the credential principal
and session; knowing its session id cannot inherit it. A boat with helm still
needs explicit takeover of another live seat. Boats cannot select another boat
on sign-on/claim/renew. Agent tokens retain their one dispatch/epoch authority;
revocation or removal of work prevents lease extension but preserves reporting
until the original deadline. No local-files authorization changes.

## Authority and protocol

All routes are under `/v1/accounts/<account>/`, authenticated with a bearer token.
All mutations require `Idempotency-Key` (1–128 identifier characters). Reusing a
key with a different request fails. Keys are scoped to authenticated principals.
Helm mutations require a live helm lease and `X-Lobstah-Helm: <session>`; credential
administration requires `admin`. A different live helm needs explicit takeover.

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
secret. Work-only boats cannot read dispatch content, enqueue, cancel, manage
credentials, take helm or delete accounts. Coding agents receive only the token returned by a
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
the same grounds/session. `lobstah wharf issue-boat <name> --grounds away`
issues the trusted launcher's one-time credential. On that boat, set its
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

## Repository identity and availability

Dispatch and worker sign-on require `repoRemote`, a canonical remote identity
derived by the CLI from the configured checkout's `origin`. The local `repo`
key remains a nickname, not a matching key. HTTPS, SSH and scp forms normalize
to `host/owner/name` (nested namespaces are allowed); host case is folded,
GitHub path case is folded, and other hosts retain path case. Credentials,
query strings and local paths are not accepted. A checkout without a usable
origin refuses before the CLI sends a dispatch or signs on its worker.

Claims match that identity even for addressed work. List and status include
an `unservable` reason when queued work has no eligible fresh worker on an
unrevoked boat. The event cursor records one `unservable` event per transition,
with the remote and reason, rather than repeating it on every poll. Fresh
sign-on clears it; expiry is observed on the next polling request, with no
background timer or connection.

## Stable boats and sticky targets

Boat IDs are account-scoped identities, not credential IDs. Names use letters,
digits, `-` or `_`, at most 64 characters, normalized to lowercase and unique
per account. `wharf issue-boat <name>` creates that boat or rotates its current
credential: its ID, worker repos and addressed work remain intact, while the
previous credential fails on its next request. Retries reveal no credential.

`dispatch --boat <name>` resolves the name through `GET boats` and sends the
optional `boat` ID. Claims require both the remote repo and target boat to
match; a trap address may additionally narrow the target. Neither address
falls back. Revocation leaves queued work on that boat and labels it unservable.
Status and events label the current name, including after a rename.

`wharf revoke-boat <name>` revokes only the credential. `wharf rename-boat
<old-name> <new-name>` preserves the ID. `wharf remove-boat <name> --confirm`
explicitly removes the boat only if no queued/active work is addressed to it
or claimed on it; cancel that work first. Corresponding PAT routes are
`POST boats/:id/rename` and `DELETE boats/:id`, separate from account deletion.
