/**
 * Unit tests for the permission settings generator.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateSettingsJson,
  mergeTemplates,
  resolveTemplate,
  DEFAULT_PERMISSION_TEMPLATE,
} from "../permissions/settings-generator.js";
import type { PermissionTemplate } from "../types.js";

/** Create a unique temporary workspace directory for each test. */
function makeTempWorkspace(): string {
  const dir = join(tmpdir(), `ao-test-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("DEFAULT_PERMISSION_TEMPLATE", () => {
  it("includes read-only tools", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Read");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Glob");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Grep");
  });

  it("includes file edit tools", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Edit");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Write");
  });

  it("includes safe git operations", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Bash(git status*)");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Bash(git diff*)");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Bash(git log*)");
  });

  it("includes test and lint commands", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Bash(npm test*)");
    expect(DEFAULT_PERMISSION_TEMPLATE.allowedTools).toContain("Bash(pnpm lint*)");
  });

  it("denies destructive operations", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(rm -rf*)");
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(sudo *)");
  });

  it("denies git push", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(git push*)");
  });

  it("denies network access", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(curl *)");
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(wget *)");
  });

  it("denies .env file access", () => {
    expect(DEFAULT_PERMISSION_TEMPLATE.deniedTools).toContain("Bash(cat .env*)");
  });
});

describe("mergeTemplates", () => {
  it("returns base when override is undefined", () => {
    const base: PermissionTemplate = {
      allowedTools: ["Read"],
      deniedTools: ["Bash(rm -rf*)"],
    };
    expect(mergeTemplates(base, undefined)).toEqual(base);
  });

  it("merges allowed and denied tools from both templates", () => {
    const base: PermissionTemplate = {
      allowedTools: ["Read", "Glob"],
      deniedTools: ["Bash(rm -rf*)"],
    };
    const override: PermissionTemplate = {
      allowedTools: ["Bash(docker build*)"],
      deniedTools: ["Bash(sudo *)"],
    };
    const result = mergeTemplates(base, override);
    expect(result.allowedTools).toContain("Read");
    expect(result.allowedTools).toContain("Glob");
    expect(result.allowedTools).toContain("Bash(docker build*)");
    expect(result.deniedTools).toContain("Bash(rm -rf*)");
    expect(result.deniedTools).toContain("Bash(sudo *)");
  });

  it("deduplicates entries", () => {
    const base: PermissionTemplate = {
      allowedTools: ["Read", "Glob"],
      deniedTools: ["Bash(rm -rf*)"],
    };
    const override: PermissionTemplate = {
      allowedTools: ["Read", "Edit"],
      deniedTools: ["Bash(rm -rf*)"],
    };
    const result = mergeTemplates(base, override);
    expect(result.allowedTools.filter((t) => t === "Read")).toHaveLength(1);
    expect(result.deniedTools.filter((t) => t === "Bash(rm -rf*)")).toHaveLength(1);
  });
});

describe("resolveTemplate", () => {
  it("returns default when no config is provided", () => {
    const result = resolveTemplate(undefined, undefined);
    expect(result).toEqual(DEFAULT_PERMISSION_TEMPLATE);
  });

  it("extends default with global template", () => {
    const global: PermissionTemplate = {
      allowedTools: ["Bash(docker build*)"],
      deniedTools: [],
    };
    const result = resolveTemplate(global, undefined);
    expect(result.allowedTools).toContain("Read"); // from default
    expect(result.allowedTools).toContain("Bash(docker build*)"); // from global
  });

  it("extends global with project template", () => {
    const global: PermissionTemplate = {
      allowedTools: ["Bash(docker build*)"],
      deniedTools: [],
    };
    const project: PermissionTemplate = {
      allowedTools: ["Bash(make*)"],
      deniedTools: ["Bash(docker push*)"],
    };
    const result = resolveTemplate(global, project);
    expect(result.allowedTools).toContain("Read"); // from default
    expect(result.allowedTools).toContain("Bash(docker build*)"); // from global
    expect(result.allowedTools).toContain("Bash(make*)"); // from project
    expect(result.deniedTools).toContain("Bash(docker push*)"); // from project
    expect(result.deniedTools).toContain("Bash(rm -rf*)"); // from default
  });
});

describe("generateSettingsJson", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempWorkspace();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("creates .claude/settings.json with default template", () => {
    generateSettingsJson(workspace);

    const settingsPath = join(workspace, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.permissions).toBeDefined();
    expect(content.permissions.allow).toEqual(DEFAULT_PERMISSION_TEMPLATE.allowedTools);
    expect(content.permissions.deny).toEqual(DEFAULT_PERMISSION_TEMPLATE.deniedTools);
  });

  it("creates .claude directory if it does not exist", () => {
    const claudeDir = join(workspace, ".claude");
    expect(existsSync(claudeDir)).toBe(false);

    generateSettingsJson(workspace);

    expect(existsSync(claudeDir)).toBe(true);
  });

  it("writes valid JSON", () => {
    generateSettingsJson(workspace);

    const settingsPath = join(workspace, ".claude", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("does not overwrite an existing settings.json", () => {
    const claudeDir = join(workspace, ".claude");
    const settingsPath = join(claudeDir, "settings.json");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsPath, '{"existing": true}\n');

    // Should not throw and should not overwrite
    generateSettingsJson(workspace);

    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.existing).toBe(true);
    expect(content.permissions).toBeUndefined();
  });

  it("writes custom template when provided", () => {
    const custom: PermissionTemplate = {
      allowedTools: ["Read", "CustomTool"],
      deniedTools: ["Bash(danger*)"],
    };

    generateSettingsJson(workspace, custom);

    const settingsPath = join(workspace, ".claude", "settings.json");
    const content = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(content.permissions.allow).toEqual(["Read", "CustomTool"]);
    expect(content.permissions.deny).toEqual(["Bash(danger*)"]);
  });

  it("produces pretty-printed JSON with trailing newline", () => {
    generateSettingsJson(workspace);

    const settingsPath = join(workspace, ".claude", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // Pretty printed = contains newlines within the JSON
    expect(raw.split("\n").length).toBeGreaterThan(2);
  });
});
