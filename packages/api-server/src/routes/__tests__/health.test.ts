import type { Server } from "node:http";

import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { healthRouter } from "../health.js";

async function request(port: number) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body };
}

describe("GET /api/v1/health", () => {
  describe("when services are initialized", () => {
    let server: Server;
    let port: number;

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          const app = express();
          app.use(healthRouter);
          app.locals["services"] = {
            config: {},
            registry: {},
            sessionManager: {},
          };
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

    it("returns 200 with status ok", async () => {
      const res = await request(port);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
    });

    it("includes uptime as an integer >= 0", async () => {
      const res = await request(port);
      expect(typeof res.body.uptime).toBe("number");
      expect(Number.isInteger(res.body.uptime)).toBe(true);
      expect(res.body.uptime as number).toBeGreaterThanOrEqual(0);
    });

    it("includes version string", async () => {
      const res = await request(port);
      expect(typeof res.body.version).toBe("string");
      expect((res.body.version as string).length).toBeGreaterThan(0);
    });

    it("returns Content-Type application/json", async () => {
      const res = await request(port);
      expect(res.headers.get("content-type")).toContain("application/json");
    });

    it("does not include error field when healthy", async () => {
      const res = await request(port);
      expect(res.body.error).toBeUndefined();
    });
  });

  describe("when session manager is not ready", () => {
    let server: Server;
    let port: number;

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          const app = express();
          app.use(healthRouter);
          // No services set in app.locals — simulates pre-initialization state
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

    it("returns 200 with status degraded", async () => {
      const res = await request(port);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("degraded");
      expect(res.body.error).toBe("Session manager not ready");
    });

    it("still includes uptime and version when degraded", async () => {
      const res = await request(port);
      expect(typeof res.body.uptime).toBe("number");
      expect(typeof res.body.version).toBe("string");
    });
  });
});
