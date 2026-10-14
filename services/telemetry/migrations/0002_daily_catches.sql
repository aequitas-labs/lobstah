-- Catches count daily submissions, never growth of the client's lifetime total.
-- Rebase existing aggregate rows onto their daily high-water counts. No new
-- identity registry or retention exception: active boats/traps use retained rows.
UPDATE daily_totals SET new_catches = catches_today;

CREATE INDEX IF NOT EXISTS submissions_date ON submissions (date, install_id);
CREATE INDEX IF NOT EXISTS trap_submissions_date ON trap_submissions (date, install_id, name);
