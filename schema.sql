CREATE TABLE IF NOT EXISTS plan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  tier TEXT NOT NULL,
  car TEXT NOT NULL,
  port TEXT NOT NULL,
  start_place TEXT NOT NULL,
  end_place TEXT NOT NULL,
  depart TEXT NOT NULL,
  return_date TEXT,
  passengers TEXT,
  memberships TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'new'
);
