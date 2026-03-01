import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonlMessages } from "../jsonl-parser.js";

// Path to fixture files
const FIXTURES = join(import.meta.dirname, "fixtures");

describe("parseJsonlMessages", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  /** Create a temp JSONL file with given content */
  function createTempFile(content: string): string {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-jsonl-parser-test-"));
    const filePath = join(tmpDir, "test.jsonl");
    writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  // ---------------------------------------------------------------------------
  // Empty / missing file handling
  // ---------------------------------------------------------------------------

  describe("empty and missing files", () => {
    it("returns empty array for nonexistent file", async () => {
      const result = await parseJsonlMessages("/tmp/nonexistent-ao-test-file.jsonl");
      expect(result.messages).toEqual([]);
      expect(result.bytesRead).toBe(0);
    });

    it("returns empty array for empty file", async () => {
      const filePath = createTempFile("");
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
      expect(result.bytesRead).toBe(0);
    });

    it("returns empty array for whitespace-only file", async () => {
      const filePath = createTempFile("   \n\n  \n");
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Text responses (assistant messages)
  // ---------------------------------------------------------------------------

  describe("text_response extraction", () => {
    it("extracts text from assistant messages", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "assistant-text.jsonl"));
      const textMessages = result.messages.filter((m) => m.type === "text_response");
      expect(textMessages).toHaveLength(2);
      expect(textMessages[0].content).toBe(
        "Sure! I'd be happy to help you fix the bug. Let me take a look at your code.",
      );
      expect(textMessages[1].content).toBe(
        "I found the issue. The problem is in the authentication middleware where the token validation is skipped for certain routes.",
      );
    });

    it("extracts user messages from the same file", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "assistant-text.jsonl"));
      const userMessages = result.messages.filter((m) => m.type === "user_message");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0].content).toBe("Hello, can you help me fix a bug?");
    });

    it("preserves timestamps on messages", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "assistant-text.jsonl"));
      expect(result.messages[0].timestamp).toBe("2025-01-15T10:00:00.000Z");
    });

    it("extracts text from string content (not array blocks)", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","message":{"role":"assistant","content":"Simple string content"},"timestamp":"2025-01-15T10:00:00.000Z"}\n',
      );
      const result = await parseJsonlMessages(filePath);
      const textMessages = result.messages.filter((m) => m.type === "text_response");
      expect(textMessages).toHaveLength(1);
      expect(textMessages[0].content).toBe("Simple string content");
    });
  });

  // ---------------------------------------------------------------------------
  // Tool summaries
  // ---------------------------------------------------------------------------

  describe("tool_summary extraction", () => {
    it("formats Read tool summary", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[0].content).toBe("Read auth.ts");
    });

    it("formats Edit tool summary with line counts", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[1].content).toBe("Edited auth.ts +2/-0 lines");
    });

    it("formats Write tool summary", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[2].content).toBe("Created new-middleware.ts");
    });

    it("formats Bash tool summary with command preview", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[3].content).toBe("Ran npm test -- --reporter=verbose");
    });

    it("formats Glob tool summary", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[4].content).toBe("Glob src/**/*.test.ts");
    });

    it("formats Grep tool summary", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[5].content).toBe("Grep validateToken");
    });

    it("formats unknown tool with generic summary", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[6].content).toBe("Agent");
    });

    it("includes toolName and toolInput in metadata", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-uses.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[0].metadata).toEqual({
        toolName: "Read",
        toolInput: { file_path: "src/auth.ts" },
      });
    });

    it("handles top-level tool_use type entries", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "tool-use-type.jsonl"));
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools).toHaveLength(2);
      expect(tools[0].content).toBe("Read package.json");
      expect(tools[1].content).toContain("Ran npm test");
    });

    it("truncates long bash commands at 50 chars", async () => {
      const longCommand = "a".repeat(60);
      const filePath = createTempFile(
        `{"type":"tool_use","tool_name":"Bash","tool_input":{"command":"${longCommand}"},"timestamp":"2025-01-15T10:00:00.000Z"}\n`,
      );
      const result = await parseJsonlMessages(filePath);
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[0].content).toBe(`Ran ${"a".repeat(50)}...`);
    });
  });

  // ---------------------------------------------------------------------------
  // Permission requests
  // ---------------------------------------------------------------------------

  describe("permission_request extraction", () => {
    it("extracts permission request messages", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "permission-request.jsonl"));
      const perms = result.messages.filter((m) => m.type === "permission_request");
      expect(perms).toHaveLength(1);
      expect(perms[0].content).toBe("Run command: npm test --reporter=verbose");
    });

    it("handles permission_request with subtype", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","subtype":"permission_request","message":{"role":"assistant","content":[{"type":"text","text":"Allow write to /etc/hosts?"}]},"timestamp":"2025-01-15T10:00:00.000Z"}\n',
      );
      const result = await parseJsonlMessages(filePath);
      const perms = result.messages.filter((m) => m.type === "permission_request");
      expect(perms).toHaveLength(1);
      expect(perms[0].content).toBe("Allow write to /etc/hosts?");
    });
  });

  // ---------------------------------------------------------------------------
  // Input requests
  // ---------------------------------------------------------------------------

  describe("input_request extraction", () => {
    it("extracts input request messages", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "input-request.jsonl"));
      const inputs = result.messages.filter((m) => m.type === "input_request");
      expect(inputs).toHaveLength(1);
      expect(inputs[0].content).toBe(
        "Which database backend would you like to use? Options: PostgreSQL, SQLite, or MongoDB?",
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed session (realistic scenario)
  // ---------------------------------------------------------------------------

  describe("mixed session parsing", () => {
    it("extracts all message types from a realistic session", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "mixed-session.jsonl"));
      const types = result.messages.map((m) => m.type);
      expect(types).toEqual([
        "user_message",
        "text_response",
        "tool_summary", // Read
        "tool_summary", // Edit (tool_use blocks come before text in same entry)
        "text_response", // "I see the issue..."
        "permission_request",
        "tool_summary", // Bash
        "text_response", // "All tests pass..."
      ]);
    });

    it("maintains chronological order", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "mixed-session.jsonl"));
      for (let i = 1; i < result.messages.length; i++) {
        const prev = new Date(result.messages[i - 1].timestamp).getTime();
        const curr = new Date(result.messages[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    it("returns bytesRead for incremental reads", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "mixed-session.jsonl"));
      expect(result.bytesRead).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Malformed / truncated JSONL handling
  // ---------------------------------------------------------------------------

  describe("malformed JSONL handling", () => {
    it("skips bad lines and extracts valid ones", async () => {
      const result = await parseJsonlMessages(join(FIXTURES, "malformed.jsonl"));
      // Should extract user message and assistant text, skip bad lines
      const userMsgs = result.messages.filter((m) => m.type === "user_message");
      const textMsgs = result.messages.filter((m) => m.type === "text_response");
      expect(userMsgs).toHaveLength(1);
      expect(userMsgs[0].content).toBe("Hello");
      expect(textMsgs).toHaveLength(1);
      expect(textMsgs[0].content).toBe("Valid response after bad lines.");
    });

    it("does not crash on completely invalid content", async () => {
      const filePath = createTempFile("}}}{{{not json\nstill not json\n[1,2,3]\n");
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental reading (fromByte)
  // ---------------------------------------------------------------------------

  describe("incremental reading with fromByte", () => {
    it("reads from byte offset, skipping first potentially truncated line", async () => {
      const line1 = '{"type":"user","message":{"role":"user","content":"First"},"timestamp":"2025-01-15T10:00:00.000Z"}\n';
      const line2 = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Second"}]},"timestamp":"2025-01-15T10:00:01.000Z"}\n';
      const line3 = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Third"}]},"timestamp":"2025-01-15T10:00:02.000Z"}\n';
      const filePath = createTempFile(line1 + line2 + line3);

      // Read from offset past first line — the parser skips the first line
      // at the offset boundary because it may be truncated mid-file
      const fromByte = Buffer.byteLength(line1, "utf-8");
      const result = await parseJsonlMessages(filePath, fromByte);

      // line2 is skipped (potentially truncated), only line3 is parsed
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].type).toBe("text_response");
      expect(result.messages[0].content).toBe("Third");
    });

    it("returns empty when fromByte exceeds file size", async () => {
      const filePath = createTempFile('{"type":"user","message":{"role":"user","content":"Hi"}}\n');
      const result = await parseJsonlMessages(filePath, 999999);
      expect(result.messages).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("skips non-object JSON values (arrays, strings, numbers)", async () => {
      const filePath = createTempFile('"just a string"\n42\n[1,2,3]\ntrue\nnull\n');
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
    });

    it("skips entries without recognized type", async () => {
      const filePath = createTempFile(
        '{"type":"system","data":"init"}\n{"type":"progress","percent":50}\n',
      );
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
    });

    it("handles assistant message with empty content blocks", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","message":{"role":"assistant","content":[]},"timestamp":"2025-01-15T10:00:00.000Z"}\n',
      );
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toEqual([]);
    });

    it("handles assistant message with mixed text and tool_use blocks", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me check."},{"type":"tool_use","name":"Read","input":{"file_path":"src/index.ts"}}]},"timestamp":"2025-01-15T10:00:00.000Z"}\n',
      );
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].type).toBe("tool_summary");
      expect(result.messages[0].content).toBe("Read index.ts");
      expect(result.messages[1].type).toBe("text_response");
      expect(result.messages[1].content).toBe("Let me check.");
    });

    it("handles Edit tool with equal-length replacements", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/app.ts","old_string":"foo","new_string":"bar"}}]},"timestamp":"2025-01-15T10:00:00.000Z"}\n',
      );
      const result = await parseJsonlMessages(filePath);
      const tools = result.messages.filter((m) => m.type === "tool_summary");
      expect(tools[0].content).toBe("Edited app.ts +0/-0 lines");
    });

    it("provides fallback timestamp when none in entry", async () => {
      const filePath = createTempFile(
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"No timestamp"}]}}\n',
      );
      const result = await parseJsonlMessages(filePath);
      expect(result.messages).toHaveLength(1);
      // Should have a valid ISO timestamp (auto-generated)
      expect(() => new Date(result.messages[0].timestamp)).not.toThrow();
    });
  });
});
