import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ParsedMessage } from "@composio/ao-core";
import { SessionPoller } from "../session-poller.js";

describe("SessionPoller", () => {
  let tmpDir: string;

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helpers ----------------------------------------------------------------

  function setup(): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-poller-test-"));
    return tmpDir;
  }

  function writeJsonl(lines: string[], filename = "session.jsonl"): string {
    const filePath = join(tmpDir, filename);
    writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  function appendJsonl(filePath: string, lines: string[]): void {
    appendFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  }

  function assistantLine(text: string): string {
    return JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      timestamp: new Date().toISOString(),
    });
  }

  function userLine(text: string): string {
    return JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
      timestamp: new Date().toISOString(),
    });
  }

  // ---------------------------------------------------------------------------
  // Basic lifecycle
  // ---------------------------------------------------------------------------

  describe("start / stop / stopAll", () => {
    it("start() adds session to activeSessionIds", () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      expect(poller.activeSessionIds.has("session-1")).toBe(true);
      poller.stopAll();
    });

    it("stop() removes session from activeSessionIds", () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      poller.stop("session-1");
      expect(poller.activeSessionIds.has("session-1")).toBe(false);
    });

    it("stopAll() clears all sessions", () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      poller.start("session-2");
      poller.stopAll();
      expect(poller.activeSessionIds.size).toBe(0);
    });

    it("start() is a no-op if already polling", () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      poller.start("session-1");
      expect(poller.activeSessionIds.size).toBe(1);
      poller.stopAll();
    });

    it("stop() is a no-op for unknown session", () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      // Should not throw
      poller.stop("nonexistent");
    });
  });

  // ---------------------------------------------------------------------------
  // pollOnce behavior
  // ---------------------------------------------------------------------------

  describe("pollOnce", () => {
    it("emits messages when JSONL file has content", async () => {
      setup();
      const filePath = writeJsonl([assistantLine("Hello world")]);
      const messages: Array<{ sessionId: string; messages: ParsedMessage[] }> = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (sessionId: string, msgs: ParsedMessage[]) => {
        messages.push({ sessionId, messages: msgs });
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");

      expect(messages).toHaveLength(1);
      expect(messages[0]!.sessionId).toBe("session-1");
      expect(messages[0]!.messages.some((m) => m.content === "Hello world")).toBe(true);

      poller.stopAll();
    });

    it("emits only new messages on subsequent polls (incremental)", async () => {
      setup();
      const filePath = writeJsonl([assistantLine("First message")]);
      const allMessages: ParsedMessage[][] = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (_sid: string, msgs: ParsedMessage[]) => {
        allMessages.push(msgs);
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");
      expect(allMessages).toHaveLength(1);

      // Append new content
      appendJsonl(filePath, [assistantLine("Second message")]);
      await poller.pollOnce("session-1");

      expect(allMessages).toHaveLength(2);
      expect(allMessages[1]!.some((m) => m.content === "Second message")).toBe(true);
      // Should NOT re-emit the first message
      expect(allMessages[1]!.some((m) => m.content === "First message")).toBe(false);

      poller.stopAll();
    });

    it("skips poll when no new bytes", async () => {
      setup();
      const filePath = writeJsonl([assistantLine("Hello")]);
      let emitCount = 0;

      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", () => emitCount++);
      poller.start("session-1");

      await poller.pollOnce("session-1");
      expect(emitCount).toBe(1);

      // Second poll with no new data — should not emit
      await poller.pollOnce("session-1");
      expect(emitCount).toBe(1);

      poller.stopAll();
    });

    it("does nothing for unknown session", async () => {
      setup();
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      // Should not throw
      await poller.pollOnce("nonexistent");
    });
  });

  // ---------------------------------------------------------------------------
  // File rotation
  // ---------------------------------------------------------------------------

  describe("file rotation", () => {
    it("resets byte offset when file size shrinks below tracked offset", async () => {
      setup();
      const filePath = writeJsonl([
        assistantLine("Message 1"),
        assistantLine("Message 2"),
        assistantLine("Message 3"),
      ]);

      const allMessages: ParsedMessage[][] = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (_sid: string, msgs: ParsedMessage[]) => {
        allMessages.push(msgs);
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");
      expect(allMessages).toHaveLength(1);

      // Simulate file rotation — rewrite with less content
      writeFileSync(filePath, assistantLine("New session start") + "\n", "utf-8");

      await poller.pollOnce("session-1");

      expect(allMessages).toHaveLength(2);
      expect(allMessages[1]!.some((m) => m.content === "New session start")).toBe(true);

      poller.stopAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal session auto-stop
  // ---------------------------------------------------------------------------

  describe("terminal session auto-stop", () => {
    it("stops polling when session becomes terminal", async () => {
      setup();
      const filePath = writeJsonl([assistantLine("Hello")]);
      let isTerminal = false;

      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => isTerminal,
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");
      expect(poller.activeSessionIds.has("session-1")).toBe(true);

      // Mark session as terminal
      isTerminal = true;
      await poller.pollOnce("session-1");

      expect(poller.activeSessionIds.has("session-1")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // JSONL path resolution
  // ---------------------------------------------------------------------------

  describe("JSONL path resolution", () => {
    it("skips poll if resolveJsonlPath returns null", async () => {
      setup();
      let emitCount = 0;
      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", () => emitCount++);
      poller.start("session-1");
      await poller.pollOnce("session-1");

      expect(emitCount).toBe(0);
      // Session stays active — it will try again next tick
      expect(poller.activeSessionIds.has("session-1")).toBe(true);

      poller.stopAll();
    });

    it("re-resolves path after file disappears", async () => {
      setup();
      const filePath = writeJsonl([assistantLine("Hello")]);
      const secondFile = join(tmpDir, "session2.jsonl");
      writeFileSync(secondFile, assistantLine("World") + "\n", "utf-8");

      let pathToReturn: string | null = filePath;

      const allMessages: ParsedMessage[][] = [];
      const poller = new SessionPoller({
        resolveJsonlPath: async () => pathToReturn,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (_sid: string, msgs: ParsedMessage[]) => {
        allMessages.push(msgs);
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");
      expect(allMessages).toHaveLength(1);

      // Delete the first file and point resolver to the second
      rmSync(filePath);
      pathToReturn = secondFile;

      // Next poll: stat fails on old path → clears cached path
      await poller.pollOnce("session-1");

      // Poll after that: re-resolves to second file
      await poller.pollOnce("session-1");
      expect(allMessages).toHaveLength(2);
      expect(allMessages[1]!.some((m) => m.content === "World")).toBe(true);

      poller.stopAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe("error handling", () => {
    it("emits error event when resolveJsonlPath throws", async () => {
      setup();
      const errors: Array<{ sessionId: string; error: Error }> = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async () => {
          throw new Error("resolve failed");
        },
        isSessionTerminal: async () => false,
      });

      poller.on("error", (sessionId: string, error: Error) => {
        errors.push({ sessionId, error });
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");

      expect(errors).toHaveLength(1);
      expect(errors[0]!.sessionId).toBe("session-1");
      expect(errors[0]!.error.message).toBe("resolve failed");

      poller.stopAll();
    });

    it("emits error event when isSessionTerminal throws", async () => {
      setup();
      const errors: Array<{ sessionId: string; error: Error }> = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => {
          throw new Error("terminal check failed");
        },
      });

      poller.on("error", (sessionId: string, error: Error) => {
        errors.push({ sessionId, error });
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");

      expect(errors).toHaveLength(1);
      expect(errors[0]!.error.message).toBe("terminal check failed");

      poller.stopAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Configurable interval
  // ---------------------------------------------------------------------------

  describe("configurable interval", () => {
    it("uses custom intervalMs via setInterval", () => {
      setup();
      const spy = vi.spyOn(globalThis, "setInterval");

      const poller = new SessionPoller({
        intervalMs: 2000,
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 2000);

      poller.stopAll();
      spy.mockRestore();
    });

    it("defaults to 10 seconds", () => {
      setup();
      const spy = vi.spyOn(globalThis, "setInterval");

      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");

      expect(spy).toHaveBeenCalledWith(expect.any(Function), 10_000);

      poller.stopAll();
      spy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple sessions
  // ---------------------------------------------------------------------------

  describe("multiple sessions", () => {
    it("tracks offsets independently per session", async () => {
      setup();
      const file1 = writeJsonl([assistantLine("Session 1 - msg 1")], "s1.jsonl");
      const file2 = writeJsonl([assistantLine("Session 2 - msg 1")], "s2.jsonl");

      const messages: Array<{ sessionId: string; messages: ParsedMessage[] }> = [];

      const poller = new SessionPoller({
        resolveJsonlPath: async (id) => (id === "s1" ? file1 : file2),
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (sessionId: string, msgs: ParsedMessage[]) => {
        messages.push({ sessionId, messages: msgs });
      });

      poller.start("s1");
      poller.start("s2");
      await poller.pollOnce("s1");
      await poller.pollOnce("s2");

      const s1Messages = messages.filter((m) => m.sessionId === "s1");
      const s2Messages = messages.filter((m) => m.sessionId === "s2");
      expect(s1Messages).toHaveLength(1);
      expect(s2Messages).toHaveLength(1);

      // Append only to file2
      appendFileSync(file2, assistantLine("Session 2 - msg 2") + "\n", "utf-8");
      await poller.pollOnce("s1");
      await poller.pollOnce("s2");

      const s1After = messages.filter((m) => m.sessionId === "s1");
      const s2After = messages.filter((m) => m.sessionId === "s2");
      expect(s1After).toHaveLength(1); // no new data for s1
      expect(s2After).toHaveLength(2); // new data for s2

      poller.stopAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed message types
  // ---------------------------------------------------------------------------

  describe("mixed message types", () => {
    it("emits user and assistant messages together", async () => {
      setup();
      const filePath = writeJsonl([userLine("hi"), assistantLine("Hello!")]);

      const allMessages: ParsedMessage[] = [];
      const poller = new SessionPoller({
        resolveJsonlPath: async () => filePath,
        isSessionTerminal: async () => false,
      });

      poller.on("messages", (_sid: string, msgs: ParsedMessage[]) => {
        allMessages.push(...msgs);
      });

      poller.start("session-1");
      await poller.pollOnce("session-1");

      expect(allMessages.some((m) => m.type === "user_message")).toBe(true);
      expect(allMessages.some((m) => m.type === "text_response")).toBe(true);

      poller.stopAll();
    });
  });

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  describe("cleanup", () => {
    it("clearInterval is called for each session on stopAll", () => {
      setup();
      const spy = vi.spyOn(globalThis, "clearInterval");

      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      poller.start("session-2");
      poller.stopAll();

      expect(spy).toHaveBeenCalledTimes(2);

      spy.mockRestore();
    });

    it("clearInterval is called on stop", () => {
      setup();
      const spy = vi.spyOn(globalThis, "clearInterval");

      const poller = new SessionPoller({
        resolveJsonlPath: async () => null,
        isSessionTerminal: async () => false,
      });

      poller.start("session-1");
      poller.stop("session-1");

      expect(spy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
    });
  });
});
