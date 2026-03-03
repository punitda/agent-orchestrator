/**
 * Settings Generator — writes Claude Code settings.json with permission defaults.
 *
 * When a session is spawned remotely via the API, the developer isn't at their
 * desk to approve every operation. This generates a settings.json in the new
 * worktree's `.claude/` directory with pre-approved safe operations and explicit
 * deny rules.
 *
 * The generated file is compatible with Claude Code's `--settings-file` flag
 * and the project-level `.claude/settings.json` format.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionTemplate } from "../types.js";

/**
 * Hardcoded sensible default when no template is configured.
 *
 * Pre-approved: read-only tools, git status/diff/log, test/lint, file edits.
 * Denied: destructive ops, privilege escalation, remote pushes, network access,
 * .env file access.
 */
export const DEFAULT_PERMISSION_TEMPLATE: PermissionTemplate = {
  allowedTools: [
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash(git status*)",
    "Bash(git diff*)",
    "Bash(git log*)",
    "Bash(git add*)",
    "Bash(git commit*)",
    "Bash(git checkout*)",
    "Bash(git branch*)",
    "Bash(git switch*)",
    "Bash(npm test*)",
    "Bash(npm run test*)",
    "Bash(npm run lint*)",
    "Bash(pnpm test*)",
    "Bash(pnpm run test*)",
    "Bash(pnpm lint*)",
    "Bash(pnpm typecheck*)",
    "Bash(npx tsc*)",
  ],
  deniedTools: [
    "Bash(rm -rf*)",
    "Bash(sudo *)",
    "Bash(git push*)",
    "Bash(curl *)",
    "Bash(wget *)",
    "Bash(cat .env*)",
    "Bash(cat *.env*)",
  ],
};

/**
 * Merge a base template with an override. The override extends (does not
 * replace) the base — both sets of rules are combined with deduplication.
 */
export function mergeTemplates(
  base: PermissionTemplate,
  override?: PermissionTemplate,
): PermissionTemplate {
  if (!override) return base;
  return {
    allowedTools: [...new Set([...base.allowedTools, ...override.allowedTools])],
    deniedTools: [...new Set([...base.deniedTools, ...override.deniedTools])],
  };
}

/**
 * Resolve the effective permission template for a session.
 *
 * Priority: project override extends global config, which extends the
 * hardcoded default.
 */
export function resolveTemplate(
  globalTemplate?: PermissionTemplate,
  projectTemplate?: PermissionTemplate,
): PermissionTemplate {
  let resolved = DEFAULT_PERMISSION_TEMPLATE;
  resolved = mergeTemplates(resolved, globalTemplate);
  resolved = mergeTemplates(resolved, projectTemplate);
  return resolved;
}

/**
 * Generate a Claude Code settings.json in the workspace's `.claude/` directory.
 *
 * Uses `writeFileSync` with `{ flag: "wx" }` to avoid overwriting an existing
 * settings.json — if one already exists (e.g. from a symlink or the repo),
 * the call is silently skipped.
 *
 * @param workspacePath - Path to the workspace root
 * @param template - Permission template to write (uses default if omitted)
 */
export function generateSettingsJson(
  workspacePath: string,
  template?: PermissionTemplate,
): void {
  const resolved = template ?? DEFAULT_PERMISSION_TEMPLATE;

  const claudeDir = join(workspacePath, ".claude");
  const settingsPath = join(claudeDir, "settings.json");

  // Ensure .claude directory exists
  mkdirSync(claudeDir, { recursive: true });

  const settings = {
    permissions: {
      allow: resolved.allowedTools,
      deny: resolved.deniedTools,
    },
  };

  try {
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
      flag: "wx", // Exclusive create — fails if file exists
    });
  } catch (err: unknown) {
    // EEXIST is expected when settings.json already exists — skip gracefully
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw err;
  }
}
