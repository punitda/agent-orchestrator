/**
 * JSONL Message Parser
 *
 * Reads Claude Code JSONL session files and extracts structured messages
 * of five types: text_response, tool_summary, permission_request,
 * input_request, and user_message.
 *
 * Transforms raw CLI output into a mobile-friendly message feed.
 */

import type { MessageType, ParsedMessage, ParseResult } from "@composio/ao-core";
import { open, readFile, stat } from "node:fs/promises";

// =============================================================================
// JSONL Entry Types (raw shapes from Claude Code JSONL files)
// =============================================================================

interface JsonlContentBlock {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
}

interface JsonlMessage {
  role?: string;
  content?: string | JsonlContentBlock[];
}

interface JsonlEntry {
  type?: string;
  message?: JsonlMessage;
  timestamp?: string;
  // Tool use fields
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  // Permission request fields
  permission_prompt?: string;
  // Subtype for finer classification
  subtype?: string;
  // System-generated meta entries (not real human input)
  isMeta?: boolean;
}

// =============================================================================
// Tool Summary Formatters
// =============================================================================

function formatReadTool(input: Record<string, unknown>): string {
  const filePath = (input["file_path"] ?? input["path"] ?? "") as string;
  const filename = filePath.split("/").pop() ?? filePath;
  return `Read ${filename || "file"}`;
}

function formatEditTool(input: Record<string, unknown>): string {
  const filePath = (input["file_path"] ?? input["path"] ?? "") as string;
  const filename = filePath.split("/").pop() ?? filePath;
  const oldStr = (input["old_string"] ?? "") as string;
  const newStr = (input["new_string"] ?? "") as string;
  const oldLines = oldStr ? oldStr.split("\n").length : 0;
  const newLines = newStr ? newStr.split("\n").length : 0;
  const added = Math.max(0, newLines - oldLines);
  const removed = Math.max(0, oldLines - newLines);
  return `Edited ${filename || "file"} +${added}/-${removed} lines`;
}

function formatWriteTool(input: Record<string, unknown>): string {
  const filePath = (input["file_path"] ?? input["path"] ?? "") as string;
  const filename = filePath.split("/").pop() ?? filePath;
  return `Created ${filename || "file"}`;
}

function formatBashTool(input: Record<string, unknown>): string {
  const command = (input["command"] ?? "") as string;
  // Show first 50 chars of command for preview
  const preview = command.length > 50 ? command.substring(0, 50) + "..." : command;
  return `Ran ${preview || "command"}`;
}

function formatGlobTool(input: Record<string, unknown>): string {
  const pattern = (input["pattern"] ?? "") as string;
  return `Glob ${pattern || "pattern"}`;
}

function formatGrepTool(input: Record<string, unknown>): string {
  const pattern = (input["pattern"] ?? "") as string;
  return `Grep ${pattern || "pattern"}`;
}

function formatToolSummary(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case "Read":
      return formatReadTool(input);
    case "Edit":
      return formatEditTool(input);
    case "Write":
      return formatWriteTool(input);
    case "Bash":
      return formatBashTool(input);
    case "Glob":
      return formatGlobTool(input);
    case "Grep":
      return formatGrepTool(input);
    default: {
      // Generic fallback: "{toolName} on {target}"
      const target =
        (input["file_path"] as string) ??
        (input["path"] as string) ??
        (input["pattern"] as string) ??
        "";
      const filename = target ? target.split("/").pop() ?? target : "";
      return filename ? `${toolName} on ${filename}` : toolName;
    }
  }
}

// =============================================================================
// Content Extraction Helpers
// =============================================================================

/** Extract text content from an assistant message's content blocks. */
function extractAssistantText(content: string | JsonlContentBlock[] | undefined): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : null;
}

/** Extract tool use blocks from an assistant message's content blocks. */
function extractToolUses(
  content: string | JsonlContentBlock[] | undefined,
): Array<{ name: string; input: Record<string, unknown> }> {
  if (!Array.isArray(content)) return [];

  const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const block of content) {
    if (block.type === "tool_use" && typeof block.name === "string") {
      tools.push({
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return tools;
}

/** Check if a JSONL entry represents a permission request. */
function isPermissionRequest(entry: JsonlEntry): boolean {
  if (entry.type === "permission_request") return true;
  if (entry.subtype === "permission_request") return true;
  return false;
}

/** Check if a JSONL entry represents an input request (Claude asking a question). */
function isInputRequest(entry: JsonlEntry): boolean {
  // Claude asks questions via assistant messages with subtype "input_request"
  if (entry.subtype === "input_request") return true;
  return false;
}

// =============================================================================
// JSONL File Reading
// =============================================================================

/**
 * Read a JSONL file starting from a byte offset.
 * Returns the raw content and total bytes read.
 */
async function readJsonlContent(
  filePath: string,
  fromByte: number,
): Promise<{ content: string; bytesRead: number } | null> {
  try {
    const fileStat = await stat(filePath);
    const fileSize = fileStat.size;

    if (fileSize <= fromByte) {
      return { content: "", bytesRead: fromByte };
    }

    if (fromByte === 0) {
      const content = await readFile(filePath, "utf-8");
      return { content, bytesRead: fileSize };
    }

    // Read from offset using file handle
    const handle = await open(filePath, "r");
    try {
      const length = fileSize - fromByte;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, fromByte);
      return { content: buffer.toString("utf-8"), bytesRead: fileSize };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

// =============================================================================
// Main Parser
// =============================================================================

/**
 * Parse a Claude Code JSONL session file and extract structured messages.
 *
 * @param filePath - Path to the JSONL file
 * @param fromByte - Byte offset to start reading from (for incremental reads)
 * @returns Parsed messages and total bytes read, or empty result on failure
 */
export function parseJsonlMessages(filePath: string, fromByte = 0): Promise<ParseResult> {
  return parseJsonlMessagesAsync(filePath, fromByte);
}

async function parseJsonlMessagesAsync(filePath: string, fromByte: number): Promise<ParseResult> {
  const result = await readJsonlContent(filePath, fromByte);
  if (!result) {
    return { messages: [], bytesRead: 0 };
  }

  const { content, bytesRead } = result;
  if (!content) {
    return { messages: [], bytesRead };
  }

  // When reading mid-file, skip the potentially truncated first line
  const firstNewline = content.indexOf("\n");
  const safeContent =
    fromByte > 0 && firstNewline >= 0 ? content.slice(firstNewline + 1) : content;

  const messages: ParsedMessage[] = [];

  for (const line of safeContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: JsonlEntry;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      entry = parsed as JsonlEntry;
    } catch {
      // Skip malformed lines — per CLAUDE.md: "Always wrap JSON.parse in try/catch"
      continue;
    }

    const timestamp = entry.timestamp ?? new Date().toISOString();

    // Priority order: permission_request > input_request > tool_use > assistant text
    // This ensures specialized types are detected before generic ones.

    // 1. Permission requests
    if (isPermissionRequest(entry)) {
      const permContent =
        entry.permission_prompt ??
        extractAssistantText(entry.message?.content) ??
        "Permission requested";
      messages.push({
        type: "permission_request" as MessageType,
        content: permContent,
        metadata: {},
        timestamp,
      });
      continue;
    }

    // 2. Input requests (Claude asking a question)
    if (isInputRequest(entry)) {
      const questionContent =
        extractAssistantText(entry.message?.content) ?? "Waiting for input";
      messages.push({
        type: "input_request" as MessageType,
        content: questionContent,
        metadata: {},
        timestamp,
      });
      continue;
    }

    // 3. Tool use entries
    if (entry.type === "tool_use") {
      const toolName = entry.tool_name ?? "unknown";
      const toolInput = entry.tool_input ?? {};
      messages.push({
        type: "tool_summary" as MessageType,
        content: formatToolSummary(toolName, toolInput),
        metadata: { toolName, toolInput },
        timestamp,
      });
      continue;
    }

    // 4. Assistant messages — may contain text and/or tool_use blocks
    if (entry.type === "assistant" && entry.message?.role === "assistant") {
      const msgContent = entry.message.content;

      // Extract tool uses from content blocks
      const toolUses = extractToolUses(msgContent);
      for (const tool of toolUses) {
        messages.push({
          type: "tool_summary" as MessageType,
          content: formatToolSummary(tool.name, tool.input),
          metadata: { toolName: tool.name, toolInput: tool.input },
          timestamp,
        });
      }

      // Extract text content
      const text = extractAssistantText(msgContent);
      if (text) {
        messages.push({
          type: "text_response" as MessageType,
          content: text,
          metadata: {},
          timestamp,
        });
      }
      continue;
    }

    // 5. User messages
    if (entry.type === "user" && entry.message?.role === "user") {
      // Skip system-generated meta entries (e.g. local-command-caveat)
      if (entry.isMeta) continue;

      const msgContent = entry.message.content;

      // Skip tool_result arrays — these are internal plumbing, not human input
      if (Array.isArray(msgContent)) {
        const hasToolResult = msgContent.some(
          (b) => typeof b === "object" && b !== null && b.type === "tool_result",
        );
        if (hasToolResult) continue;
      }

      const text = extractAssistantText(msgContent);
      if (text) {
        // Filter out system-injected interrupt messages
        if (text.startsWith("[Request interrupted")) continue;

        // Check if images are attached
        const hasImages =
          Array.isArray(msgContent) &&
          msgContent.some((b) => typeof b === "object" && b !== null && b.type === "image");

        messages.push({
          type: "user_message" as MessageType,
          content: text,
          metadata: hasImages ? { hasImages: true } : {},
          timestamp,
        });
      }
    }
  }

  return { messages, bytesRead };
}
