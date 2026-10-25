-- The schema a fresh database got from servers before Drizzle (commit edccef9), dumped from sqlite_master.
CREATE TABLE push_delivery (
        outbox_id TEXT NOT NULL REFERENCES push_outbox(id) ON DELETE CASCADE,
        installation_id TEXT NOT NULL REFERENCES push_devices(installation_id) ON DELETE CASCADE,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(outbox_id, installation_id)
      );
CREATE TABLE push_devices (
        installation_id TEXT PRIMARY KEY, platform TEXT NOT NULL, transport TEXT NOT NULL,
        token TEXT NOT NULL, environment TEXT NOT NULL, bundle_id TEXT, enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
CREATE TABLE push_outbox (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, event_json TEXT NOT NULL,
        created_at TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
CREATE TABLE push_presence (
        installation_id TEXT PRIMARY KEY REFERENCES push_devices(installation_id) ON DELETE CASCADE,
        active INTEGER NOT NULL, agent_id TEXT, refreshed_at INTEGER NOT NULL
      );
CREATE TABLE push_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
