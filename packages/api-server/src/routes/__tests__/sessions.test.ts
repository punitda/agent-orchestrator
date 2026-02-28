import type { Server } from "node:http";

import type { Session } from "@composio/ao-core";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SessionResponse } from "../../types.js";
import { sessionsRouter } from "../sessions.js";

function makeFakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "test-1",
    projectId: "proj-1",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: "PUN-1",
    pr: null,
    workspacePath: "/tmp/workspace",
    runtimeHandle: { id: "handle-1", runtimeName: "tmux", data: {} },
    agentInfo: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    lastActivityAt: new Date("2026-01-01T12:00:00Z"),
    metadata: { summary: "test summary" },
    ...overrides,
  };
}

interface SessionsBody {
  sessions?: SessionResponse[];
  error?: string;
  code?: string;
}

async function request(port: number, query = "") {
  const url = `http://127.0.0.1:${port}/api/v1/sessions${query}`;
  const res = await fetch(url);
  const body = (await res.json()) as SessionsBody;
  return { status: res.status, body };
}

describe("GET /api/v1/sessions", () => {
  describe("when services are initialized with sessions", () => {
    let server: Server;
    let port: number;

    const sessions: Session[] = [
      makeFakeSession({
        id: "proj-1",
        projectId: "alpha",
        lastActivityAt: new Date("2026-01-01T10:00:00Z"),
      }),
      makeFakeSession({
        id: "proj-2",
        projectId: "beta",
        lastActivityAt: new Date("2026-01-01T14:00:00Z"),
        pr: {
          number: 42,
          url: "https://github.com/org/repo/pull/42",
          title: "Add feature",
          owner: "org",
          repo: "repo",
          branch: "feat/test",
          baseBranch: "main",
          isDraft: false,
        },
        agentInfo: {
          summary: "Implementing new feature",
          agentSessionId: "agent-123",
        },
      }),
      makeFakeSession({
        id: "proj-3",
        projectId: "alpha",
        lastActivityAt: new Date("2026-01-01T16:00:00Z"),
        agentInfo: {
          summary: null,
          agentSessionId: "agent-456",
        },
      }),
    ];

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          const app = express();
          app.use(sessionsRouter);
          app.locals["services"] = {
            config: {},
            registry: {},
            sessionManager: {
              list: async () => sessions,
            },
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

    it("returns 200 with sessions array", async () => {
      const res = await request(port);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sessions)).toBe(true);
      expect(res.body.sessions).toHaveLength(3);
    });

    it("sorts sessions by lastActivityAt descending", async () => {
      const res = await request(port);
      const timestamps = res.body.sessions!.map((s) => s.lastActivityAt);
      expect(timestamps).toEqual([
        "2026-01-01T16:00:00.000Z",
        "2026-01-01T14:00:00.000Z",
        "2026-01-01T10:00:00.000Z",
      ]);
    });

    it("filters sessions by projectId query parameter", async () => {
      const res = await request(port, "?projectId=alpha");
      expect(res.body.sessions).toHaveLength(2);
      for (const s of res.body.sessions!) {
        expect(s.projectId).toBe("alpha");
      }
    });

    it("returns empty array for unknown projectId", async () => {
      const res = await request(port, "?projectId=nonexistent");
      expect(res.body.sessions).toHaveLength(0);
    });

    it("serializes dates as ISO strings", async () => {
      const res = await request(port);
      const session = res.body.sessions![0]!;
      expect(session.createdAt).toBe("2026-01-01T00:00:00.000Z");
      expect(typeof session.lastActivityAt).toBe("string");
    });

    it("includes basic PR info when available", async () => {
      const res = await request(port);
      // proj-2 has a PR (sorted second by lastActivityAt)
      const withPR = res.body.sessions!.find((s) => s.id === "proj-2")!;
      expect(withPR.pr).toEqual({
        number: 42,
        url: "https://github.com/org/repo/pull/42",
        state: "open",
      });
    });

    it("returns pr as null when no PR exists", async () => {
      const res = await request(port);
      const noPR = res.body.sessions!.find((s) => s.id === "proj-1")!;
      expect(noPR.pr).toBeNull();
    });

    it("includes agentInfo when summary is available", async () => {
      const res = await request(port);
      const withAgent = res.body.sessions!.find((s) => s.id === "proj-2")!;
      expect(withAgent.agentInfo).toEqual({
        summary: "Implementing new feature",
      });
    });

    it("returns agentInfo as null when summary is null", async () => {
      const res = await request(port);
      const nullSummary = res.body.sessions!.find((s) => s.id === "proj-3")!;
      expect(nullSummary.agentInfo).toBeNull();
    });

    it("returns agentInfo as null when agentInfo is absent", async () => {
      const res = await request(port);
      const noAgent = res.body.sessions!.find((s) => s.id === "proj-1")!;
      expect(noAgent.agentInfo).toBeNull();
    });

    it("does NOT expose internal fields", async () => {
      const res = await request(port);
      for (const session of res.body.sessions!) {
        expect("runtimeHandle" in session).toBe(false);
        expect("workspacePath" in session).toBe(false);
        expect("metadata" in session).toBe(false);
      }
    });

    it("includes expected fields in each session", async () => {
      const res = await request(port);
      const session = res.body.sessions![0]!;
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("projectId");
      expect(session).toHaveProperty("status");
      expect(session).toHaveProperty("activity");
      expect(session).toHaveProperty("branch");
      expect(session).toHaveProperty("issueId");
      expect(session).toHaveProperty("createdAt");
      expect(session).toHaveProperty("lastActivityAt");
      expect(session).toHaveProperty("pr");
      expect(session).toHaveProperty("agentInfo");
    });
  });

  describe("when services are not initialized", () => {
    let server: Server;
    let port: number;

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          const app = express();
          app.use(sessionsRouter);
          // No services set — simulates pre-initialization state
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

    it("returns 503 with SERVICE_UNAVAILABLE code", async () => {
      const res = await request(port);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("Service unavailable");
      expect(res.body.code).toBe("SERVICE_UNAVAILABLE");
    });
  });

  describe("when there are no sessions", () => {
    let server: Server;
    let port: number;

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          const app = express();
          app.use(sessionsRouter);
          app.locals["services"] = {
            config: {},
            registry: {},
            sessionManager: {
              list: async () => [],
            },
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

    it("returns 200 with empty sessions array", async () => {
      const res = await request(port);
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });
  });
});
