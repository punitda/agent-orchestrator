import rateLimit from "express-rate-limit";

export const rateLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests",
      code: "RATE_LIMITED",
    });
  },
});
