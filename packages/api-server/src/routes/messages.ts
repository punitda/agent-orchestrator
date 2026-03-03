import { type Router as RouterType, Router } from "express";
import { isTerminalSession } from "@composio/ao-core";

import type { Services } from "../services.js";
import type { Message } from "../database.js";

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router: RouterType = Router();

// ---------------------------------------------------------------------------
// POST /api/v1/sessions/:id/messages — send text to a session
// ---------------------------------------------------------------------------

router.post("/api/v1/sessions/:id/messages", async (req, res) => {
  try {
    const services = req.app.locals["services"] as Services | undefined;

    if (!services) {
      res.status(503).json({
        error: "Service unavailable",
        code: "SERVICE_UNAVAILABLE",
      });
      return;
    }

    const { sessionManager, database } = services;
    const sessionId = req.params["id"];

    if (!sessionId) {
      res.status(400).json({
        error: "Missing session ID",
        code: "BAD_REQUEST",
      });
      return;
    }

    // Validate body
    const body = req.body as Record<string, unknown> | undefined;
    const text =
      typeof body?.["text"] === "string" ? body["text"].trim() : undefined;

    if (!text) {
      res.status(400).json({
        error: "Missing required field: text",
        code: "BAD_REQUEST",
      });
      return;
    }

    // Check session exists
    const session = await sessionManager.get(sessionId);

    if (!session) {
      res.status(404).json({
        error: "Session not found",
        code: "NOT_FOUND",
      });
      return;
    }

    // Check session is in an active state
    if (isTerminalSession(session)) {
      res.status(409).json({
        error: `Session is not active (status: ${session.status}, activity: ${session.activity ?? "unknown"})`,
        code: "CONFLICT",
      });
      return;
    }

    // Store message in DB *before* sending to tmux (so it appears in chat even if tmux fails)
    const message: Message = database.insertMessage(
      sessionId,
      "user_message",
      text,
    );

    // Forward text to the runtime session
    await sessionManager.send(sessionId, text);

    res.status(201).json({ message });
  } catch (err: unknown) {
    console.error("Failed to send message:", err);
    res.status(500).json({
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
});

export { router as messagesRouter };
