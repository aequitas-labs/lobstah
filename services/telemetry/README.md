# lobstah telemetry Worker

A small Cloudflare Worker that receives lobstah's anonymous daily counts
([PRIVACY.md](../../PRIVACY.md)) and serves the project-wide catches badge.
**It is not deployed.** The CLI's endpoint constant (`TELEMETRY_ENDPOINT` in
`packages/core/src/telemetry.ts`) is empty, so no lobstah build sends anything.

## Routes

| Route | What it does |
| ----- | ------------ |
| `POST /v1/daily` | Accepts one payload (`application/json`, ≤ 8 KiB). Schema stays `1`: exactly `schema`, `version`, `os`, `arch`, `installId`, `date`, `catches: {today, total}`, `traps: [{name, today}]`. At most 100 distinct names, two lowercase words of 2–8 letters joined by a hyphen (5–17 characters), positive counts whose sum cannot exceed `catches.today`. Unknown keys at any level are refused with 400. Upserts by install id + UTC date, so a retry never double-counts. 204 on success, 429 when rate-limited. |
| `GET /badge/catches.json` | shields.io endpoint JSON: `{"schemaVersion":1,"label":"🦞","message":"N",...}`, where N is the catches across every sharing install. Use `https://img.shields.io/endpoint?url=<host>/badge/catches.json`. |
| `GET /v1/stats?days=30` | Needs `Authorization: Bearer <READ_TOKEN>`. Returns `totalCatches` and, per day, `activeInstalls`, `catchesToday`, and `newCatches`. |

## Storage: D1, not Analytics Engine

D1 is SQLite, so the Worker can **upsert by install id + date**. That makes
submissions idempotent, and it lets the Worker count only the growth in an
install's `catches.total`, which is what the badge needs. It can also
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
  `catches_today` (sum), and `new_catches` (sum of each install's growth in
  `catches.total`). The badge is `SUM(new_catches)`.

## Retention

A daily cron (`17 3 * * *`) deletes `submissions` and `trap_submissions` rows
whose date is more than **90 days** old (`RETENTION_DAYS`). `daily_totals` rows carry no install id or name
and are kept. Because they are updated on every submission, deleting
per-install rows never changes a total.

Known limit: an install that is silent for more than 90 days and then reports
again has no retained row, so its full `catches.total` counts as growth again.

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

## Deploying (maintainers, later)

Not done in the PR that added this. With Cloudflare access:

```sh
cd services/telemetry
npx wrangler@4 d1 create lobstah-telemetry          # put the id in wrangler.jsonc
npx wrangler@4 d1 migrations apply lobstah-telemetry --remote
npx wrangler@4 secret put READ_TOKEN                # read route token, never committed
npx wrangler@4 deploy
```

Then set `TELEMETRY_ENDPOINT` to `https://<host>/v1/daily` in a lobstah
release.
