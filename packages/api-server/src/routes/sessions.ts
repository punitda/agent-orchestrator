import { type Router as RouterType, Router } from "express";

import type { Session } from "@composio/ao-core";

import type { Services } from "../services.js";
import type { SessionResponse } from "../types.js";

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

const router: RouterType = Router();

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

export { router as sessionsRouter };
