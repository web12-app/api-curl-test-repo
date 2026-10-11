/**
 * Test helpers: in-memory services, and a small client that calls route handlers with real
 * Request objects and keeps cookies between calls. No network access and no GitHub calls.
 */
import { randomBytes } from "node:crypto";
import { loadConfig } from "@/lib/config";
import { setServicesForTesting } from "@/lib/services";
import { MemoryStorage } from "@/lib/storage";

export const TEST_ENV: Record<string, string> = {
  SECRET_KEY: "test-secret-key-0123456789abcdef",
  API_KEY_HASH_SECRET: "test-pepper-0123456789abcdef",
  GITHUB_TOKEN: "ghp_test_token_not_real",
  PRIVATE_DATA_REPO: "owner/private-data",
  CORS_ALLOWED_ORIGINS: "https://app.example.com",
  COOKIE_SECURE: "0",
  LEGACY_API_KEY: "legacy-test-key-123456",
};

/** Install a fresh in-memory storage and config for one test. */
export function useMemoryServices(env: Record<string, string> = TEST_ENV): MemoryStorage {
  const storage = new MemoryStorage();
  setServicesForTesting({ config: loadConfig(env), storage });
  return storage;
}

export function randomIp(): string {
  const b = randomBytes(4);
  return `10.${b[1]}.${b[2]}.${b[3]}`;
}

export class Client {
  jar = new Map<string, string>();
  csrf = "";
  ip = randomIp();

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface CallOpts {
  method?: string;
  body?: unknown;
  raw?: string;
  form?: FormData;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  client?: Client;
  /** Send without the CSRF token (to test refusal). */
  noCsrf?: boolean;
  contentType?: string;
}

export interface Resp {
  status: number;
  headers: Headers;
  json: any;
  buf: Buffer;
  text: string;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function call(handler: any, path: string, o: CallOpts = {}): Promise<Resp> {
  const hasBody = o.body !== undefined || o.raw !== undefined || o.form !== undefined;
  const method = o.method ?? (hasBody ? "POST" : "GET");
  const headers = new Headers(o.headers ?? {});
  const c = o.client;
  if (c) {
    const ck = c.cookieHeader();
    if (ck) headers.set("cookie", ck);
  }
  if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", c ? c.ip : randomIp());
  const isKeyRequest = headers.has("authorization") || headers.has("x-api-key");
  if (c && UNSAFE.has(method) && !isKeyRequest && !o.noCsrf && c.csrf && !headers.has("x-csrf-token")) {
    headers.set("x-csrf-token", c.csrf);
  }

  let body: BodyInit | undefined;
  if (o.form) {
    body = o.form;
  } else if (o.raw !== undefined) {
    body = o.raw;
    headers.set("content-type", o.contentType ?? "application/json");
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers.set("content-type", o.contentType ?? "application/json");
  } else if (o.contentType) {
    headers.set("content-type", o.contentType);
  }

  const req = new Request(`http://test.local${path}`, { method, headers, body });
  const res: Response = await handler(req, o.params ? { params: Promise.resolve(o.params) } : undefined);

  if (c) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const idx = pair.indexOf("=");
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1);
      if (/Max-Age=0\b/i.test(sc) || value === "") c.jar.delete(name);
      else c.jar.set(name, value);
    }
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString("utf8");
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, buf, text };
}

// Route modules (imported lazily so each test file gets a clean module graph).
export const routes = {
  get csrf() {
    return import("@/app/api/v1/auth/csrf/route");
  },
  get signup() {
    return import("@/app/api/v1/auth/signup/route");
  },
  get login() {
    return import("@/app/api/v1/auth/login/route");
  },
  get logout() {
    return import("@/app/api/v1/auth/logout/route");
  },
  get me() {
    return import("@/app/api/v1/auth/me/route");
  },
};

/** Fetch a CSRF token for this client (also sets the session cookie). */
export async function ensureCsrf(client: Client): Promise<void> {
  const { GET } = await routes.csrf;
  const r = await call(GET, "/api/v1/auth/csrf", { client });
  client.csrf = r.json.data.csrf_token;
}

/** Sign up a new user and leave the client logged in. Returns the username. */
export async function signupUser(client: Client, username?: string, password = "correct-horse-1"): Promise<string> {
  await ensureCsrf(client);
  const name = username ?? "u" + randomBytes(4).toString("hex");
  const { POST } = await routes.signup;
  const r = await call(POST, "/api/v1/auth/signup", { client, body: { username: name, password } });
  if (r.status !== 201) throw new Error(`signup failed: ${r.status} ${r.text}`);
  client.csrf = r.json.data.csrf_token;
  return name;
}
