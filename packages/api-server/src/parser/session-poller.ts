/**
 * Incremental JSONL poller with byte-offset tracking.
 *
 * Runs a `setInterval` per active session that reads only the bytes
 * appended since the last poll, parses them with `parseJsonlMessages`,
 * and emits the resulting messages via an EventEmitter.
 *
 * Handles file rotation (size shrinks below tracked offset → reset to 0),
 * auto-stops for sessions in terminal states, and cleans up timers on
 * `stop()` / `stopAll()`.
 */

import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import type { ParsedMessage } from "@composio/ao-core";
import { parseJsonlMessages } from "./jsonl-parser.js";

// =============================================================================
// Types
// =============================================================================

/** Per-session tracking state */
interface SessionState {
  timer: ReturnType<typeof setInterval>;
  byteOffset: number;
  jsonlPath: string | null;
}

/** Options for creating a SessionPoller */
export interface SessionPollerOptions {
  /** Polling interval in milliseconds (default: 10 000) */
  intervalMs?: number;
  /** Resolve the JSONL file path for a given session ID. Returns null if not found. */
  resolveJsonlPath: (sessionId: string) => Promise<string | null>;
  /** Check whether a session is in a terminal state (done, errored, exited, etc.) */
  isSessionTerminal: (sessionId: string) => Promise<boolean>;
}

/** Event payloads emitted by SessionPoller */
export interface SessionPollerEvents {
  messages: [sessionId: string, messages: ParsedMessage[]];
  error: [sessionId: string, error: Error];
}

// Default polling interval: 10 seconds
const DEFAULT_INTERVAL_MS = 10_000;

// =============================================================================
// SessionPoller
// =============================================================================

export class SessionPoller extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly intervalMs: number;
  private readonly resolveJsonlPath: SessionPollerOptions["resolveJsonlPath"];
  private readonly isSessionTerminal: SessionPollerOptions["isSessionTerminal"];

  constructor(options: SessionPollerOptions) {
    super();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.resolveJsonlPath = options.resolveJsonlPath;
    this.isSessionTerminal = options.isSessionTerminal;
  }

  /** Start polling for a session. No-op if already polling. */
  start(sessionId: string): void {
    if (this.sessions.has(sessionId)) return;

    const state: SessionState = {
      timer: setInterval(() => void this.pollOnce(sessionId), this.intervalMs),
      byteOffset: 0,
      jsonlPath: null,
    };

    this.sessions.set(sessionId, state);
  }

  /** Stop polling for a session. No-op if not polling. */
  stop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    clearInterval(state.timer);
    this.sessions.delete(sessionId);
  }

  /** Stop polling for all sessions. */
  stopAll(): void {
    for (const [, state] of this.sessions) {
      clearInterval(state.timer);
    }
    this.sessions.clear();
  }

  /** Returns the set of session IDs currently being polled. */
  get activeSessionIds(): ReadonlySet<string> {
    return new Set(this.sessions.keys());
  }

  /**
   * Execute a single poll cycle for a session.
   *
   * Normally called automatically by the interval timer, but can also
   * be called directly (e.g. from tests or to trigger an immediate refresh).
   */
  async pollOnce(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (!state) return;

    try {
      // Auto-stop if session reached a terminal state
      const terminal = await this.isSessionTerminal(sessionId);
      if (terminal) {
        this.stop(sessionId);
        return;
      }

      // Lazily resolve JSONL path on the first poll (or re-resolve after deletion)
      if (!state.jsonlPath) {
        state.jsonlPath = await this.resolveJsonlPath(sessionId);
        if (!state.jsonlPath) return; // File not available yet
        // New or changed file — start reading from the beginning
        state.byteOffset = 0;
      }

      // Check file size for rotation detection / skip-if-unchanged
      let fileSize: number;
      try {
        const fileStat = await stat(state.jsonlPath);
        fileSize = fileStat.size;
      } catch {
        // File may have been deleted; clear the cached path so it's re-resolved next tick
        state.jsonlPath = null;
        return;
      }

      // File rotation: size shrank below our offset → reset
      if (fileSize < state.byteOffset) {
        state.byteOffset = 0;
      }

      // No new bytes → skip
      if (fileSize === state.byteOffset) return;

      // The JSONL parser skips the first line when reading from a non-zero
      // offset (to protect against truncated lines in mid-file reads).
      // To avoid losing the first appended line, back up 1 byte so the
      // parser's skip consumes the previous trailing newline instead.
      const readOffset = state.byteOffset > 0 ? state.byteOffset - 1 : 0;

      // Parse new content
      const result = await parseJsonlMessages(state.jsonlPath, readOffset);

      // Advance cursor to actual file position
      state.byteOffset = result.bytesRead;

      // Emit only if there are messages
      if (result.messages.length > 0) {
        this.emit("messages", sessionId, result.messages);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", sessionId, error);
    }
  }
}
