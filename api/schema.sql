-- Soundbay account database (Cloudflare D1)
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  pw_hash      TEXT NOT NULL,
  salt         TEXT NOT NULL,
  created      INTEGER NOT NULL,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- One row per note, take, plan or sketch. `updated` is the editing device's clock,
-- `srv` is the server's clock and drives incremental sync.
CREATE TABLE IF NOT EXISTS items (
  user_id TEXT NOT NULL,
  id      TEXT NOT NULL,
  kind    TEXT NOT NULL DEFAULT '',
  data    TEXT NOT NULL DEFAULT '',
  updated INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  srv     INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS items_sync ON items (user_id, srv);
