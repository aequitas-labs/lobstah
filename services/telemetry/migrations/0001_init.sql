-- lobstah telemetry (PRIVACY.md). No IP address, user agent, or request
-- metadata is stored anywhere: only the validated payload fields below.

-- One row per install per UTC date. Deleted 90 days after its date by the
-- daily cron (RETENTION_DAYS in src/index.ts).
CREATE TABLE IF NOT EXISTS submissions (
  install_id TEXT NOT NULL,
  date TEXT NOT NULL,
  version TEXT NOT NULL,
  os TEXT NOT NULL,
  arch TEXT NOT NULL,
  catches_today INTEGER NOT NULL,
  total_catches INTEGER NOT NULL,
  PRIMARY KEY (install_id, date)
) WITHOUT ROWID;

-- At most 100 generated names per install per UTC date. Same 90-day expiry
-- as submissions; no names are copied into the indefinite daily totals.
CREATE TABLE IF NOT EXISTS trap_submissions (
  install_id TEXT NOT NULL,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  catches_today INTEGER NOT NULL,
  PRIMARY KEY (install_id, date, name)
) WITHOUT ROWID;

-- Daily totals across all installs, with no install ids. Kept indefinitely.
--   active_installs: installs that submitted for the date
--   catches_today:   sum of the installs' catches.today for the date
--   new_catches:     growth of each install's catches.total since its previous
--                    retained submission; the badge is the sum of this column
CREATE TABLE IF NOT EXISTS daily_totals (
  date TEXT PRIMARY KEY,
  active_installs INTEGER NOT NULL DEFAULT 0,
  catches_today INTEGER NOT NULL DEFAULT 0,
  new_catches INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
