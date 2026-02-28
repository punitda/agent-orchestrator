import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import bcrypt from "bcrypt";

const CONFIG_DIR = join(homedir(), ".claude-commander");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");
const BCRYPT_COST = 12;

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  if (existsSync(AUTH_FILE) && !force) {
    console.error(
      "API key already exists. Use --force to overwrite.",
    );
    process.exit(1);
  }

  const key = randomBytes(32).toString("hex");
  const keyHash = await bcrypt.hash(key, BCRYPT_COST);

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    AUTH_FILE,
    JSON.stringify({ keyHash }, null, 2) + "\n",
    { mode: 0o600 },
  );

  console.log(
    `Your API key (copy this to your mobile app):\n\n  ${key}\n\nThis key will not be shown again.`,
  );
}

main().catch((error: unknown) => {
  console.error("Failed to generate API key:", error);
  process.exit(1);
});
