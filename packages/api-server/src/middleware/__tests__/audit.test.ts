import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createAuditLog, closeAuditLog } from "../audit.js";

/**
 * Helper: start the express app and return a running server + port.
 */
function startApp(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("audit logging middleware", () => {
  let tmpDir: string;
  let auditDir: string;
  let server: Server | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    auditDir = join(tmpDir, ".claude-commander");
  });

  afterEach(async () => {
    closeAuditLog();
    if (server) {
      await stopServer(server);
      server = undefined;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates audit directory and audit.log on first request", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    app.get("/health", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/health`);

    // Give the write stream a moment to flush
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    expect(existsSync(logPath)).toBe(true);
  });

  it("logs request in the expected format", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    app.get("/api/v1/sessions", (_req, res) => {
      res.status(200).json({ sessions: [] });
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/api/v1/sessions`);
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    // [ISO-timestamp] METHOD /path SOURCE_IP STATUS_CODE RESPONSE_TIME_MS
    expect(content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z\] GET \/api\/v1\/sessions .+ 200 \d+ms\n$/,
    );
  });

  it("logs POST requests with correct method", async () => {
    const app = express();
    app.use(express.json());
    app.use(createAuditLog(auditDir));
    app.post("/api/v1/sessions", (_req, res) => {
      res.status(201).json({ id: "s-1" });
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toContain("POST /api/v1/sessions");
    expect(content).toContain("201");
  });

  it("logs 401 responses (failed auth)", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    // Simulate auth middleware that rejects
    app.use((_req, res) => {
      res.status(401).json({ error: "Unauthorized" });
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/api/v1/sessions`);
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toContain("401");
  });

  it("logs 404 responses", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    // No routes defined — Express returns 404

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/nonexistent`);
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).toContain("GET /nonexistent");
    expect(content).toContain("404");
  });

  it("does NOT log request bodies or response bodies", async () => {
    const secretPayload = "SUPER_SECRET_API_KEY_12345";

    const app = express();
    app.use(express.json());
    app.use(createAuditLog(auditDir));
    app.post("/api/v1/sessions", (_req, res) => {
      res.status(200).json({ secret: secretPayload });
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: secretPayload }),
    });
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    expect(content).not.toContain(secretPayload);
  });

  it("appends multiple log lines for successive requests", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    app.get("/a", (_req, res) => res.sendStatus(200));
    app.get("/b", (_req, res) => res.sendStatus(200));

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/a`);
    await fetch(`http://127.0.0.1:${result.port}/b`);
    await new Promise((r) => setTimeout(r, 50));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("GET /a");
    expect(lines[1]).toContain("GET /b");
  });

  it("includes response time in milliseconds", async () => {
    const app = express();
    app.use(createAuditLog(auditDir));
    app.get("/slow", (_req, res) => {
      // Introduce a small delay
      setTimeout(() => res.sendStatus(200), 30);
    });

    const result = await startApp(app);
    server = result.server;

    await fetch(`http://127.0.0.1:${result.port}/slow`);
    await new Promise((r) => setTimeout(r, 100));

    const logPath = join(auditDir, "audit.log");
    const content = readFileSync(logPath, "utf-8");

    // Extract duration — should be at least 20ms given the 30ms delay
    const match = content.match(/(\d+)ms/);
    expect(match).not.toBeNull();
    const duration = parseInt(match![1]!, 10);
    expect(duration).toBeGreaterThanOrEqual(20);
  });
});
