import { type Router as RouterType, Router } from "express";

import type {
  Session,
  SCM,
  Agent,
  PRInfo,
  ProjectConfig,
} from "@composio/ao-core";

import type { Services } from "../services.js";
import type {
  SessionResponse,
  SessionDetailResponse,
  PRDetailResponse,
  CostResponse,
} from "../types.js";

/** Timeout for enrichment calls (PR + cost). Returns partial data on timeout. */
const ENRICHMENT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Helpers — list endpoint
// ---------------------------------------------------------------------------

function toSessionResponse(session: Session): SessionResponse {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr
      ? { number: session.pr.number, url: session.pr.url, state: "open" }
      : null,
    agentInfo: session.agentInfo?.summary
      ? { summary: session.agentInfo.summary }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers — detail endpoint
// ---------------------------------------------------------------------------

/** Resolve which project a session belongs to (same logic as web serialize.ts). */
function resolveProject(
  session: Session,
  projects: Record<string, ProjectConfig>,
): ProjectConfig | undefined {
  const direct = projects[session.projectId];
  if (direct) return direct;

  const entry = Object.entries(projects).find(([, p]) =>
    session.id.startsWith(p.sessionPrefix),
  );
  if (entry) return entry[1];

  const firstKey = Object.keys(projects)[0];
  return firstKey ? projects[firstKey] : undefined;
}

/** Build a detail session response (no enrichment yet). */
function toSessionDetailResponse(session: Session): SessionDetailResponse {
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr: session.pr
      ? {
          number: session.pr.number,
          url: session.pr.url,
          state: "open",
          ciStatus: "none",
          reviewDecision: "none",
          mergeable: false,
        }
      : null,
    agentInfo: {
      summary: session.agentInfo?.summary ?? session.metadata["summary"] ?? null,
      cost: null,
    },
  };
}

/** Enrich PR with CI status, review decision, and mergeability from SCM plugin. */
async function enrichPR(
  scm: SCM,
  pr: PRInfo,
): Promise<Pick<PRDetailResponse, "ciStatus" | "reviewDecision" | "mergeable">> {
  const [ciResult, reviewResult, mergeResult] = await Promise.allSettled([
    scm.getCISummary(pr),
    scm.getReviewDecision(pr),
    scm.getMergeability(pr),
  ]);

  return {
    ciStatus: ciResult.status === "fulfilled" ? ciResult.value : "none",
    reviewDecision:
      reviewResult.status === "fulfilled" ? reviewResult.value : "none",
    mergeable:
      mergeResult.status === "fulfilled" ? mergeResult.value.mergeable : false,
  };
}

/** Get cost estimate from the agent plugin. */
async function getAgentCost(
  agent: Agent,
  session: Session,
): Promise<CostResponse | null> {
  const info = await agent.getSessionInfo(session);
  if (!info?.cost) return null;
  return {
    inputTokens: info.cost.inputTokens,
    outputTokens: info.cost.outputTokens,
    estimatedCostUsd: info.cost.estimatedCostUsd,
  };
}

/**
 * Run an async operation with a timeout. Returns the result if it completes
 * within the deadline, or undefined on timeout.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router: RouterType = Router();

// ---------------------------------------------------------------------------
// GET /api/v1/sessions — list all sessions
// ---------------------------------------------------------------------------

router.get("/api/v1/sessions", async (req, res) => {
  const services = req.app.locals["services"] as Services | undefined;

  if (!services) {
    res.status(503).json({
      error: "Service unavailable",
      code: "SERVICE_UNAVAILABLE",
    });
    return;
  }

  const sessions = await services.sessionManager.list();

  const projectId =
    typeof req.query["projectId"] === "string"
      ? req.query["projectId"]
      : undefined;

  const filtered = projectId
    ? sessions.filter((s) => s.projectId === projectId)
    : sessions;

  // Sort by lastActivityAt descending (most recently active first)
  filtered.sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );

  res.json({ sessions: filtered.map(toSessionResponse) });
});

// ---------------------------------------------------------------------------
// GET /api/v1/sessions/:id — session detail with enrichment
// ---------------------------------------------------------------------------

router.get("/api/v1/sessions/:id", async (req, res) => {
  try {
    const services = req.app.locals["services"] as Services | undefined;

    if (!services) {
      res.status(503).json({
        error: "Services not ready",
        code: "SERVICE_UNAVAILABLE",
      });
      return;
    }

    const { config, registry, sessionManager } = services;
    const sessionId = req.params["id"];

    if (!sessionId) {
      res.status(400).json({
        error: "Missing session ID",
        code: "BAD_REQUEST",
      });
      return;
    }

    const session = await sessionManager.get(sessionId);

    if (!session) {
      res.status(404).json({
        error: "Session not found",
        code: "NOT_FOUND",
      });
      return;
    }

    const response = toSessionDetailResponse(session);

    // --- Enrichment (with 3-second timeout) ---
    const project = resolveProject(session, config.projects);
    const enrichmentPromises: Promise<void>[] = [];

    // Enrich PR data
    if (session.pr && project?.scm) {
      const scm = registry.get<SCM>("scm", project.scm.plugin);
      if (scm) {
        enrichmentPromises.push(
          enrichPR(scm, session.pr).then((prData) => {
            if (response.pr) {
              response.pr.ciStatus = prData.ciStatus;
              response.pr.reviewDecision = prData.reviewDecision;
              response.pr.mergeable = prData.mergeable;
            }
          }),
        );
      }
    }

    // Enrich agent cost
    const agentName = project?.agent ?? config.defaults.agent;
    if (agentName) {
      const agent = registry.get<Agent>("agent", agentName);
      if (agent) {
        enrichmentPromises.push(
          getAgentCost(agent, session).then((cost) => {
            response.agentInfo.cost = cost;
          }),
        );
      }
    }

    // Wait for enrichment with timeout — partial data on timeout
    if (enrichmentPromises.length > 0) {
      await withTimeout(Promise.allSettled(enrichmentPromises), ENRICHMENT_TIMEOUT_MS);
    }

    res.json({ session: response });
  } catch (err: unknown) {
    console.error("Failed to fetch session detail:", err);
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
});

export { router as sessionsRouter };
