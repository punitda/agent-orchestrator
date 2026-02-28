import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import bcrypt from "bcrypt";
import type { Request, Response, NextFunction } from "express";

const AUTH_FILE = join(homedir(), ".claude-commander", "auth.json");

interface AuthConfig {
  keyHash: string;
}

/**
 * Load the bcrypt key hash from ~/.claude-commander/auth.json.
 * Returns the hash string on success, or null if the file is missing / malformed.
 */
export function loadKeyHash(authFile: string = AUTH_FILE): string | null {
  try {
    const raw = readFileSync(authFile, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "keyHash" in parsed &&
      typeof (parsed as AuthConfig).keyHash === "string" &&
      (parsed as AuthConfig).keyHash.length > 0
    ) {
      return (parsed as AuthConfig).keyHash;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Create Express middleware that validates the `x-api-key` header against
 * a bcrypt hash loaded at startup.
 *
 * - `GET /api/v1/health` is exempt (passes through without a key).
 * - Missing or invalid keys receive an identical 401 response (no info leakage).
 * - If no key hash was loaded (auth.json missing/malformed), returns 500.
 */
export function createAuthMiddleware(
  keyHash: string | null,
): (req: Request, res: Response, next: NextFunction) => void {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Health check is exempt from auth
      if (req.method === "GET" && req.path === "/api/v1/health") {
        next();
        return;
      }

      // If auth.json was missing or malformed at startup, reject all requests
      if (keyHash === null) {
        res.status(500).json({
          error: "API key not configured. Run generate-key first.",
          code: "AUTH_NOT_CONFIGURED",
        });
        return;
      }

      const apiKey = req.headers["x-api-key"];

      if (typeof apiKey !== "string" || apiKey.length === 0) {
        res.status(401).json({
          error: "Unauthorized",
          code: "MISSING_API_KEY",
        });
        return;
      }

      const valid = await bcrypt.compare(apiKey, keyHash);

      if (!valid) {
        res.status(401).json({
          error: "Unauthorized",
          code: "INVALID_API_KEY",
        });
        return;
      }

      next();
    } catch {
      res.status(401).json({
        error: "Unauthorized",
        code: "INVALID_API_KEY",
      });
    }
  };
}
