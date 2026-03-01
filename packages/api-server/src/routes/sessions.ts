import { type Router as RouterType, Router } from "express";

import type {
  Session,
  SessionStatus,
  SCM,
  Agent,
  PRInfo,
  ProjectConfig,
} from "@composio/ao-core";

import type { Services } from "../services.js";
import type {
  AttentionLevel,
  SessionPR,
  SessionResponse,
  SessionDetailResponse,
  PRDetailResponse,
  CostResponse,
} from "../types.js";

/** Timeout for enrichment calls (PR + cost). Returns partial data on timeout. */
const ENRICHMENT_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Helpers — PR state derivation
// ---------------------------------------------------------------------------

/**
 * Derive a best-effort PR state from the session status without making API calls.
 * Used by the list endpoint to stay fast.
 */
function derivePRState(status: SessionStatus): SessionPR["state"] {
  if (status === "merged") return "merged";
  return "open";
}

/**
 * Reconcile a stale session status using live PR data.
 * The flat-file metadata is only written when the agent is running;
 * once the agent exits, the status never updates. This function
 * corrects the response status using enriched data from the SCM plugin.
 */
function reconcileSessionStatus(
  metadataStatus: SessionStatus,
  prState: SessionPR["state"] | undefined,
  activity: string | null,
): SessionStatus {
  // PR merged but metadata still says pr_open/approved/mergeable/etc.
  if (prState === "merged" && metadataStatus !== "merged") {
    return "merged";
  }
  // PR closed (not merged) and agent exited — session is done
  if (prState === "closed" && activity === "exited") {
    return "done";
  }
  // Agent exited without a PR — session is done
  if (!prState && activity === "exited" && metadataStatus === "working") {
    return "done";
  }
  return metadataStatus;
}

// ---------------------------------------------------------------------------
// Helpers — attention level
// ---------------------------------------------------------------------------

/**
 * Derive which attention zone a session belongs to.
 *
 * This is a simplified version of the dashboard's getAttentionLevel().
 * The list endpoint has no enriched PR data, so it relies on session
 * status and activity only. The detail endpoint calls this first, then
 * upgrades with enriched PR data if available.
 */
function getAttentionLevel(
  status: SessionStatus,
  activity: string | null,
  pr?: { state: SessionPR["state"]; ciStatus?: string; reviewDecision?: string; mergeable?: boolean } | null,
): AttentionLevel {
  // Done: terminal states
  if (
    status === "merged" ||
    status === "killed" ||
    status === "cleanup" ||
    status === "done" ||
    status === "terminated"
  ) {
    return "done";
  }
  if (pr?.state === "merged" || pr?.state === "closed") {
    return "done";
  }

  // Merge: PR approved + CI green
  if (status === "mergeable" || status === "approved") {
    return "merge";
  }
  if (pr?.mergeable) {
    return "merge";
  }

  // Respond: agent waiting for human input or crashed
  if (activity === "waiting_input" || activity === "blocked") {
    return "respond";
  }
  if (status === "needs_input" || status === "stuck" || status === "errored") {
    return "respond";
  }
  if (activity === "exited") {
    return "respond";
  }

  // Review: CI failed, changes requested
  if (status === "ci_failed" || status === "changes_requested") {
    return "review";
  }
  if (pr?.ciStatus === "failing") return "review";
  if (pr?.reviewDecision === "changes_requested") return "review";

  // Pending: waiting on external
  if (status === "review_pending") {
    return "pending";
  }
  if (pr && (pr.reviewDecision === "pending" || pr.reviewDecision === "none")) {
    return "pending";
  }

  // Working: default
  return "working";
}

// ---------------------------------------------------------------------------
// Helpers — list endpoint
// ---------------------------------------------------------------------------

function toSessionResponse(session: Session): SessionResponse {
  const prState = session.pr ? derivePRState(session.status) : undefined;
  const status = reconcileSessionStatus(session.status, prState, session.activity);
  const pr = session.pr
    ? { number: session.pr.number, url: session.pr.url, state: prState ?? "open" }
    : null;
  return {
    id: session.id,
    projectId: session.projectId,
    status,
    attentionLevel: getAttentionLevel(status, session.activity, pr),
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr,
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
  const pr = session.pr
    ? {
        number: session.pr.number,
        url: session.pr.url,
        state: derivePRState(session.status),
        ciStatus: "none" as const,
        reviewDecision: "none" as const,
        mergeable: false,
      }
    : null;
  return {
    id: session.id,
    projectId: session.projectId,
    status: session.status,
    attentionLevel: getAttentionLevel(session.status, session.activity, pr),
    activity: session.activity,
    branch: session.branch,
    issueId: session.issueId,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    pr,
    agentInfo: {
      summary: session.agentInfo?.summary ?? session.metadata["summary"] ?? null,
      cost: null,
    },
  };
}

/** Enrich PR with live state, CI status, review decision, and mergeability from SCM plugin. */
async function enrichPR(
  scm: SCM,
  pr: PRInfo,
): Promise<Pick<PRDetailResponse, "state" | "ciStatus" | "reviewDecision" | "mergeable">> {
  const [stateResult, ciResult, reviewResult, mergeResult] = await Promise.allSettled([
    scm.getPRState(pr),
    scm.getCISummary(pr),
    scm.getReviewDecision(pr),
    scm.getMergeability(pr),
  ]);

  return {
    state: stateResult.status === "fulfilled" ? stateResult.value : "open",
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
// POST /api/v1/sessions — spawn a new session
// ---------------------------------------------------------------------------

router.post("/api/v1/sessions", async (req, res) => {
  try {
    const services = req.app.locals["services"] as Services | undefined;

    if (!services) {
      res.status(503).json({
        error: "Service unavailable",
        code: "SERVICE_UNAVAILABLE",
      });
      return;
    }

    const { config, sessionManager } = services;
    const body = req.body as Record<string, unknown> | undefined;

    // Validate required fields
    const projectId =
      typeof body?.["projectId"] === "string"
        ? body["projectId"].trim()
        : undefined;
    const task =
      typeof body?.["task"] === "string" ? body["task"].trim() : undefined;

    if (!projectId) {
      res.status(400).json({
        error: "Missing required field: projectId",
        code: "BAD_REQUEST",
      });
      return;
    }

    if (!task) {
      res.status(400).json({
        error: "Missing required field: task",
        code: "BAD_REQUEST",
      });
      return;
    }

    // Validate project exists in config
    if (!config.projects[projectId]) {
      res.status(400).json({
        error: `Unknown project: ${projectId}`,
        code: "BAD_REQUEST",
      });
      return;
    }

    // Extract optional fields
    const issueId =
      typeof body?.["issueId"] === "string"
        ? body["issueId"].trim() || undefined
        : undefined;

    const session = await sessionManager.spawn({
      projectId,
      prompt: task,
      issueId,
    });

    res.status(201).json({ session: toSessionResponse(session) });
  } catch (err: unknown) {
    console.error("Failed to spawn session:", err);
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
});

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
              response.pr.state = prData.state;
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

    // Reconcile stale session status using live enriched data
    response.status = reconcileSessionStatus(
      response.status,
      response.pr?.state,
      response.activity,
    );

    // Recompute attention level with enriched PR data
    response.attentionLevel = getAttentionLevel(
      response.status,
      response.activity,
      response.pr,
    );

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
