/**
 * Browser-side API client. Same-origin requests with cookies. Writes send the CSRF token.
 * Errors carry the server's error code and message (never raw server internals).
 */

export class ApiCallError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiCallError";
    this.status = status;
    this.code = code;
  }
}

export interface ApiResponse<T> {
  success?: boolean;
  data?: T;
  error?: { code: string; message: string };
  request_id?: string;
}

export async function csrfToken(): Promise<string> {
  const r = await fetch("/api/v1/auth/csrf", { credentials: "same-origin" });
  const j = (await r.json()) as ApiResponse<{ csrf_token: string }>;
  return j.data?.csrf_token ?? "";
}

export async function apiCall<T = unknown>(method: string, url: string, body?: unknown): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = await csrfToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let j: ApiResponse<T> = {};
  try {
    j = (await r.json()) as ApiResponse<T>;
  } catch {
    // Non-JSON response: fall through with an empty body.
  }
  if (!r.ok) {
    throw new ApiCallError(r.status, j.error?.code ?? "ERROR", j.error?.message ?? `Request failed (${r.status}).`);
  }
  return j;
}
