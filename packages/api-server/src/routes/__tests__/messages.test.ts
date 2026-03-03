import type { Server } from "node:http";

import type {
  Session,
  SessionManager,
  PluginRegistry,
  OrchestratorConfig,
} from "@composio/ao-core";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type CommanderDatabase, type Message } from "../../database.js";
import type { Services } from "../../services.js";
import { messagesRouter } from "../messages.js";

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

function makeConfig(): OrchestratorConfig {
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
  };
}

async function postMessage(
  port: number,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(
    `http://127.0.0.1:${port}/api/v1/sessions/${sessionId}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body: json };
}

// ===========================================================================
// POST /api/v1/sessions/:id/messages
// ===========================================================================

describe("POST /api/v1/sessions/:id/messages", () => {
  // -------------------------------------------------------------------------
  // Successful message send
  // -------------------------------------------------------------------------
  describe("successful send", () => {
    let server: Server;
    let port: number;
    let db: CommanderDatabase;

    const activeSession = makeSession({ id: "sess-1", status: "working", activity: "active" });
    const mockGet = vi.fn(async () => activeSession);
    const mockSend = vi.fn(async () => {});

    beforeAll(async () => {
      db = createDatabase(":memory:");

      const services: Services = {
        config: makeConfig(),
        registry: {} as unknown as PluginRegistry,
        sessionManager: { get: mockGet, send: mockSend } as unknown as SessionManager,
        database: db,
      };

      const app = express();
      app.use(express.json());
      app.locals["services"] = services;
      app.use(messagesRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
      db.close();
    });

    beforeEach(() => {
      mockGet.mockClear();
      mockSend.mockClear();
    });

    it("returns 201 with the stored message", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: "Hello agent" });

      expect(status).toBe(201);
      const msg = body["message"] as Message;
      expect(msg).toBeDefined();
      expect(msg.session_id).toBe("sess-1");
      expect(msg.type).toBe("user_message");
      expect(msg.content).toBe("Hello agent");
      expect(msg.id).toBeGreaterThan(0);
    });

    it("calls sessionManager.send() with the text", async () => {
      await postMessage(port, "sess-1", { text: "Run the tests" });

      expect(mockSend).toHaveBeenCalledWith("sess-1", "Run the tests");
    });

    it("stores message in database before sending to runtime", async () => {
      const { body } = await postMessage(port, "sess-1", { text: "Check status" });
      const msg = body["message"] as Message;

      // Verify the message was persisted
      const messages = db.getMessagesSince("sess-1", "2000-01-01T00:00:00Z");
      const found = messages.find((m) => m.id === msg.id);
      expect(found).toBeDefined();
      expect(found?.content).toBe("Check status");
      expect(found?.type).toBe("user_message");
    });

    it("trims whitespace from text", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: "  padded text  " });

      expect(status).toBe(201);
      const msg = body["message"] as Message;
      expect(msg.content).toBe("padded text");
    });
  });

  // -------------------------------------------------------------------------
  // Validation errors (400)
  // -------------------------------------------------------------------------
  describe("validation errors", () => {
    let server: Server;
    let port: number;
    let db: CommanderDatabase;

    const mockGet = vi.fn(async () => makeSession({ id: "sess-1" }));

    beforeAll(async () => {
      db = createDatabase(":memory:");

      const services: Services = {
        config: makeConfig(),
        registry: {} as unknown as PluginRegistry,
        sessionManager: { get: mockGet } as unknown as SessionManager,
        database: db,
      };

      const app = express();
      app.use(express.json());
      app.locals["services"] = services;
      app.use(messagesRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
      db.close();
    });

    it("returns 400 when text is missing", async () => {
      const { status, body } = await postMessage(port, "sess-1", {});

      expect(status).toBe(400);
      expect(body["code"]).toBe("BAD_REQUEST");
    });

    it("returns 400 when text is empty string", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: "" });

      expect(status).toBe(400);
      expect(body["code"]).toBe("BAD_REQUEST");
    });

    it("returns 400 when text is only whitespace", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: "   " });

      expect(status).toBe(400);
      expect(body["code"]).toBe("BAD_REQUEST");
    });

    it("returns 400 when text is not a string", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: 123 });

      expect(status).toBe(400);
      expect(body["code"]).toBe("BAD_REQUEST");
    });
  });

  // -------------------------------------------------------------------------
  // Session not found (404)
  // -------------------------------------------------------------------------
  describe("session not found", () => {
    let server: Server;
    let port: number;
    let db: CommanderDatabase;

    const mockGet = vi.fn(async () => null);

    beforeAll(async () => {
      db = createDatabase(":memory:");

      const services: Services = {
        config: makeConfig(),
        registry: {} as unknown as PluginRegistry,
        sessionManager: { get: mockGet } as unknown as SessionManager,
        database: db,
      };

      const app = express();
      app.use(express.json());
      app.locals["services"] = services;
      app.use(messagesRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
      db.close();
    });

    it("returns 404 when session does not exist", async () => {
      const { status, body } = await postMessage(port, "nonexistent", { text: "Hello" });

      expect(status).toBe(404);
      expect(body["code"]).toBe("NOT_FOUND");
    });
  });

  // -------------------------------------------------------------------------
  // Session not active (409)
  // -------------------------------------------------------------------------
  describe("session not active", () => {
    let server: Server;
    let port: number;
    let db: CommanderDatabase;

    const doneSession = makeSession({ id: "sess-done", status: "done", activity: "exited" });
    const killedSession = makeSession({ id: "sess-killed", status: "killed", activity: "exited" });
    const exitedSession = makeSession({ id: "sess-exited", status: "working", activity: "exited" });

    const mockGet = vi.fn(async (id: string) => {
      if (id === "sess-done") return doneSession;
      if (id === "sess-killed") return killedSession;
      if (id === "sess-exited") return exitedSession;
      return null;
    });

    beforeAll(async () => {
      db = createDatabase(":memory:");

      const services: Services = {
        config: makeConfig(),
        registry: {} as unknown as PluginRegistry,
        sessionManager: { get: mockGet } as unknown as SessionManager,
        database: db,
      };

      const app = express();
      app.use(express.json());
      app.locals["services"] = services;
      app.use(messagesRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
      db.close();
    });

    it("returns 409 for session with done status", async () => {
      const { status, body } = await postMessage(port, "sess-done", { text: "Hello" });

      expect(status).toBe(409);
      expect(body["code"]).toBe("CONFLICT");
      expect(body["error"]).toContain("not active");
    });

    it("returns 409 for session with killed status", async () => {
      const { status, body } = await postMessage(port, "sess-killed", { text: "Hello" });

      expect(status).toBe(409);
      expect(body["code"]).toBe("CONFLICT");
    });

    it("returns 409 for session with exited activity", async () => {
      const { status, body } = await postMessage(port, "sess-exited", { text: "Hello" });

      expect(status).toBe(409);
      expect(body["code"]).toBe("CONFLICT");
    });

    it("includes session state in error message", async () => {
      const { body } = await postMessage(port, "sess-done", { text: "Hello" });

      expect(body["error"]).toContain("done");
      expect(body["error"]).toContain("exited");
    });
  });

  // -------------------------------------------------------------------------
  // Service unavailable (503)
  // -------------------------------------------------------------------------
  describe("service unavailable", () => {
    let server: Server;
    let port: number;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      // No services set in app.locals
      app.use(messagesRouter);

      const result = await startApp(app);
      server = result.server;
      port = result.port;
    });

    afterAll(async () => {
      await stopServer(server);
    });

    it("returns 503 when services are not initialized", async () => {
      const { status, body } = await postMessage(port, "sess-1", { text: "Hello" });

      expect(status).toBe(503);
      expect(body["code"]).toBe("SERVICE_UNAVAILABLE");
    });
  });
});
