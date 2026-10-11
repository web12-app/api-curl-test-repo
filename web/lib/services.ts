/**
 * Process-wide services: validated config and the storage engine.
 *
 * Configuration is validated lazily on first use, so `next build` runs without secrets.
 * instrumentation.ts also validates at server start and logs problems (names only).
 */
import { loadConfig, type Config } from "./config";
import { GitHubStorage, type Storage } from "./storage";

export interface Services {
  config: Config;
  storage: Storage;
}

let cached: Services | null = null;
let override: Services | null = null;

/** Throws ConfigError when required configuration is missing or invalid. */
export function getServices(): Services {
  if (override) return override;
  if (cached) return cached;
  const config = loadConfig(process.env);
  cached = { config, storage: new GitHubStorage(config.githubToken, config.privateDataRepo) };
  return cached;
}

/** For tests: inject a config and an in-memory storage. Pass null to restore the environment. */
export function setServicesForTesting(s: Services | null): void {
  override = s;
}
