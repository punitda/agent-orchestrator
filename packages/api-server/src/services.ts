/**
 * Server-side singleton for core services.
 *
 * Loads config, initializes plugin registry with dynamic imports,
 * and creates a session manager. Follows the same pattern as the CLI's
 * create-session-manager.ts but exposes all three as a single services object.
 */

import {
  loadConfig,
  createPluginRegistry,
  createSessionManager,
  type OrchestratorConfig,
  type PluginRegistry,
  type SessionManager,
} from "@composio/ao-core";

export interface Services {
  config: OrchestratorConfig;
  registry: PluginRegistry;
  sessionManager: SessionManager;
}

let servicesPromise: Promise<Services> | null = null;

/**
 * Get (or lazily initialize) the core services singleton.
 *
 * Caches the Promise so concurrent callers await the same initialization.
 * On failure the cache is cleared so the next call retries.
 */
export function getServices(): Promise<Services> {
  if (!servicesPromise) {
    servicesPromise = initServices().catch((err: unknown) => {
      servicesPromise = null;
      throw err;
    });
  }
  return servicesPromise;
}

async function initServices(): Promise<Services> {
  let config: OrchestratorConfig;
  try {
    config = loadConfig();
  } catch {
    console.error(
      "No agent-orchestrator.yaml found. Copy from agent-orchestrator.yaml.example and configure.",
    );
    process.exit(1);
  }

  const registry = createPluginRegistry();

  try {
    await registry.loadFromConfig(config, (pkg: string) => import(pkg));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to load plugins: ${message}`);
    process.exit(1);
  }

  const loadedPlugins = (
    ["runtime", "agent", "workspace", "tracker", "scm", "notifier", "terminal"] as const
  )
    .flatMap((slot) => registry.list(slot))
    .map((m) => m.name);

  if (loadedPlugins.length > 0) {
    console.log(`Loaded plugins: ${loadedPlugins.join(", ")}`);
  }

  const sessionManager = createSessionManager({ config, registry });

  return { config, registry, sessionManager };
}
