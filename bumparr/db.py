"""SQLite storage: the playable registry, channel playout cursor, and play history."""
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote

from bumparr import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS playables (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,                 -- video | card | stream | image
  kind         TEXT,                          -- ambient | station_id | trivia | psa | number | webcam | testpattern ...
  source       TEXT,                          -- nasa | archive | generated | local | manual
  uri          TEXT,                          -- media path (video, relative to ASSET_ROOT) or stream URL; NULL for cards
  duration     REAL NOT NULL DEFAULT 14,      -- seconds this item occupies the channel
  title        TEXT,
  payload      TEXT DEFAULT '{}',             -- JSON (card content, overlay hints, stream flags)
  tags         TEXT DEFAULT '',
  weight       REAL NOT NULL DEFAULT 1.0,
  enabled      INTEGER NOT NULL DEFAULT 1,
  health       TEXT NOT NULL DEFAULT 'ok',    -- ok | dead
  fail_count   INTEGER NOT NULL DEFAULT 0,    -- consecutive playback failures; reset on success
  last_played  REAL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  created_at   REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playout (
  channel_id   TEXT PRIMARY KEY,
  current_id   TEXT,
  started_at   REAL
);
CREATE TABLE IF NOT EXISTS play_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT,
  playable_id  TEXT,
  played_at    REAL
);
CREATE INDEX IF NOT EXISTS idx_history_chan ON play_history(channel_id, played_at DESC);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id                 TEXT PRIMARY KEY,
  parent_job_id      TEXT,
  status             TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_alias        TEXT NOT NULL,
  provider_model     TEXT NOT NULL,
  provider_model_canonical TEXT,
  output_modality    TEXT NOT NULL,
  mode               TEXT NOT NULL,
  operator_brief     TEXT NOT NULL,
  submitted_prompt   TEXT NOT NULL,
  title              TEXT NOT NULL,
  kind               TEXT NOT NULL,
  request_json       TEXT NOT NULL DEFAULT '{}',
  references_json    TEXT NOT NULL DEFAULT '[]',
  creative_json      TEXT NOT NULL DEFAULT '{}',
  capability_json    TEXT NOT NULL DEFAULT '{}',
  provider_job_id    TEXT,
  provider_generation_id TEXT,
  provider_request_id TEXT,
  usage_json         TEXT NOT NULL DEFAULT '{}',
  budget_day         TEXT NOT NULL,
  reserved_jobs      INTEGER NOT NULL DEFAULT 0,
  reserved_video_seconds INTEGER NOT NULL DEFAULT 0,
  reserved_cost_microusd INTEGER NOT NULL DEFAULT 0,
  actual_cost_microusd INTEGER,
  error_code         TEXT,
  error_message      TEXT,
  attempt_count      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    REAL,
  created_at         REAL NOT NULL,
  updated_at         REAL NOT NULL,
  submitted_at       REAL,
  completed_at       REAL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_provider_job
  ON generation_jobs(provider, provider_job_id)
  WHERE provider_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_generation_status_updated
  ON generation_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS generation_outputs (
  id                 TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  modality           TEXT NOT NULL,
  processing_status  TEXT NOT NULL,
  review_status      TEXT NOT NULL,
  playable_id        TEXT,
  output_sha256      TEXT,
  media_path         TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  review_reason      TEXT,
  created_at         REAL NOT NULL,
  updated_at         REAL NOT NULL,
  reviewed_at        REAL,
  UNIQUE(job_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_generation_output_review
  ON generation_outputs(review_status, updated_at);
"""


def _readonly_uri(path):
    resolved = Path(path).resolve()
    return "file:%s?mode=ro" % quote(resolved.as_posix(), safe="/")


@contextmanager
def conn(readonly=False, immediate=False):
    """A new SQLite connection with the pragmas the shared DB needs.

    A 15s busy timeout because the database is genuinely shared — the
    app, the CLI modules run as subprocesses, and (in combined deploys) a
    player can all touch it, and every write path here is short and atomic.
    The context commits on success, rolls back on error, and always closes.
    Read-only connections never create a file, never mkdir, and refuse writes.
    """
    if readonly:
        path = Path(config.DB_PATH)
        if not path.is_file():
            raise FileNotFoundError("database does not exist: %s" % path)
        c = sqlite3.connect(_readonly_uri(path), uri=True, timeout=10)
        try:
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA query_only=ON")
            c.execute("PRAGMA busy_timeout=15000")
            yield c
        finally:
            c.close()
        return
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(config.DB_PATH, timeout=10)
    try:
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA busy_timeout=15000")
        if immediate:
            # Serialize writers so budget check + insert cannot interleave.
            # isolation_level alone does not begin a transaction before SELECT.
            c.execute("BEGIN IMMEDIATE")
        with c:
            yield c
    finally:
        c.close()


def init_db():
    """Create the schema if needed and run additive migrations.

    Idempotent and safe to call from every entry point (app startup, each
    CLI module) because CREATE IF NOT EXISTS plus the migration check make
    repeated calls no-ops on an existing database.
    """
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    # WAL is persistent database state; set it once during initialization,
    # before normal short-lived connections begin sharing the file.
    initial = sqlite3.connect(config.DB_PATH, timeout=10)
    try:
        initial.execute("PRAGMA journal_mode=WAL")
    finally:
        initial.close()
    with conn() as c:
        c.executescript(SCHEMA)
        _migrate(c)


def _migrate(c):
    """Additive migrations for databases created before a column existed."""
    have = {r[1] for r in c.execute("PRAGMA table_info(playables)")}
    if "fail_count" not in have:
        c.execute("ALTER TABLE playables ADD COLUMN fail_count INTEGER NOT NULL DEFAULT 0")
        c.commit()


def upsert_playable(c, p: dict):
    """Insert a playable if its id is new; leave existing rows untouched.

    Uses INSERT OR IGNORE so it's atomic and idempotent — a check-then-insert
    races on a shared DB (a player and Bumparr may both reseed) and throws UNIQUE
    constraint errors. Returns True only if this call actually inserted the row.
    """
    cur = c.execute(
        """INSERT OR IGNORE INTO playables
           (id, type, kind, source, uri, duration, title, payload, tags, weight, enabled, health, created_at)
           VALUES (:id, :type, :kind, :source, :uri, :duration, :title, :payload, :tags, :weight, 1, 'ok', :created_at)""",
        {
            "payload": "{}",
            "tags": "",
            "weight": 1.0,
            "created_at": time.time(),
            **p,
        },
    )
    return cur.rowcount > 0


def insert_generated_playable(c, p: dict):
    """Register a review-pending generated candidate: enabled=0, weight=0.

    Do not use upsert_playable for this path — that helper inserts enabled=1.
    Proposed ordinary weight lives in payload.generation and is restored only
    by the approval transaction.
    """
    cur = c.execute(
        """INSERT OR IGNORE INTO playables
           (id, type, kind, source, uri, duration, title, payload, tags, weight, enabled, health, created_at)
           VALUES (:id, :type, :kind, :source, :uri, :duration, :title, :payload, :tags, 0, 0, 'ok', :created_at)""",
        {
            "payload": "{}",
            "tags": "ai-generated,pending-review",
            "created_at": time.time(),
            **p,
        },
    )
    return cur.rowcount > 0
