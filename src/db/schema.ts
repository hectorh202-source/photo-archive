import type { DatabaseSync } from "node:sqlite";

// The whole schema in one place. This app is small enough that a single
// bootstrap beats a migration chain: every table is CREATE TABLE IF NOT
// EXISTS, so it runs on every start and does nothing after the first.
export function bootstrapSchema(db: DatabaseSync): void {
  db.exec(`
    -- People who log in to run archives. Not the contractors whose data is
    -- being archived — those are clients, below.
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      failed_login_count INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      session_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );

    -- One row per contractor whose ServiceTitan tenant is being archived.
    -- cutover_date is the day their ServiceTitan account lapses: after it,
    -- retrieval is impossible at any price, so it drives the countdown on
    -- the dashboard rather than sitting in a notes field somewhere.
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      cutover_date TEXT,
      notes TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Every per-client setting, encrypted at rest: ServiceTitan credentials,
    -- pacing overrides, delivery targets, naming templates. One key-value
    -- table rather than a wide column per setting, because the set of
    -- settings grows every time a delivery target is added.
    CREATE TABLE IF NOT EXISTS client_settings (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (client_id, key)
    );

    -- App-wide settings, same encryption: SMTP, notification recipients,
    -- default pacing, retention.
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- An archive run and the files it produced. Progress lives here rather
    -- than in memory because a run takes hours: the page polls these rows,
    -- and a restart mid-run leaves a record of what happened.
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL REFERENCES clients(id),
      requested_by_user_id INTEGER,
      requested_by_email TEXT NOT NULL,
      filters_json TEXT NOT NULL,
      status TEXT NOT NULL,
      jobs_total INTEGER NOT NULL DEFAULT 0,
      jobs_done INTEGER NOT NULL DEFAULT 0,
      photos_total INTEGER NOT NULL DEFAULT 0,
      bytes_total INTEGER NOT NULL DEFAULT 0,
      current_step TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_client ON runs(client_id, created_at);

    CREATE TABLE IF NOT EXISTS run_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      file_path TEXT NOT NULL,
      jobs INTEGER NOT NULL DEFAULT 0,
      photos INTEGER NOT NULL DEFAULT 0,
      bytes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      error TEXT,
      delivered_at TEXT,
      finished_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_run_files_run ON run_files(run_id, month);

    -- Who did what to whose data. An archive copies a contractor's customer
    -- records out of their CRM; that should never be untraceable.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      user_id INTEGER,
      user_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  `);
}
