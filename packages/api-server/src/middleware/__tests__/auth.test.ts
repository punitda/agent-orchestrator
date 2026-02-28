import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bcrypt from "bcrypt";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createAuthMiddleware, loadKeyHash } from "../auth.js";

// Plaintext fixture used only in tests — not a real secret.
const TEST_PLAINTEXT = "test-plaintext-for-unit-tests";
const BCRYPT_COST = 4; // Low cost for fast tests

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

// ─── loadKeyHash ───────────────────────────────────────────────

describe("loadKeyHash", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "auth-load-test-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the hash from a valid auth.json", async () => {
    const hash = await bcrypt.hash("some-key", BCRYPT_COST);
    const authFile = join(tmpDir, "valid-auth.json");
    writeFileSync(authFile, JSON.stringify({ keyHash: hash }));

    expect(loadKeyHash(authFile)).toBe(hash);
  });

  it("returns null when file does not exist", () => {
    expect(loadKeyHash(join(tmpDir, "nonexistent.json"))).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    const authFile = join(tmpDir, "bad-json.json");
    writeFileSync(authFile, "not json at all");

    expect(loadKeyHash(authFile)).toBeNull();
  });

  it("returns null when keyHash field is missing", () => {
    const authFile = join(tmpDir, "missing-field.json");
    writeFileSync(authFile, JSON.stringify({ other: "value" }));

    expect(loadKeyHash(authFile)).toBeNull();
  });

  it("returns null when keyHash is empty string", () => {
    const authFile = join(tmpDir, "empty-hash.json");
    writeFileSync(authFile, JSON.stringify({ keyHash: "" }));

    expect(loadKeyHash(authFile)).toBeNull();
  });

  it("returns null when keyHash is not a string", () => {
    const authFile = join(tmpDir, "wrong-type.json");
    writeFileSync(authFile, JSON.stringify({ keyHash: 12345 }));

    expect(loadKeyHash(authFile)).toBeNull();
  });
});

// ─── createAuthMiddleware (with valid keyHash) ─────────────────

describe("auth middleware — configured", () => {
  let keyHash: string;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    keyHash = await bcrypt.hash(TEST_PLAINTEXT, BCRYPT_COST);

    const app = express();
    app.use(createAuthMiddleware(keyHash));
    app.get("/api/v1/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.get("/api/v1/sessions", (_req, res) => {
      res.json({ sessions: [] });
    });
    app.post("/api/v1/sessions", (_req, res) => {
      res.status(201).json({ id: "s-1" });
    });

    const result = await startApp(app);
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it("allows GET /api/v1/health without an API key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("rejects requests without x-api-key header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`);
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toEqual({
      error: "Unauthorized",
      code: "MISSING_API_KEY",
    });
  });

  it("rejects requests with empty x-api-key header", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": "" },
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toEqual({
      error: "Unauthorized",
      code: "MISSING_API_KEY",
    });
  });

  it("rejects requests with an invalid API key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body).toEqual({
      error: "Unauthorized",
      code: "INVALID_API_KEY",
    });
  });

  it("allows requests with a valid API key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": TEST_PLAINTEXT },
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ sessions: [] });
  });

  it("allows POST requests with a valid API key", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TEST_PLAINTEXT,
      },
      body: JSON.stringify({ name: "test" }),
    });
    expect(res.status).toBe(201);
  });

  it("returns identical 401 bodies for wrong key vs. malformed key (no info leakage)", async () => {
    const wrongKey = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": "completely-wrong-key-value" },
    });
    const wrongBody = await wrongKey.json();

    const malformedKey = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": "x" },
    });
    const malformedBody = await malformedKey.json();

    // Both should be 401 with INVALID_API_KEY — no difference
    expect(wrongKey.status).toBe(401);
    expect(malformedKey.status).toBe(401);
    expect(wrongBody).toEqual(malformedBody);
    expect(wrongBody).toEqual({
      error: "Unauthorized",
      code: "INVALID_API_KEY",
    });
  });
});

// ─── createAuthMiddleware (auth not configured) ────────────────

describe("auth middleware — not configured (null keyHash)", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.use(createAuthMiddleware(null));
    app.get("/api/v1/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.get("/api/v1/sessions", (_req, res) => {
      res.json({ sessions: [] });
    });

    const result = await startApp(app);
    server = result.server;
    port = result.port;
  });

  afterAll(async () => {
    await stopServer(server);
  });

  it("still allows GET /api/v1/health without auth configured", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it("returns 500 AUTH_NOT_CONFIGURED for non-health routes", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`);
    expect(res.status).toBe(500);

    const body = await res.json();
    expect(body).toEqual({
      error: "API key not configured. Run generate-key first.",
      code: "AUTH_NOT_CONFIGURED",
    });
  });

  it("returns 500 even when x-api-key header is provided", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, {
      headers: { "x-api-key": "some-key" },
    });
    expect(res.status).toBe(500);

    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTH_NOT_CONFIGURED");
  });
});
