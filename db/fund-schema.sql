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
  PRIMARY KEY (guild_id, name)
);
CREATE TABLE IF NOT EXISTS donation (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  amount   REAL NOT NULL,
  donor    TEXT,
  ts       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS donation_by_campaign ON donation (guild_id, name, id);
