import express from "express";
import { loadServerConfig } from "./config.js";
import { auditLog } from "./middleware/audit.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { getServices } from "./services.js";

const config = loadServerConfig();

const app = express();

app.use(express.json());

// Audit logging — MUST be before auth middleware so failed auth is captured
app.use(auditLog);

// Rate limiting — after audit log (so 429s are logged), before auth (to be added)
app.use(rateLimiter);

async function start(): Promise<void> {
  const services = await getServices();

  app.locals["services"] = services;

  app.listen(config.port, config.host, () => {
    console.log(`API server listening on ${config.host}:${config.port}`);
  });
}

start().catch((err: unknown) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
