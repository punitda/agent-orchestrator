/**
 * API server config — reads ~/.claude-commander/config.json and validates with Zod.
 *
 * Config format: { "host": "100.64.0.1", "port": 3001 }
 *
 * Security: binding to 0.0.0.0 is rejected to prevent public exposure.
 * If the config file doesn't exist, defaults to 127.0.0.1:3001.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

// IPv4 pattern: four octets 0–255
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Hostname pattern (RFC 952 / 1123): labels separated by dots
const HOSTNAME_RE =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

function isValidIPv4(value: string): boolean {
  const match = IPV4_RE.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => {
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}

function isValidHost(value: string): boolean {
  // If it looks like an IP (digits and dots only), validate strictly as IPv4
  if (/^[\d.]+$/.test(value)) {
    return isValidIPv4(value);
  }
  return HOSTNAME_RE.test(value);
}

export const ServerConfigSchema = z
  .object({
    host: z.string().min(1, "host must not be empty"),
    port: z.number().int().min(1).max(65535),
  })
  .refine((cfg) => cfg.host !== "0.0.0.0", {
    message:
      "Binding to 0.0.0.0 is not allowed for security. Use your Tailscale IP (100.x.y.z) or 127.0.0.1.",
    path: ["host"],
  })
  .refine((cfg) => isValidHost(cfg.host), {
    message: "host must be a valid IPv4 address or hostname",
    path: ["host"],
  });

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const DEFAULT_CONFIG: ServerConfig = { host: "127.0.0.1", port: 3001 };

export const CONFIG_DIR = join(homedir(), ".claude-commander");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

/**
 * Load and validate the API server config.
 *
 * @param configPath — override path for testing; defaults to ~/.claude-commander/config.json
 */
export function loadServerConfig(configPath: string = CONFIG_PATH): ServerConfig {
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read config file ${configPath}: ${message}`, { cause: err });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    throw new Error(`Invalid JSON in config file ${configPath}`, { cause: err });
  }

  const result = ServerConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid config in ${configPath}:\n${issues.join("\n")}`);
  }

  return result.data;
}
