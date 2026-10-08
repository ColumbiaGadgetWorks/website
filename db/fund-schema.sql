-- Shop fund tables in the `fundraiser` D1 database (binding FUND_DB).
-- Same shape as the fundbot bot's SQLite file, except Discord ids (guild,
-- channel, message) are TEXT: they are 64-bit snowflakes, and D1 hands
-- INTEGER columns to JavaScript as doubles, which would round them.
CREATE TABLE IF NOT EXISTS campaign (
  guild_id   TEXT NOT NULL,
  name       TEXT NOT NULL,
  goal       REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT '$',
  channel_id TEXT,
  message_id TEXT,
  link       TEXT,
  gb_fund     TEXT,  -- Givebutter Fund code or id counted toward this goal
  gb_campaign TEXT,  -- Givebutter campaign code or id counted toward this goal
  gb_keywords TEXT,  -- comma list; untagged gifts mentioning one go to review
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS donation (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  amount   REAL NOT NULL,
  donor    TEXT,
  ts       TEXT NOT NULL,
  external_id TEXT     -- Givebutter transaction id; NULL for gifts entered by hand
);
CREATE INDEX IF NOT EXISTS donation_by_campaign ON donation (guild_id, name, id);
CREATE UNIQUE INDEX IF NOT EXISTS donation_by_external ON donation (external_id);
-- Givebutter gifts a person has to decide on: 'open' (waiting), 'assigned' or
-- 'dismissed' (decided; the sync leaves these alone).
CREATE TABLE IF NOT EXISTS gb_review (
  external_id TEXT PRIMARY KEY,
  guild_id    TEXT NOT NULL,
  guess       TEXT,
  amount      REAL NOT NULL,
  donor       TEXT,
  note        TEXT,
  ts          TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
);
CREATE TABLE IF NOT EXISTS gb_state (key TEXT PRIMARY KEY, value TEXT);
-- Databases made before the Givebutter columns get them automatically: the
-- Worker adds missing columns on first use (ensureGivebutterSchema).
