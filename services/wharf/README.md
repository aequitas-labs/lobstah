# Wharf — phase 0

An optional coordination authority, separate from telemetry. One person's account
is one SQLite Durable Object; R2 holds evidence files. Briefs, messages, reports
and explicitly uploaded evidence go to the chosen wharf. Checkouts, harness
credentials and local env are not automatically uploaded. Local files remain the default.
This service has not been deployed. GitHub admission and boat approval APIs are
implemented; the hosted glass UI follows in the next slice. There is no domain,
billing, second runtime, socket, alarm or background timer.

## Local development and tests

Use Node 24 and pnpm. `pnpm --filter @lobstah/wharf test` runs in the
Workers runtime with local SQLite and R2. Test credentials are test-only fixtures.
For local HTTP development, supply secrets in ignored `services/wharf/.dev.vars`
and run `pnpm --filter @lobstah/wharf exec wrangler dev --local`.
Never use real credentials in tests or pass secrets in process arguments.

## Settings for a maintainer's eventual deployment

Choose the service address outside the repository. Provision an R2 bucket, replace
the placeholder bucket name in wrangler.jsonc, and use the `v1` SQLite migration.
Provision a separate D1 database for authentication, replace its placeholder ID,
and apply `migrations/0001_auth.sql`. Coordination still uses the account's SQLite
Durable Object; core does not import this service or Better Auth.
There are no real Cloudflare account ids or resource ids in the repository.

Three secrets are required:

- `AUTH_SECRET`: a high-entropy Better Auth signing/encryption secret (at least
  32 characters). GitHub provider tokens are encrypted at rest in D1.
- `GITHUB_CLIENT_SECRET`: the GitHub OAuth application's secret. Configure its
  callback to `<GLASS_ORIGIN>/api/auth/callback/github`.
- `TOKEN_SECRET`: a separate high-entropy signing secret for retryable dispatch
  capabilities. Rotating it invalidates reconstruction of an old claim response;
  existing token hashes remain valid until their leases expire.

Keep secrets outside git and logs. Use Cloudflare's secret settings at deployment;
this build requires no login, resource creation or deployment.

Set `GLASS_ORIGIN` and `API_ORIGIN` to distinct exact HTTPS origins (loopback HTTP
is allowed for local tests), `GITHUB_CLIENT_ID` to the OAuth application's public
ID, and `GITHUB_ALLOWLIST` to a JSON array of stable numeric GitHub account IDs,
represented as strings. Admission never matches a mutable login or email.
Non-invited sign-ins are refused before storing/linking a person; every existing
person session and device redemption rechecks admission. Each random auth user
ID owns exactly one account. There is no team or account selector in authentication.

Better Auth is pinned to **1.7.6**, published 2026-09-24, more than two weeks before
this choice. Its GitHub provider, native D1 store and device-code state machine
are tested in the Workers runtime with a stubbed provider, including the committed
migration. The custom grant uses the library's one-time consumption/expiry/polling
checks but issues only a boat capability, never a person session, to the CLI.
Browser cookies are secure, HttpOnly and host-only on the glass. The API rejects
cookies, takes bearer tokens, refuses redirects and accepts exactly the configured
glass origin. No unrelated Better Auth mutation endpoints are exposed.
The configured plugins are bearer and device authorization only: no Magic Link
or OAuth Proxy. The September 30 advisories for 1.7.6 require those absent
plugins; their routes are also refused by the HTTP allowlist. The device client/
scope approval fix predates this pin. Recheck upstream advisories before deployment;
this narrow configuration is not a claim that every 1.7.6 plugin is safe.

`lobstah wharf login --grounds <grounds> [--name <boat>] [--helm|--work-only]`
prints a browser approval URL/code and stores only that wharf's boat credential
under `~/.lobstah/credentials/`, with owner-only file permissions where supported.
Normal login requests work plus read; the browser approves as requested, lowers
access, or refuses. The default boat name is the cleaned short system name (or
hostname), never a random name. `--name` overrides it; re-login keeps the existing
name unless overridden. Account-local collisions gain a numeric suffix shown
before approval. A collision arising after approval refuses redemption rather
than silently changing the approved name. Boat names stay within the wharf account
and are not telemetry. Re-login proves the current boat credential before changing
its name/access and preserves its stable ID; a fresh request cannot steal an
existing name. No separate enrol command, person token store or admin request.
`login --credential-file <file>` (or `-` for stdin) imports an existing boat token
after checking it; it does not change access. `wharf logout` removes the local
credential only; invalidate it with revoke on the signed-in boat list. Explicit
token environment variables still take precedence; unset a legacy variable to
use the saved login. Job subprocesses get only their dispatch token and do not
fall back to stored boats. The glass UI/approval page follows next; these APIs
are currently exercised by local tests.

Limits are configurable non-secret vars: 120 authenticated requests/minute/account,
10,000 stored rows, 100 MiB account storage, and 25 MiB/file. Limits are abuse caps,
not paid tiers. JSON bodies are bounded at 64 KiB. Rate limits are durable account
windows, not IP identities. Store/R2 failure returns an unavailable error; clients
must retain results and must not infer success or claim locally during an outage.

## Permission layers

Person credentials carry the `admin` steering layer, never `work`: boats fish,
people steer and administer. Worker sign-on, claim and renew refuse a person
credential with an enrolment instruction. GitHub-backed browser sessions replace
the temporary operator-provisioned PATs without expanding their work authority.

Boat credentials carry a steering layer (`read < helm < admin`) and independent
`work` permission, chosen on issue or rotation:

| Permission | Allows |
| --- | --- |
| read | Account job state, messages, events, boats and evidence downloads |
| work | This boat's worker sign-on, claims and renewals |
| helm | Read plus dispatch, message, cancel and exclusive helm lease operations |
| admin | Helm plus approved boat enrollment, revoke boats, delete account |

Omission defaults to `work` plus `read`. The public operator `POST boats` route
is removed; only the approved device grant drives the private issuer.
An `admin` grant requires explicit confirmation in the model and is never requested
by CLI login. The signed-in glass
lists boats and permits revocation only, plus confirmed account deletion on that
same page. Boat name and access change only through login on that boat, approved
as requested, with less access, or refused. There are no grant/rename/edit controls
or separate boat-removal route, and no CLI admin commands. The CLI
acts only as its current boat; `wharf whoami` shows its own name and grants, even
for a work-only boat. A machine's login will store only its boat credential, never
a person session. Normal device approval requests work plus read; `--helm` requests
work plus helm, and `--work-only` requests only work. Admin is not requestable from
the CLI. Credential import is via stdin/file, not a process argument.
Only the highest steering layer is stored, not its implied permissions. Replacing
`helm` with no steering layer removes read access too; explicitly selecting `read`
is a downgrade. `work` never implies read or steering authority.

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
| Person/helm boat | POST helm/take, helm/renew, helm/release | Exclusive, fenced helm session |
| Person admin | GET boats; POST boats/:id/revoke | List metadata, revoke |
| Boat | POST workers/sign-on, workers/renew | Bind a logical worker to this boat |
| Boat | POST claims | Atomically claim eligible dispatch; receive agent token |
| Helm | POST/GET dispatches; GET dispatches/:id | Enqueue/follow-up, bounded list/read |
| Helm | POST dispatches/:id/cancel | Cancel, fence the worker |
| Signed-in person | POST dispatches/:id/cancel | Owner emergency stop, fences epoch without taking a helm seat |
| Agent | POST dispatches/:id/heartbeat, report | Renew live lease; six report verbs with evidence |
| Agent | POST dispatches/:id/recovery | Preserve stale result; never finalise replacement |
| Helm | POST dispatches/:id/messages | Send an instruction |
| Agent | GET dispatches/:id/messages; POST dispatches/:id/messages/:message/receipt | Read without side effects, then explicitly receipt |
| Agent | POST dispatches/:id/files | Bounded binary upload; X-File-Name header |
| Helm/agent | GET dispatches/:id/files/:file | Authorized download, attachment and nosniff |
| Person admin | DELETE account root | Delete rows/files and auth identity; same-key retry receipt and tombstone |
| Helm | GET events?after=:cursor | Up to 100 wharf-ordered events; returned opaque cursor |
| Read | GET glass, workers, dispatches/:id/detail | Boat/trap metadata, jobs, status history, messages and file metadata |
| Leased helm | POST documents; POST documents/:id/files, publish, withdraw | Author decisions and Markdown reports with scoped uploads |
| Read | GET documents, documents/:id, documents/:id/files/:file | Published documents and their own uploaded bytes |
| Signed-in person | POST documents/:id/answer | Record one card answer and ordered event; no helm-seat change |
| Signed-in person | POST requests | Queue a bounded message or trap-start request for the helm |
| Read / leased helm | GET requests; POST requests/:id/receipt, execute | Explicit receipt then execute a live message request |

Boat credentials are named, revocable, hashed at rest and shown once. A lost
issuance response is retried for metadata only; approve another login to receive a new
secret. Work-only boats cannot read dispatch content, enqueue, cancel, manage
credentials, take helm or delete accounts. Coding agents receive only the token returned by a
claim, not their boat credential or a person session. Agent tokens cannot claim.

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

Files are immutable by idempotency key and dispatch- or document-scoped, including report
Markdown and images. Downloads force octet-stream, attachment disposition,
nosniff and a sandbox CSP; no cookies, public file URLs or executable report pages.
Reading messages does not mark them received. `done` refuses unreceived messages.

The signed-in person never takes the helm seat merely by using the glass. Card
answers are durable events. Send and trap-start actions queue account-local human
requests for the live helm to read and explicitly receipt. Without a helm, they
show `waitingForHelm`; queued/received requests expire visibly after ten minutes
on the next poll and cannot execute late. Only owner cancellation directly acts
on a job without a seat: it fences the claim epoch and records the person actor.
Trap-start fulfillment follows in the opted-in boat slice; this slice never launches
a process. No new server timers or polling loops.

`man ask --title ... --option ... [--detail file.md] [--attach file]`,
`man file report.md [--attach file]`, worker `report ... --report file.md
[--attach file]`, and `man tend` now use the selected wharf grounds. Authoring
uses the existing helm session flag; workers upload with their dispatch token.
The CLI sends file bytes and basenames, never local paths. Use `--request-key`
to retry a multi-step upload/publish with stable bounded keys.

Account deletion serialises with uploads, rejects new requests, deletes every
account-prefixed R2 object and clears coordination rows. A retry resumes cleanup
after an R2 error. Only a minimal hashed deletion-key receipt/tombstone remains
for the same retry; the person's sessions, GitHub identity and pending device
codes are removed too. Old boat and dispatch credentials cannot recreate that
account. There is no cross-account cleanup or automatic timer.

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

On the boat, use `lobstah wharf login --grounds away --helm` and approve in the
signed-in browser (or import an existing boat credential from a file). Take the
helm using `lobstah man helm --grounds away --session <id>`, then dispatch/send/
cancel with the same grounds/session. To fish instead, log in with work access
and use
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
per account. `wharf login` creates a boat or rotates its current
credential after approval: its ID, worker repos and addressed work remain intact, while the
previous credential fails on its next request. Retries reveal no credential.

`dispatch --boat <name>` resolves the name through `GET boats` and sends the
optional `boat` ID. Claims require both the remote repo and target boat to
match; a trap address may additionally narrow the target. Neither address
falls back. Revocation leaves queued work on that boat and labels it unservable.
Status and events label the current name, including after a rename.

The signed-in boat list's revoke action invalidates the credential and is the
only boat-removal action. Stable IDs and sticky addressed work remain recorded;
revocation never silently reassigns that work. Renaming or changing access requires
approved login from the boat; no public grant-editing or rename API exists.

## Browser glass

`pnpm --filter @lobstah/wharf build` bundles the existing glass stylesheet and
shared safe Markdown elements into the Worker. The configured glass host serves
`/` and `/device`; no separately hosted assets or hardcoded domain are needed.
Sign in with invited GitHub credentials, then use `/device` to inspect a CLI
approval code and approve the displayed boat with the same or lower access, or
refuse it. No boat or dispatch token is issued to the page.

The browser uses same-origin, cookie-only `/api/glass` routes. Account identity
comes from that cookie, never a URL selector. Writes require the exact configured
Origin and an idempotency key. These routes cannot take/renew the helm seat,
author documents, directly send a worker message or grant/edit a boat. Message
and trap-start requests wait for the leased helm, with a visible ten-minute
expiry; answers emit decision-answer events. Owner cancellation fences a job
immediately without touching the helm seat. Revoke and account deletion require
separate in-page confirmations on the boat list.

Snapshots poll every fifteen seconds. Missing check-ins or a failed feed are
unknown, not completion. Remote sessions show their boat and a validated command
to copy, never a pretend focus-window action. Markdown is rendered as elements;
raw HTML stays text. Inline raster images resolve only through the document's
own uploaded attachments; SVG/HTML files remain downloads with `nosniff`.
