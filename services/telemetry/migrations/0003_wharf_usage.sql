-- Anonymous daily buckets only. No account, boat, wharf, repo or request metadata.
CREATE TABLE usage_submissions (
  install_id TEXT NOT NULL,
  date TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (install_id, date)
);
-- Retained aggregates have no installation IDs or names.
CREATE TABLE daily_usage_totals (
  date TEXT NOT NULL,
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL,
  installs INTEGER NOT NULL,
  PRIMARY KEY (date, dimension, bucket)
);
