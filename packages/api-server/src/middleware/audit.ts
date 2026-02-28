import { mkdirSync, createWriteStream, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Request, Response, NextFunction } from "express";

const DEFAULT_AUDIT_DIR = join(homedir(), ".claude-commander");
const AUDIT_LOG_NAME = "audit.log";

let stream: WriteStream | undefined;

/**
 * Initialise the append-only write stream.
 * Creates the directory and file if they don't exist.
 * Called once — the stream is kept open for the lifetime of the process.
 */
function ensureStream(auditDir: string): WriteStream {
  if (stream) return stream;

  const auditLogPath = join(auditDir, AUDIT_LOG_NAME);

  mkdirSync(auditDir, { recursive: true });
  stream = createWriteStream(auditLogPath, { flags: "a" });

  stream.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`[audit] write-stream error: ${String(err)}`);
  });

  return stream;
}

/**
 * Create the audit-log middleware for a given log directory.
 *
 * Every request is logged in the format:
 *   [ISO-timestamp] METHOD /path SOURCE_IP STATUS_CODE RESPONSE_TIME_MS
 *
 * Must be mounted BEFORE auth middleware so that failed auth (401)
 * attempts are also captured.
 */
export function createAuditLog(
  auditDir: string = DEFAULT_AUDIT_DIR,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ws = ensureStream(auditDir);
    const startMs = Date.now();

    res.on("finish", () => {
      const durationMs = Date.now() - startMs;
      const ip = req.ip ?? req.socket.remoteAddress ?? "-";
      const line = `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${ip} ${String(res.statusCode)} ${String(durationMs)}ms\n`;
      ws.write(line);
    });

    next();
  };
}

/** Default middleware using ~/.claude-commander/audit.log */
export const auditLog = createAuditLog();

/**
 * Gracefully close the audit log stream.
 * Call on server shutdown to flush pending writes.
 */
export function closeAuditLog(): void {
  if (stream) {
    stream.end();
    stream = undefined;
  }
}
