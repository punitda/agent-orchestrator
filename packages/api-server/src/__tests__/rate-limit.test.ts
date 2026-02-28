import type { Server } from "node:http";

import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { rateLimiter } from "../middleware/rate-limit.js";

// Minimal Express app for testing rate limiting in isolation.
function createTestApp() {
  const app = express();
  app.use(rateLimiter);
  app.get("/test", (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function request(port: number, path = "/test") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

describe("rate limiter", () => {
  let server: Server;
  let port: number;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        const app = createTestApp();
        server = app.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          port = typeof addr === "object" && addr !== null ? addr.port : 0;
          resolve();
        });
      }),
  );

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  beforeEach(() => {
    // Reset the rate limiter store between tests so each test gets a clean window.
    rateLimiter.resetKey("127.0.0.1");
  });

  it("allows requests within the limit", async () => {
    const res = await request(port);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("includes RateLimit-* standard headers", async () => {
    const res = await request(port);
    expect(res.headers.get("ratelimit-limit")).toBe("60");
    expect(res.headers.get("ratelimit-remaining")).toBeDefined();
    expect(res.headers.get("ratelimit-reset")).toBeDefined();
  });

  it("does not include legacy X-RateLimit-* headers", async () => {
    const res = await request(port);
    expect(res.headers.get("x-ratelimit-limit")).toBeNull();
    expect(res.headers.get("x-ratelimit-remaining")).toBeNull();
  });

  it("returns 429 with correct body after exceeding 60 requests", async () => {
    // Fire 60 allowed requests
    const promises = Array.from({ length: 60 }, () => request(port));
    const results = await Promise.all(promises);
    for (const r of results) {
      expect(r.status).toBe(200);
    }

    // 61st request should be rate limited
    const blocked = await request(port);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      error: "Too many requests",
      code: "RATE_LIMITED",
    });
  });

  it("includes Retry-After header on 429 response", async () => {
    // Exhaust the limit
    const promises = Array.from({ length: 60 }, () => request(port));
    await Promise.all(promises);

    const blocked = await request(port);
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).toBeDefined();
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  it("rate limits all endpoints equally", async () => {
    // Exhaust the limit on /test
    const promises = Array.from({ length: 60 }, () => request(port));
    await Promise.all(promises);

    // A request to a different path should also be rate limited
    const res = await request(port, "/other");
    expect(res.status).toBe(429);
  });
});
