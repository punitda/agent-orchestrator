import type { Server } from "node:http";

import type {
  Session,
  SessionManager,
  PluginRegistry,
  OrchestratorConfig,
  SCM,
  Agent,
  PRInfo,
  CIStatus,
  ReviewDecision,
  MergeReadiness,
  AgentSessionInfo,
} from "@composio/ao-core";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Services } from "../../services.js";
import type { SessionResponse, SessionDetailResponse } from "../../types.js";
import { sessionsRouter } from "../sessions.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

const TEST_PR: PRInfo = {
  number: 42,
  url: "https://github.com/test/repo/pull/42",
  title: "feat: add feature",
  owner: "test",
  repo: "repo",
  branch: "feat/test",
  baseBranch: "main",
  isDraft: false,
};

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

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  const { id, ...rest } = overrides;
  return {
    id,
    projectId: "test-project",
    status: "working",
    activity: "active",
    branch: "feat/test",
    issueId: null,
    pr: null,
    workspacePath: "/tmp/ws",
    runtimeHandle: null,
    agentInfo: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    lastActivityAt: new Date("2025-01-01T01:00:00Z"),
    metadata: {},
    ...rest,
  };
}

function makeConfig(
  overrides?: Partial<OrchestratorConfig>,
): OrchestratorConfig {
  return {
    configPath: "/tmp/config.yaml",
    readyThresholdMs: 300_000,
    defaults: {
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    },
    projects: {
      "test-project": {
        name: "Test Project",
        repo: "test/repo",
        path: "/tmp/test",
        defaultBranch: "main",
        sessionPrefix: "test",
        scm: { plugin: "github" },
        tracker: { plugin: "github" },
        agent: "claude-code",
      },
    },
    notifiers: {},
    notificationRouting: {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    },
    reactions: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// List endpoint helpers (from main)
// ---------------------------------------------------------------------------

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

// ===========================================================================
// GET /api/v1/sessions — list all sessions
// ===========================================================================

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

// ===========================================================================
// GET /api/v1/sessions/:id — session detail
// ===========================================================================

describe("GET /api/v1/sessions/:id", () => {
  describe("basic session lookup", () => {
    let server: Server;
    let port: number;
    const testSession = makeSession({ id: "test-1" });

    beforeAll(async () => {
      const mockSessionManager: Partial<SessionManager> = {
        get: vi.fn(async (id: string) => (id === "test-1" ? testSession : null)),
      };
      const mockRegistry = {
        get: vi.fn(() => null),
        list: vi.fn(() => []),
      } as unknown as PluginRegistry;

      const services: Services = {
        config: makeConfig(),
        registry: mockRegistry,
        sessionManager: mockSessionManager as SessionManager,
      };

      const app = express();
      app.locals["services"] = services;
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("returns 200 with session data for an existing session", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/test-1`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session).toBeDefined();
      expect(body.session.id).toBe("test-1");
      expect(body.session.projectId).toBe("test-project");
      expect(body.session.status).toBe("working");
      expect(body.session.activity).toBe("active");
      expect(body.session.branch).toBe("feat/test");
      expect(body.session.createdAt).toBe("2025-01-01T00:00:00.000Z");
      expect(body.session.lastActivityAt).toBe("2025-01-01T01:00:00.000Z");
    });

    it("returns agentInfo with summary and cost as null when no agent data", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/test-1`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.agentInfo).toEqual({ summary: null, cost: null });
    });

    it("returns pr as null when session has no PR", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/test-1`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.pr).toBeNull();
    });

    it("returns 404 when session does not exist", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/nonexistent`);
      expect(res.status).toBe(404);

      const body = (await res.json()) as { error: string; code: string };
      expect(body.error).toBe("Session not found");
      expect(body.code).toBe("NOT_FOUND");
    });

    it("returns Content-Type application/json", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/test-1`);
      expect(res.headers.get("content-type")).toContain("application/json");
    });
  });

  // -------------------------------------------------------------------------
  // Services not ready
  // -------------------------------------------------------------------------

  describe("when services are not ready", () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      const app = express();
      // No services set — simulates pre-initialization
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("returns 503 SERVICE_UNAVAILABLE", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/test-1`);
      expect(res.status).toBe(503);

      const body = (await res.json()) as { error: string; code: string };
      expect(body.code).toBe("SERVICE_UNAVAILABLE");
    });
  });

  // -------------------------------------------------------------------------
  // With PR enrichment
  // -------------------------------------------------------------------------

  describe("with PR enrichment", () => {
    let server: Server;
    let port: number;

    const sessionWithPR = makeSession({
      id: "pr-session",
      pr: TEST_PR,
    });

    const mockSCM: Partial<SCM> = {
      name: "github",
      getCISummary: vi.fn(async () => "passing" as CIStatus),
      getReviewDecision: vi.fn(async () => "approved" as ReviewDecision),
      getMergeability: vi.fn(
        async () =>
          ({
            mergeable: true,
            ciPassing: true,
            approved: true,
            noConflicts: true,
            blockers: [],
          }) satisfies MergeReadiness,
      ),
    };

    const mockAgent: Partial<Agent> = {
      name: "claude-code",
      getSessionInfo: vi.fn(
        async () =>
          ({
            summary: "Working on feature",
            agentSessionId: "agent-123",
            cost: {
              inputTokens: 1000,
              outputTokens: 500,
              estimatedCostUsd: 0.05,
            },
          }) satisfies AgentSessionInfo,
      ),
    };

    beforeAll(async () => {
      const mockSessionManager: Partial<SessionManager> = {
        get: vi.fn(async (id: string) => (id === "pr-session" ? sessionWithPR : null)),
      };

      const mockRegistry = {
        get: vi.fn((slot: string, name: string) => {
          if (slot === "scm" && name === "github") return mockSCM;
          if (slot === "agent" && name === "claude-code") return mockAgent;
          return null;
        }),
        list: vi.fn(() => []),
      } as unknown as PluginRegistry;

      const services: Services = {
        config: makeConfig(),
        registry: mockRegistry,
        sessionManager: mockSessionManager as SessionManager,
      };

      const app = express();
      app.locals["services"] = services;
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("enriches PR with CI status, review decision, and mergeability", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/pr-session`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: SessionDetailResponse };
      const pr = body.session.pr;
      expect(pr).not.toBeNull();
      expect(pr!.ciStatus).toBe("passing");
      expect(pr!.reviewDecision).toBe("approved");
      expect(pr!.mergeable).toBe(true);
    });

    it("includes basic PR fields", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/pr-session`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      const pr = body.session.pr;
      expect(pr!.number).toBe(42);
      expect(pr!.url).toBe("https://github.com/test/repo/pull/42");
      expect(pr!.state).toBe("open");
    });

    it("enriches agent cost data", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/pr-session`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.agentInfo.cost).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.05,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Enrichment timeout — partial data
  // -------------------------------------------------------------------------

  describe("enrichment timeout returns partial data", () => {
    let server: Server;
    let port: number;

    const sessionWithPR = makeSession({
      id: "slow-session",
      pr: TEST_PR,
    });

    beforeAll(async () => {
      const mockSessionManager: Partial<SessionManager> = {
        get: vi.fn(async (id: string) => (id === "slow-session" ? sessionWithPR : null)),
      };

      // SCM that takes longer than 3 seconds
      const slowSCM: Partial<SCM> = {
        name: "github",
        getCISummary: vi.fn(
          () => new Promise<CIStatus>((resolve) => setTimeout(() => resolve("passing"), 5_000)),
        ),
        getReviewDecision: vi.fn(
          () =>
            new Promise<ReviewDecision>((resolve) => setTimeout(() => resolve("approved"), 5_000)),
        ),
        getMergeability: vi.fn(
          () =>
            new Promise<MergeReadiness>((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    mergeable: true,
                    ciPassing: true,
                    approved: true,
                    noConflicts: true,
                    blockers: [],
                  }),
                5_000,
              ),
            ),
        ),
      };

      // Agent returns quickly
      const fastAgent: Partial<Agent> = {
        name: "claude-code",
        getSessionInfo: vi.fn(
          async () =>
            ({
              summary: "Quick summary",
              agentSessionId: "agent-456",
              cost: { inputTokens: 200, outputTokens: 100, estimatedCostUsd: 0.01 },
            }) satisfies AgentSessionInfo,
        ),
      };

      const mockRegistry = {
        get: vi.fn((slot: string, name: string) => {
          if (slot === "scm" && name === "github") return slowSCM;
          if (slot === "agent" && name === "claude-code") return fastAgent;
          return null;
        }),
        list: vi.fn(() => []),
      } as unknown as PluginRegistry;

      const services: Services = {
        config: makeConfig(),
        registry: mockRegistry,
        sessionManager: mockSessionManager as SessionManager,
      };

      const app = express();
      app.locals["services"] = services;
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("returns partial data when enrichment times out", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/slow-session`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: SessionDetailResponse };

      // Session base data should be present
      expect(body.session.id).toBe("slow-session");

      // PR should have base fields but enrichment defaults (timeout)
      expect(body.session.pr).not.toBeNull();
      expect(body.session.pr!.number).toBe(42);
      // CI/review/merge will have defaults since SCM timed out
      expect(body.session.pr!.ciStatus).toBe("none");
      expect(body.session.pr!.reviewDecision).toBe("none");
      expect(body.session.pr!.mergeable).toBe(false);

      // Agent cost should still be present (fast response)
      expect(body.session.agentInfo.cost).toEqual({
        inputTokens: 200,
        outputTokens: 100,
        estimatedCostUsd: 0.01,
      });
    }, 10_000);
  });

  // -------------------------------------------------------------------------
  // Enrichment failure — graceful degradation
  // -------------------------------------------------------------------------

  describe("enrichment failure returns defaults gracefully", () => {
    let server: Server;
    let port: number;

    const sessionWithPR = makeSession({
      id: "error-session",
      pr: TEST_PR,
    });

    beforeAll(async () => {
      const mockSessionManager: Partial<SessionManager> = {
        get: vi.fn(async (id: string) => (id === "error-session" ? sessionWithPR : null)),
      };

      // SCM that throws errors
      const failingSCM: Partial<SCM> = {
        name: "github",
        getCISummary: vi.fn(async () => {
          throw new Error("GitHub API rate limited");
        }),
        getReviewDecision: vi.fn(async () => {
          throw new Error("GitHub API rate limited");
        }),
        getMergeability: vi.fn(async () => {
          throw new Error("GitHub API rate limited");
        }),
      };

      // Agent also fails
      const failingAgent: Partial<Agent> = {
        name: "claude-code",
        getSessionInfo: vi.fn(async () => {
          throw new Error("Agent data unavailable");
        }),
      };

      const mockRegistry = {
        get: vi.fn((slot: string, name: string) => {
          if (slot === "scm" && name === "github") return failingSCM;
          if (slot === "agent" && name === "claude-code") return failingAgent;
          return null;
        }),
        list: vi.fn(() => []),
      } as unknown as PluginRegistry;

      const services: Services = {
        config: makeConfig(),
        registry: mockRegistry,
        sessionManager: mockSessionManager as SessionManager,
      };

      const app = express();
      app.locals["services"] = services;
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("returns 200 with default enrichment values when plugins fail", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/error-session`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.id).toBe("error-session");
      expect(body.session.pr!.ciStatus).toBe("none");
      expect(body.session.pr!.reviewDecision).toBe("none");
      expect(body.session.pr!.mergeable).toBe(false);
      expect(body.session.agentInfo.cost).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Summary extraction
  // -------------------------------------------------------------------------

  describe("summary extraction", () => {
    let server: Server;
    let port: number;

    const sessionWithAgentSummary = makeSession({
      id: "summary-session",
      agentInfo: {
        summary: "Implementing user auth",
        agentSessionId: "a-1",
      },
    });

    const sessionWithMetadataSummary = makeSession({
      id: "meta-session",
      metadata: { summary: "From metadata" },
    });

    beforeAll(async () => {
      const sessions = [sessionWithAgentSummary, sessionWithMetadataSummary];

      const mockSessionManager: Partial<SessionManager> = {
        get: vi.fn(async (id: string) => sessions.find((s) => s.id === id) ?? null),
      };

      const mockRegistry = {
        get: vi.fn(() => null),
        list: vi.fn(() => []),
      } as unknown as PluginRegistry;

      const services: Services = {
        config: makeConfig(),
        registry: mockRegistry,
        sessionManager: mockSessionManager as SessionManager,
      };

      const app = express();
      app.locals["services"] = services;
      app.use(sessionsRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("uses agentInfo.summary when available", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/summary-session`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.agentInfo.summary).toBe("Implementing user auth");
    });

    it("falls back to metadata summary", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/meta-session`);
      const body = (await res.json()) as { session: SessionDetailResponse };
      expect(body.session.agentInfo.summary).toBe("From metadata");
    });
  });
});
