# Telemetry

lobstah shares anonymous daily usage statistics, **on by default**. Once
per UTC day the daemon sends schema 2, with `catches.today` and `catches.total` for the UTC day and
all-time, plus up to 100 `traps: [{name, today, harness, model, config}]` entries with automatically
generated names and recorded provenance. Custom names (`--name`) and older
names with unknown provenance stay local; their catches remain in the totals.
Names are not hashed. A `helm` snapshot and up to 100 headless `byWorker`
count buckets include harness, catalog-only model id, and nullable reasoning
effort/permission-mode enums. Unknown observations stay null; custom or
unrecognised model ids become `other`. No arbitrary config is sent.
The payload also includes the lobstah
version, OS family, CPU architecture, the UTC date, and a random install id
made on your machine. It never sends repository names or paths, code, briefs,
session ids, PR URLs, hostnames, or usernames. It also sends small count ranges
for boats and local/wharf grounds, fixed choices for hosted/self-hosted use
and boat access, and daily catches with/without a live helm and on local/wharf
grounds. Older unobserved catches stay unknown. Helm presence distinguishes
none, one and several; an unreadable wharf stays unknown. Boat count is at
least one locally, or the largest visible account roster; it is unknown when
the boat cannot read a configured wharf. Telemetry reads cached observations
only, on its own clock and a fresh connection without wharf credentials or
cookies. Signing in never links the install id to an account. No account or
boat identifiers, wharf addresses, grounds names, tokens or times finer than
the UTC date are sent. Self-hosted wharves receive no telemetry. Hooks never send
anything, and nothing is sent until a one-time notice has been shown in your
terminal. The counts feed a project-wide `🦞 N` badge. Per-install rows are
deleted after 90 days, as are per-trap and worker/config rows; retained daily
totals have only counts, including harness/model aggregates and usage-bucket
histograms, no names or config.

- `lobstah telemetry show` prints the exact JSON that would be sent.
- `lobstah telemetry status` shows whether it is on and why.
- Turn it off with any one of: `lobstah telemetry disable`,
  `[telemetry] share = false` in `~/.lobstah/config.toml`,
  `LOBSTAH_TELEMETRY=0`, `DO_NOT_TRACK=1`, or `CI` set.

No release sends anything yet: the endpoint is not set. Everything about it,
including who receives it and how long it is kept, is in
[PRIVACY.md](../PRIVACY.md).
