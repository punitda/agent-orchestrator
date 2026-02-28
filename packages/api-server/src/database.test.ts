import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDatabase, type CommanderDatabase } from "./database.js";

describe("createDatabase", () => {
  let db: CommanderDatabase;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ── Schema ─────────────────────────────────────────────────────────

  it("creates tables idempotently (can be called twice)", () => {
    // Second call on same path should not throw
    const db2 = createDatabase(":memory:");
    db2.close();
  });

  // ── Messages ───────────────────────────────────────────────────────

  describe("insertMessage", () => {
    it("inserts a message and returns it", () => {
      const msg = db.insertMessage("sess-1", "text_response", "Hello world");
      expect(msg.id).toBe(1);
      expect(msg.session_id).toBe("sess-1");
      expect(msg.type).toBe("text_response");
      expect(msg.content).toBe("Hello world");
      expect(msg.metadata).toBeNull();
      expect(msg.created_at).toBeDefined();
    });

    it("inserts a message with metadata", () => {
      const metadata = JSON.stringify({ tool: "read_file", path: "/tmp/foo" });
      const msg = db.insertMessage("sess-1", "tool_summary", "Read a file", metadata);
      expect(msg.metadata).toEqual({ tool: "read_file", path: "/tmp/foo" });
    });

    it("handles all message types", () => {
      const types = [
        "text_response",
        "tool_summary",
        "permission_request",
        "input_request",
        "user_message",
      ] as const;
      for (const type of types) {
        const msg = db.insertMessage("sess-1", type, `content for ${type}`);
        expect(msg.type).toBe(type);
      }
    });

    it("auto-increments ids", () => {
      const msg1 = db.insertMessage("sess-1", "text_response", "first");
      const msg2 = db.insertMessage("sess-1", "text_response", "second");
      expect(msg2.id).toBe(msg1.id + 1);
    });
  });

  describe("getMessagesSince", () => {
    it("returns messages ordered by created_at ASC", () => {
      db.insertMessage("sess-1", "text_response", "first");
      db.insertMessage("sess-1", "text_response", "second");
      db.insertMessage("sess-1", "text_response", "third");

      // Use a timestamp before "now" to get all messages
      const messages = db.getMessagesSince("sess-1", "2000-01-01T00:00:00Z");
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe("first");
      expect(messages[1].content).toBe("second");
      expect(messages[2].content).toBe("third");
    });

    it("filters by session_id", () => {
      db.insertMessage("sess-1", "text_response", "session one");
      db.insertMessage("sess-2", "text_response", "session two");

      const messages = db.getMessagesSince("sess-1", "2000-01-01T00:00:00Z");
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe("session one");
    });

    it("returns empty array when no messages match", () => {
      const messages = db.getMessagesSince("nonexistent", "2000-01-01T00:00:00Z");
      expect(messages).toEqual([]);
    });

    it("filters by sinceTimestamp", () => {
      db.insertMessage("sess-1", "text_response", "old message");

      // Use a future timestamp — should return nothing
      const messages = db.getMessagesSince("sess-1", "2099-01-01T00:00:00Z");
      expect(messages).toEqual([]);
    });

    it("parses metadata from stored messages", () => {
      const metadata = JSON.stringify({ key: "value" });
      db.insertMessage("sess-1", "tool_summary", "with meta", metadata);

      const messages = db.getMessagesSince("sess-1", "2000-01-01T00:00:00Z");
      expect(messages[0].metadata).toEqual({ key: "value" });
    });

    it("handles invalid JSON metadata gracefully", () => {
      // Insert raw invalid JSON via the insertMessage (metadata is stored as-is)
      db.insertMessage("sess-1", "text_response", "bad meta", "not-valid-json");

      const messages = db.getMessagesSince("sess-1", "2000-01-01T00:00:00Z");
      // Should fall back to raw string instead of crashing
      expect(messages[0].metadata).toBe("not-valid-json");
    });
  });

  // ── Devices ────────────────────────────────────────────────────────

  describe("registerDevice", () => {
    it("registers a new device", () => {
      const device = db.registerDevice("token-abc", "ios");
      expect(device.id).toBe(1);
      expect(device.token).toBe("token-abc");
      expect(device.platform).toBe("ios");
      expect(device.created_at).toBeDefined();
    });

    it("updates platform on duplicate token", () => {
      db.registerDevice("token-abc", "ios");
      const updated = db.registerDevice("token-abc", "android");
      expect(updated.token).toBe("token-abc");
      expect(updated.platform).toBe("android");
    });
  });

  describe("getDevices", () => {
    it("returns all registered devices", () => {
      db.registerDevice("token-1", "ios");
      db.registerDevice("token-2", "android");

      const devices = db.getDevices();
      expect(devices).toHaveLength(2);
      expect(devices[0].token).toBe("token-1");
      expect(devices[1].token).toBe("token-2");
    });

    it("returns empty array when no devices exist", () => {
      expect(db.getDevices()).toEqual([]);
    });
  });

  // ── Notification Log ───────────────────────────────────────────────

  describe("logNotification", () => {
    it("logs a notification", () => {
      const entry = db.logNotification("sess-1", "ci_failure", "hash-abc");
      expect(entry.id).toBe(1);
      expect(entry.session_id).toBe("sess-1");
      expect(entry.event_type).toBe("ci_failure");
      expect(entry.event_hash).toBe("hash-abc");
      expect(entry.sent_at).toBeDefined();
    });

    it("throws on duplicate (session_id, event_type, event_hash)", () => {
      db.logNotification("sess-1", "ci_failure", "hash-abc");
      expect(() => db.logNotification("sess-1", "ci_failure", "hash-abc")).toThrow();
    });

    it("allows same event_hash for different sessions", () => {
      db.logNotification("sess-1", "ci_failure", "hash-abc");
      const entry = db.logNotification("sess-2", "ci_failure", "hash-abc");
      expect(entry.session_id).toBe("sess-2");
    });

    it("allows same event_hash for different event types", () => {
      db.logNotification("sess-1", "ci_failure", "hash-abc");
      const entry = db.logNotification("sess-1", "review_comment", "hash-abc");
      expect(entry.event_type).toBe("review_comment");
    });
  });

  describe("hasNotification", () => {
    it("returns false when notification does not exist", () => {
      expect(db.hasNotification("sess-1", "ci_failure", "hash-abc")).toBe(false);
    });

    it("returns true after logging", () => {
      db.logNotification("sess-1", "ci_failure", "hash-abc");
      expect(db.hasNotification("sess-1", "ci_failure", "hash-abc")).toBe(true);
    });

    it("returns false for different session", () => {
      db.logNotification("sess-1", "ci_failure", "hash-abc");
      expect(db.hasNotification("sess-2", "ci_failure", "hash-abc")).toBe(false);
    });
  });
});
