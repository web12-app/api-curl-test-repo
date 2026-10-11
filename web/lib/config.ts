/**
 * Backend configuration, read from the hosting environment only.
 *
 * Secret values are never printed. Errors name the variables that are missing or invalid,
 * never their values.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type SameSite = "Lax" | "Strict" | "None";

export interface Config {
  secretKey: string;
  apiKeyHashSecret: string;
  githubToken: string;
  privateDataRepo: string;
  corsAllowedOrigins: string[];
  sessionHours: number;
  cookieSecure: boolean;
  cookieSameSite: SameSite;
  maxRecordBytes: number;
  maxFileBytes: number;
  maxRequestBytes: number;
  legacyApiKey: string;
}

export type Env = Record<string, string | undefined>;

const REQUIRED = ["SECRET_KEY", "API_KEY_HASH_SECRET", "GITHUB_TOKEN", "PRIVATE_DATA_REPO"] as const;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const GITHUB_CONTENTS_LIMIT = 1_000_000; // The Contents API does not return content for larger files.

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}.`);
  return n;
}

export function loadConfig(env: Env = process.env): Config {
  const missing = REQUIRED.filter((k) => !(env[k] ?? "").trim());
  if (missing.length) {
    throw new ConfigError(`Missing required configuration: ${missing.join(", ")}`);
  }

  const repo = (env.PRIVATE_DATA_REPO ?? "").trim();
  if (!REPO_RE.test(repo)) {
    throw new ConfigError("PRIVATE_DATA_REPO must look like owner/name.");
  }

  const origins = (env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  for (const o of origins) {
    if (o === "*") throw new ConfigError("Wildcard CORS origins are not allowed.");
    if (!(o.startsWith("https://") || o.startsWith("http://localhost") || o.startsWith("http://127.0.0.1"))) {
      throw new ConfigError("CORS_ALLOWED_ORIGINS entries must be https origins (or localhost for development).");
    }
  }

  const sameSite = (env.COOKIE_SAMESITE ?? "Lax").trim();
  if (sameSite !== "Lax" && sameSite !== "Strict" && sameSite !== "None") {
    throw new ConfigError("COOKIE_SAMESITE must be Lax, Strict, or None.");
  }

  const cookieSecure = (env.COOKIE_SECURE ?? "1") !== "0";
  if (sameSite === "None" && !cookieSecure) {
    throw new ConfigError("COOKIE_SAMESITE=None requires secure cookies.");
  }

  return {
    secretKey: env.SECRET_KEY!.trim(),
    apiKeyHashSecret: env.API_KEY_HASH_SECRET!.trim(),
    githubToken: env.GITHUB_TOKEN!.trim(),
    privateDataRepo: repo,
    corsAllowedOrigins: origins,
    sessionHours: intSetting(env, "SESSION_HOURS", 12, 1, 24 * 30),
    cookieSecure,
    cookieSameSite: sameSite as SameSite,
    maxRecordBytes: intSetting(env, "MAX_RECORD_BYTES", 64 * 1024, 1024, 1_000_000),
    maxFileBytes: Math.min(intSetting(env, "MAX_FILE_BYTES", GITHUB_CONTENTS_LIMIT, 1, 100_000_000), GITHUB_CONTENTS_LIMIT),
    maxRequestBytes: 2 * 1024 * 1024,
    legacyApiKey: (env.LEGACY_API_KEY ?? "").trim(),
  };
}
