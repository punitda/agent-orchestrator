import express from "express";
import { loadServerConfig } from "./config.js";
import { getServices } from "./services.js";

const config = loadServerConfig();

const app = express();

app.use(express.json());

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
