import express from "express";
import { loadServerConfig } from "./config.js";

const config = loadServerConfig();

const app = express();

app.use(express.json());

app.use((_req, _res, next) => {
  next();
});

app.listen(config.port, config.host, () => {
  console.log(`API server listening on ${config.host}:${config.port}`);
});
