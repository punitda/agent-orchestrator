import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Router as RouterType, Router } from "express";

import type { Services } from "../services.js";

const pkgPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../package.json",
);

let VERSION: string;
try {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
    version: string;
  };
  VERSION = pkg.version;
} catch {
  VERSION = "unknown";
}

const router: RouterType = Router();

router.get("/api/v1/health", (_req, res) => {
  const services = _req.app.locals["services"] as Services | undefined;
  const uptime = Math.floor(process.uptime());

  if (!services) {
    res.json({
      status: "degraded",
      uptime,
      version: VERSION,
      error: "Session manager not ready",
    });
    return;
  }

  res.json({
    status: "ok",
    uptime,
    version: VERSION,
  });
});

export { router as healthRouter };
