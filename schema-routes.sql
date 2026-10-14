-- Guide content. One row per route. status: 'live' (published) or 'verifying' (listed on the home page as in progress).
CREATE TABLE IF NOT EXISTS routes (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  highway TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verifying',
  sort INTEGER NOT NULL DEFAULT 100,
  json TEXT,
  updated_at TEXT NOT NULL
);
