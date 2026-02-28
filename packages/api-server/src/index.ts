import express from "express";
import { loadServerConfig } from "./config.js";
import { createAuthMiddleware, loadKeyHash } from "./middleware/auth.js";
import { auditLog } from "./middleware/audit.js";
import { rateLimiter } from "./middleware/rate-limit.js";
import { healthRouter } from "./routes/health.js";
import { getServices } from "./services.js";

const config = loadServerConfig();

const app = express();

app.use(express.json());

// Audit logging — MUST be before auth middleware so failed auth is captured
app.use(auditLog);

// Rate limiting — after audit log (so 429s are logged), before auth
app.use(rateLimiter);

// Health check — before auth so it's accessible without API key
app.use(healthRouter);

// Auth — load key hash once at startup, cache in closure
const keyHash = loadKeyHash();
if (keyHash === null) {
  console.warn(
    "Warning: auth.json not found or malformed. Run `generate-key` to create an API key.",
  );
}
app.use(createAuthMiddleware(keyHash));

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
