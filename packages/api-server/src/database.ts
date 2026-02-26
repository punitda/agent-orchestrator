import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database, { type Database as DatabaseType } from "better-sqlite3";

// ── Types ──────────────────────────────────────────────────────────────

export type MessageType =
  | "text_response"
  | "tool_summary"
  | "permission_request"
  | "input_request"
  | "user_message";

export interface Message {
  id: number;
  session_id: string;
  type: MessageType;
  content: string;
  metadata: unknown | null;
  created_at: string;
}

export interface Device {
  id: number;
  token: string;
  platform: string;
  created_at: string;
}

export interface NotificationLogEntry {
  id: number;
  session_id: string;
  event_type: string;
  event_hash: string;
  sent_at: string;
}

export interface CommanderDatabase {
  insertMessage(
    sessionId: string,
    type: MessageType,
    content: string,
    metadata?: string | null,
  ): Message;
  getMessagesSince(sessionId: string, sinceTimestamp: string): Message[];
  registerDevice(token: string, platform: string): Device;
  getDevices(): Device[];
  logNotification(sessionId: string, eventType: string, eventHash: string): NotificationLogEntry;
  hasNotification(sessionId: string, eventType: string, eventHash: string): boolean;
  close(): void;
}

// ── Raw row types (what SQLite actually returns) ──────────────────────

interface MessageRow {
  id: number;
  session_id: string;
  type: string;
  content: string;
  metadata: string | null;
  created_at: string;
}

interface DeviceRow {
  id: number;
  token: string;
  platform: string;
  created_at: string;
}

interface CountRow {
  count: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseMetadata(raw: string | null): unknown | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type as MessageType,
    content: row.content,
    metadata: parseMetadata(row.metadata),
    created_at: row.created_at,
  };
}

// ── Schema ─────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT     NOT NULL,
    type       TEXT     NOT NULL,
    content    TEXT     NOT NULL,
    metadata   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS devices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT     NOT NULL UNIQUE,
    platform   TEXT     NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notification_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT     NOT NULL,
    event_type TEXT     NOT NULL,
    event_hash TEXT     NOT NULL,
    sent_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_dedup
    ON notification_log(session_id, event_type, event_hash);
`;

// ── Default path ───────────────────────────────────────────────────────

export const DEFAULT_DB_PATH = join(homedir(), ".claude-commander", "commander.db");

// ── Factory ────────────────────────────────────────────────────────────

export function createDatabase(dbPath: string = DEFAULT_DB_PATH): CommanderDatabase {
  // Ensure parent directory exists (skip for in-memory databases)
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db: DatabaseType = new Database(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");

  // Create tables and indexes
  db.exec(SCHEMA);

  // ── Prepared statements ────────────────────────────────────────────

  const insertMessageStmt = db.prepare<[string, string, string, string | null]>(
    `INSERT INTO messages (session_id, type, content, metadata)
     VALUES (?, ?, ?, ?)`,
  );

  const getMessagesSinceStmt = db.prepare<[string, string]>(
    `SELECT id, session_id, type, content, metadata, created_at
     FROM messages
     WHERE session_id = ? AND created_at >= ?
     ORDER BY created_at ASC`,
  );

  const registerDeviceStmt = db.prepare<[string, string]>(
    `INSERT INTO devices (token, platform) VALUES (?, ?)
     ON CONFLICT(token) DO UPDATE SET platform = excluded.platform`,
  );

  const getDeviceByTokenStmt = db.prepare<[string]>(
    `SELECT id, token, platform, created_at FROM devices WHERE token = ?`,
  );

  const getDevicesStmt = db.prepare(
    `SELECT id, token, platform, created_at FROM devices ORDER BY created_at ASC`,
  );

  const logNotificationStmt = db.prepare<[string, string, string]>(
    `INSERT INTO notification_log (session_id, event_type, event_hash)
     VALUES (?, ?, ?)`,
  );

  const hasNotificationStmt = db.prepare<[string, string, string]>(
    `SELECT count(*) as count FROM notification_log
     WHERE session_id = ? AND event_type = ? AND event_hash = ?`,
  );

  // ── Public API ─────────────────────────────────────────────────────

  return {
    insertMessage(
      sessionId: string,
      type: MessageType,
      content: string,
      metadata: string | null = null,
    ): Message {
      const result = insertMessageStmt.run(sessionId, type, content, metadata);
      return {
        id: Number(result.lastInsertRowid),
        session_id: sessionId,
        type,
        content,
        metadata: parseMetadata(metadata),
        created_at: new Date().toISOString(),
      };
    },

    getMessagesSince(sessionId: string, sinceTimestamp: string): Message[] {
      const rows = getMessagesSinceStmt.all(sessionId, sinceTimestamp) as MessageRow[];
      return rows.map(toMessage);
    },

    registerDevice(token: string, platform: string): Device {
      registerDeviceStmt.run(token, platform);
      const row = getDeviceByTokenStmt.get(token) as DeviceRow;
      return {
        id: row.id,
        token: row.token,
        platform: row.platform,
        created_at: row.created_at,
      };
    },

    getDevices(): Device[] {
      return getDevicesStmt.all() as DeviceRow[];
    },

    logNotification(sessionId: string, eventType: string, eventHash: string): NotificationLogEntry {
      const result = logNotificationStmt.run(sessionId, eventType, eventHash);
      return {
        id: Number(result.lastInsertRowid),
        session_id: sessionId,
        event_type: eventType,
        event_hash: eventHash,
        sent_at: new Date().toISOString(),
      };
    },

    hasNotification(sessionId: string, eventType: string, eventHash: string): boolean {
      const row = hasNotificationStmt.get(sessionId, eventType, eventHash) as CountRow;
      return row.count > 0;
    },

    close(): void {
      db.close();
    },
  };
}
