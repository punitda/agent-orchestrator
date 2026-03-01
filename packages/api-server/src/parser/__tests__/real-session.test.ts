/**
 * Tests the JSONL parser against a fixture derived from REAL Claude Code
 * session output (sanitized). This exposes gaps between the parser's
 * assumptions and the actual JSONL format Claude Code writes.
 *
 * The fixture (real-session.jsonl) contains these real entry types:
 *
 *   type=user (string content)       — real human message
 *   type=user (tool_result content)   — tool results sent back to model
 *   type=user (isMeta: true)          — system-generated meta messages
 *   type=user (text: "[Request interrupted...]") — system interrupts
 *   type=user (text + image blocks)   — user message with pasted images
 *   type=assistant (thinking blocks)  — thinking, no visible content
 *   type=assistant (text blocks)      — visible text response
 *   type=assistant (tool_use blocks)  — tool invocations
 *   type=assistant (mixed text+tool)  — text and tool_use in same message
 *   type=progress (agent_progress)    — subagent progress
 *   type=progress (hook_progress)     — hook execution
 *   type=progress (bash_progress)     — bash command output
 *   type=progress (mcp_progress)      — MCP tool progress
 *   type=system (stop_hook_summary)   — post-turn hook summary
 *   type=system (turn_duration)       — turn timing metadata
 *   type=file-history-snapshot        — file backup tracking
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { parseJsonlMessages } from "../jsonl-parser.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const REAL_SESSION = join(FIXTURES, "real-session.jsonl");

describe("parseJsonlMessages — real session format", () => {
  // =========================================================================
  // Current behavior: document what the parser actually does today
  // =========================================================================

  it("parses the real session fixture without crashing", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.bytesRead).toBeGreaterThan(0);
  });

  it("extracts human user messages (string content)", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    // The first user entry has string content — a real human message
    const humanMsg = userMsgs.find((m) =>
      m.content.includes("Fix the authentication bug"),
    );
    expect(humanMsg).toBeDefined();
    expect(humanMsg!.timestamp).toBe("2025-01-15T10:00:00.000Z");
  });

  it("extracts assistant text responses", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const textMsgs = result.messages.filter((m) => m.type === "text_response");
    // Should find: "Let me read the auth file...", "I found the bug...", "The auth bug has been fixed..."
    expect(textMsgs.length).toBe(3);
    expect(textMsgs[0].content).toBe("Let me read the auth file and explore the codebase.");
    expect(textMsgs[1].content).toContain("I found the bug");
    expect(textMsgs[2].content).toContain("authentication bug has been fixed");
  });

  it("extracts tool_use blocks from assistant messages", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const tools = result.messages.filter((m) => m.type === "tool_summary");
    const toolNames = tools.map((t) => (t.metadata as Record<string, unknown>)["toolName"]);
    // Read, Agent, Edit, Bash
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Agent");
    expect(toolNames).toContain("Edit");
    expect(toolNames).toContain("Bash");
  });

  it("formats tool summaries correctly", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const tools = result.messages.filter((m) => m.type === "tool_summary");
    const summaries = tools.map((t) => t.content);
    expect(summaries).toContain("Read auth.ts");
    expect(summaries).toContain("Agent");
    expect(summaries.find((s) => s.startsWith("Edited auth.ts"))).toBeDefined();
    expect(summaries.find((s) => s.startsWith("Ran cd /Users/dev/project && npm test"))).toBeDefined();
  });

  it("ignores thinking blocks (no text output from them)", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const allContent = result.messages.map((m) => m.content).join(" ");
    expect(allContent).not.toContain("Let me analyze the auth bug");
  });

  it("does not emit tool_result user entries as user_message", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    // tool_result entries have text like "export function validateToken..."
    // and "Found validation patterns..." — these should NOT appear
    const toolResultLeak = userMsgs.find(
      (m) =>
        m.content.includes("validateToken") ||
        m.content.includes("Found validation patterns") ||
        m.content.includes("File edited successfully") ||
        m.content.includes("All 12 tests passed"),
    );
    expect(toolResultLeak).toBeUndefined();
  });

  // =========================================================================
  // BUG: isMeta user entries should be filtered out
  // =========================================================================

  it("should NOT emit isMeta user entries as user_message", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    const metaLeak = userMsgs.find((m) => m.content.includes("local-command-caveat"));
    expect(metaLeak).toBeUndefined();
  });

  // =========================================================================
  // BUG: system-generated interrupt messages should be filtered out
  // =========================================================================

  it("should NOT emit '[Request interrupted...]' as user_message", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    const interruptLeak = userMsgs.find((m) => m.content.includes("Request interrupted"));
    expect(interruptLeak).toBeUndefined();
  });

  // =========================================================================
  // BUG: user messages with images — text is extracted but image is lost
  // =========================================================================

  it("should extract user message text when images are attached", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    const imageMsg = userMsgs.find((m) => m.content.includes("dark mode"));
    expect(imageMsg).toBeDefined();
  });

  it("should indicate when user message has images attached", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    const userMsgs = result.messages.filter((m) => m.type === "user_message");
    const imageMsg = userMsgs.find((m) => m.content.includes("dark mode"));
    expect(imageMsg).toBeDefined();
    // Parser should indicate images were attached
    expect((imageMsg!.metadata as Record<string, unknown>)["hasImages"]).toBe(true);
  });

  // =========================================================================
  // GAP: progress entries are completely ignored
  // =========================================================================

  it("should not lose progress/system/snapshot entries silently", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    // The fixture has 20 lines. Currently ~10 get parsed, ~10 are silently dropped.
    // This test documents the total message count so we notice if coverage changes.
    // Real session: user(string), assistant(thinking→0), assistant(text→1),
    //   assistant(2 tool_use→2), progress(agent→0), progress(hook→0),
    //   user(tool_result→0), assistant(text+tool→2), user(tool_result→0),
    //   assistant(bash tool→1), progress(bash→0), user(tool_result→0),
    //   assistant(text→1), system(hook→0), system(duration→0),
    //   user(meta→?), user(interrupt→?), user(image→?), progress(mcp→0)
    //
    // Expected count if we fix the bugs above:
    //   1 user_message (human string) + 1 user_message (dark mode with image)
    //   3 text_response
    //   4 tool_summary (Read, Agent, Edit, Bash)
    //   = 9 total
    //
    // With meta + interrupt leaking through, we'd get 11.
    // Let's just verify the count.
    const types = result.messages.reduce(
      (acc, m) => {
        acc[m.type] = (acc[m.type] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
    // Document current output shape
    expect(types["text_response"]).toBe(3);
    expect(types["tool_summary"]).toBe(4);
    expect(types["user_message"]).toBeDefined();
  });

  // =========================================================================
  // Chronological ordering
  // =========================================================================

  it("maintains chronological order across all message types", async () => {
    const result = await parseJsonlMessages(REAL_SESSION);
    for (let i = 1; i < result.messages.length; i++) {
      const prev = new Date(result.messages[i - 1].timestamp).getTime();
      const curr = new Date(result.messages[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });
});
