/**
 * Signed session cookie. The payload is {uid, iat, csrf}, signed with HMAC-SHA256 using SECRET_KEY.
 * The cookie is HttpOnly, so browser scripts cannot read it. Tampering invalidates the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";

export const SESSION_COOKIE = "pips_session";

export interface SessionData {
  uid?: string;
  iat?: number;
  csrf?: string;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function encodeSession(data: SessionData, secret: string): string {
  const body = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function decodeSession(value: string | undefined, secret: string): SessionData {
  if (!value) return {};
  const i = value.lastIndexOf(".");
  if (i < 0) return {};
  const body = value.slice(0, i);
  const sig = value.slice(i + 1);
  const expected = sign(body, secret);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return {};
  try {
    const obj = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return undefined;
}

function attributes(cfg: Pick<Config, "cookieSecure" | "cookieSameSite">): string[] {
  const attrs = ["Path=/", "HttpOnly", `SameSite=${cfg.cookieSameSite}`];
  if (cfg.cookieSecure) attrs.push("Secure");
  return attrs;
}

export function sessionCookie(value: string, cfg: Config): string {
  return [`${SESSION_COOKIE}=${value}`, `Max-Age=${cfg.sessionHours * 3600}`, ...attributes(cfg)].join("; ");
}

export function clearSessionCookie(cfg: Pick<Config, "cookieSecure" | "cookieSameSite">): string {
  return [`${SESSION_COOKIE}=`, "Max-Age=0", ...attributes(cfg)].join("; ");
}
