# lobstah telemetry Worker

A small Cloudflare Worker that receives lobstah's anonymous daily counts
([PRIVACY.md](../../PRIVACY.md)) and serves public aggregate stats and badges.
**Deployed at `https://t.lobstah.dev`.** The receiver has no CLI submissions:
the endpoint constant (`TELEMETRY_ENDPOINT` in `packages/core/src/telemetry.ts`)
is still empty, so no lobstah build sends anything.

## Routes

| Route | What it does |
| ----- | ------------ |
| `POST /v1/daily` | Accepts one payload (`application/json`, ≤ 64 KiB). Schema stays `1`: exactly `schema`, `version`, `os`, `arch`, `installId`, `date`, `catches`, `helm`, `traps`, `byWorker`. Worker metadata is `{harness, model, config: {effort, permissionMode}}`: enums/catalog-only identifiers (64 characters max), or null. At most 100 distinct generated trap names and 100 headless settings buckets. Trap names are two lowercase words of 2–8 letters joined by a hyphen; all counts are positive and their sum cannot exceed `catches.today`. Unknown keys at any level are refused with 400. Upserts by install id + UTC date, so a retry never double-counts. 204 on success, 429 when rate-limited. |
| `GET /badge/catches.json` | shields.io endpoint JSON: `{"schemaVersion":1,"label":"🦞","message":"N",...}`, where N is the catches across every sharing install. Use `https://img.shields.io/endpoint?url=<host>/badge/catches.json`. |
| `GET /badge/boats.json` | shields.io endpoint JSON, label `boats (30d)`: distinct installs that submitted in the last 30 UTC days. |
| `GET /badge/traps.json` | shields.io endpoint JSON, label `traps (30d)`: distinct (install, generated trap name) pairs reported in the last 30 UTC days. |
| `GET /v1/stats?days=30` | Public; no authentication. Returns `totalCatches`, `activeBoats`, `activeTraps`, `activeDays: 30`, `retentionDays: 90` and, per day, `activeInstalls`, `catchesToday`, and `newCatches`, plus daily `byWorker` harness/model counts. No installation-linked rows, identifiers, trap names or config are returned. `days` selects the daily history (1–3660), not the active-count window. |

Active counts include today and the previous 29 UTC dates. Tomorrow's
clock-skew submissions are excluded until that date. A boat submitting zero
catches is still active; traps appear only when reported with positive daily
catches. The bounded trap list is not a census of every configured trap.

## Storage: D1, not Analytics Engine

D1 is SQLite, so the Worker can **upsert by install id + date**. That makes
submissions idempotent, and it lets the Worker count only the increase in an
install's `catches.today` for that UTC date. It can also
**delete rows on a schedule** for the 90-day retention.

Analytics Engine fits high-volume event streams, not this. Its writes are
append-only (a retry would count twice), its queries are sampled, and it has
a fixed retention we cannot shorten or extend per table, so it cannot keep
daily totals after the per-install data is gone.

Tables (`migrations/0001_init.sql`):

- `submissions`: one row per install per UTC date, holding the payload fields
  only. There is no IP address, user agent, or request metadata column.
- `trap_submissions`: up to 100 generated names and positive UTC-day counts
  per install and date. The client sends only names whose automatic
  reservation has recorded provenance; `--name` and older unknown-provenance
  names stay local without hashing. Their catches, and headless catches,
  still count in `catches`, so totals are not derived from the trap list.
- `daily_totals`: one row per date, with no install id or trap names: `active_installs`,
  `catches_today` and `new_catches` (both the sum of daily high-water counts).
  The catches badge is `SUM(new_catches)`, never lifetime client totals.
- `worker_submissions`: headless counts per install/date and harness/model/config.
- `attribution_submissions`: bounded per-install/date harness/model contributions,
  used to replace a retry or corrected snapshot atomically without double-counting.
- `daily_worker_totals`: indefinite counts by date/harness/model only, with no
  names, install ids or config. Omitted trap metadata contributes to null/null.

`catches.total` is still accepted and stored for released-client compatibility.
It is validated as an integer of at most 10,000,000 and at least
`catches.today`, but never contributes to a badge or aggregate. The daily cap
stays 10,000 per install/date; repeats add only an increase in that day's
count. A fresh installation id cannot import its lifetime total.

`0002_daily_catches.sql` rebases `new_catches` onto `catches_today` in existing
aggregate rows and adds date indexes for the active-count queries. It creates
no identity registry and no lifetime boat/trap counters.

## Retention

A daily cron (`17 3 * * *`) deletes `submissions`, `trap_submissions`,
`worker_submissions` and `attribution_submissions` rows whose date is more than
**90 days** old (`RETENTION_DAYS`). `daily_totals` and `daily_worker_totals` carry no install id, name or config
and are kept. Because they are updated on every submission, deleting
per-install rows never changes a total.

An install returning after more than 90 days adds only its new UTC day's
catches, not its lifetime total. Boats and traps are rolling active counts,
not lifetime distinct counts; they disappear from the badges after 30 days
without a qualifying submission. No identifier or name is retained longer
than the existing 90-day rule.

## No logs, no IPs

`wrangler.jsonc` turns off Workers Logs, invocation logs, and Logpush. The
Worker never reads `CF-Connecting-IP` or `request.cf`, never calls
`console.*`, and returns no error detail. Both rate limiters (Workers Rate
Limiting bindings) key on non-IP values: `SUBMIT_LIMITER` on the install id
(10/min) and `GLOBAL_LIMITER` on one global key (1000/min per location). A
test checks the config and source for each of these.

## Tests

`pnpm test` runs `test/worker.test.ts`. Validation tests run everywhere. The
storage tests run the real SQL against `node:sqlite` as a stand-in for D1,
and skip on Node versions without it (before 22.5). CI runs these again on
Node 24 on Ubuntu and Windows so the SQL is tested on both. `pnpm lint` typechecks
the Worker.

## Deployment (aequitas labs)

Chris approved the initial deployment directly. Version
`f2e14ef8-c4ea-4750-aece-714c08291da4` was deployed at
`2026-10-14T04:16:01.879Z`. Outside checks returned 200 with zero counts for
all three badges and public `/v1/stats`; posting `{}` to `/v1/daily` returned 400. No valid daily test payload was sent to production.

Use the **aequitas labs** account (`73dd625ed4d46d151a0de5624ff71379`). This
machine's separate Wrangler sign-in is selected by
`XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare"` on **every** Wrangler
command; omitting it selects a different company's account. Do not log in or
log out, or inspect the saved credentials. Confirm the account first.

The database `lobstah-telemetry` is already created (ENAM):
`fb7a04cd-d62a-414d-b990-84fbe5593de0`. Migrations `0001_init.sql` and
`0002_daily_catches.sql` are applied.
Do not create another database. Rate limiter namespaces `1531` and `1532`
are account-local positive integers reserved for this receiver, not resource
ids. Logs, invocation logs and Logpush stay off. No secret is required.

From the repository root:

```sh
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.150.0 whoami
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.150.0 d1 migrations apply lobstah-telemetry --remote --config services/telemetry/wrangler.jsonc
# Only after explicit deployment approval:
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.150.0 deploy --config services/telemetry/wrangler.jsonc
```

The config attaches only `t.lobstah.dev` as a custom domain; workers.dev and
preview URLs are disabled. No other DNS or zone settings should change.
After deployment check all three badges return zero, `/v1/stats` returns only
zero aggregates without a token, and `POST /v1/daily` with `{}` returns 400.
Never submit a valid test payload to the production database.

For a later code rollback, choose a known-good version from
`wrangler deployments list`, then run (with the same account selector):

```sh
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.150.0 deployments list --config services/telemetry/wrangler.jsonc
XDG_CONFIG_HOME="$HOME/.config/lobstah-cloudflare" WRANGLER_SEND_METRICS=false npx --yes wrangler@4.150.0 rollback <known-good-version-id> --config services/telemetry/wrangler.jsonc
```

Rollback does not revert D1 migrations or routing. On the first deployment
there is no previous version: to take the receiver offline, remove only its
`t.lobstah.dev` route from this config and redeploy with the same account
selector. Keep the database and retention cron so installation-linked rows
still expire. Do not delete the database.

Sending stays off: changing `TELEMETRY_ENDPOINT` to
`https://t.lobstah.dev/v1/daily` requires a separate decision and release.
New-install-per-day caps and an admin deletion API remain open follow-ups;
neither is implemented here.
