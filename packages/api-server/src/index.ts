import express from "express";

const app = express();

const PORT = parseInt(process.env["AO_API_PORT"] ?? "3001", 10);
const HOST = process.env["AO_API_HOST"] ?? "0.0.0.0";

app.use(express.json());

app.use((_req, _res, next) => {
  next();
});

app.listen(PORT, HOST, () => {
  console.log(`API server listening on ${HOST}:${PORT}`);
});
