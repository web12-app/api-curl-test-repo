/**
 * Storage engine. All private data goes through this module.
 *
 * Two implementations share one interface:
 *   GitHubStorage - GitHub Contents API against the PRIVATE data repo (production)
 *   MemoryStorage - in-process map with the same concurrency rules (tests, local dev)
 *
 * Concurrency model (GitHub Contents API):
 *   - Every update sends the current blob SHA. A stale SHA is rejected, which surfaces as
 *     Conflict (409). This prevents silent lost updates for a single file.
 *   - There are NO multi-file transactions. Writes to several paths are separate commits.
 *   - Reads are retried a bounded number of times on transient errors. Writes are never retried
 *     automatically, because a retried write could overwrite a newer change.
 *
 * Limits: file content over ~1 MB is not returned by the Contents API, and directory listings
 * are capped at 1,000 entries.
 */
import { createHash } from "node:crypto";

export const GITHUB_API = "https://api.github.com";
const CONFLICT_MESSAGE = "The record was changed by another request. Reload and try again.";

export class StorageError extends Error {
  status = 500;
  code = "INTERNAL_ERROR";

  constructor(message?: string, status?: number, code?: string) {
    super(message ?? "Internal error.");
    this.name = "StorageError";
    if (status) this.status = status;
    if (code) this.code = code;
  }
}

export class NotFound extends StorageError {
  constructor(message = "Not found.") {
    super(message, 404, "NOT_FOUND");
  }
}

export class Conflict extends StorageError {
  constructor(message = CONFLICT_MESSAGE) {
    super(message, 409, "CONFLICT");
  }
}

export class TooLarge extends StorageError {
  constructor(message = "Stored content is too large to read through the storage API.") {
    super(message, 413, "PAYLOAD_TOO_LARGE");
  }
}

export class Upstream extends StorageError {
  constructor(message = "Storage is temporarily unavailable.") {
    super(message, 502, "UPSTREAM_ERROR");
  }
}

export class Busy extends StorageError {
  constructor(message = "Storage rate limit reached. Try again later.") {
    super(message, 429, "STORAGE_RATE_LIMITED");
  }
}

export interface FileEntry {
  name: string;
  type: string;
  sha: string;
}

export interface Blob {
  data: Buffer;
  sha: string;
}

export interface Storage {
  check(): Promise<boolean>;
  read(path: string): Promise<Blob | null>;
  list(path: string): Promise<FileEntry[]>;
  write(path: string, data: Buffer, message: string, sha?: string): Promise<string>;
  delete(path: string, sha: string, message: string): Promise<boolean>;
}

export function blobSha(data: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");
}

export function jsonBytes(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubStorage implements Storage {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly timeoutMs = 15_000,
    private readonly readRetries = 2,
  ) {}

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  private url(path: string): string {
    return `${GITHUB_API}/repos/${this.repo}/contents/${encodeURI(path)}`;
  }

  private async request(method: string, url: string, opts: { retry?: boolean; body?: unknown } = {}): Promise<Response> {
    const attempts = opts.retry ? this.readRetries + 1 : 1;
    let last: StorageError | null = null;
    for (let i = 0; i < attempts; i++) {
      let r: Response | null = null;
      try {
        r = await fetch(url, {
          method,
          headers: { ...this.headers(), ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        last = new Upstream("Storage is unreachable.");
      }
      if (r) {
        if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") {
          throw new Busy();
        }
        if (r.status === 429) throw new Busy();
        if (r.status >= 500 && opts.retry) {
          last = new Upstream();
        } else {
          return r;
        }
      }
      if (i < attempts - 1) await sleep(500 * 2 ** i);
    }
    throw last ?? new Upstream();
  }

  async check(): Promise<boolean> {
    const r = await this.request("GET", `${GITHUB_API}/repos/${this.repo}`, { retry: true });
    if (r.status !== 200) throw new Upstream("Private data repository is not accessible.");
    return true;
  }

  async read(path: string): Promise<Blob | null> {
    const r = await this.request("GET", this.url(path), { retry: true });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Upstream("Storage read failed.");
    const d = await r.json();
    if (d.type !== "file") throw new NotFound();
    const encoding = d.encoding ?? null;
    if ((encoding !== null && encoding !== "base64") || ((d.size ?? 0) > 0 && !d.content)) {
      throw new TooLarge();
    }
    return { data: Buffer.from(d.content ?? "", "base64"), sha: d.sha };
  }

  async list(path: string): Promise<FileEntry[]> {
    const r = await this.request("GET", this.url(path), { retry: true });
    if (r.status === 404) return [];
    if (r.status !== 200) throw new Upstream("Storage listing failed.");
    const items = await r.json();
    if (!Array.isArray(items)) return [];
    return items.map((i: any) => ({ name: i.name, type: i.type, sha: i.sha }));
  }

  /** Create (sha undefined) or update (sha = current blob sha). Returns the new blob sha. Not retried. */
  async write(path: string, data: Buffer, message: string, sha?: string): Promise<string> {
    const body: Record<string, string> = { message, content: data.toString("base64") };
    if (sha) body.sha = sha;
    const r = await this.request("PUT", this.url(path), { body });
    if (r.status === 200 || r.status === 201) {
      const j = await r.json();
      return j.content.sha;
    }
    if (r.status === 409 || r.status === 422) throw new Conflict();
    if (r.status === 404) throw new NotFound();
    throw new Upstream("Storage write failed.");
  }

  async delete(path: string, sha: string, message: string): Promise<boolean> {
    const r = await this.request("DELETE", this.url(path), { body: { message, sha } });
    if (r.status === 200) return true;
    if (r.status === 409 || r.status === 422) throw new Conflict();
    if (r.status === 404) throw new NotFound();
    throw new Upstream("Storage delete failed.");
  }
}

/** Same semantics as GitHubStorage, kept in memory. For tests and local development only. */
export class MemoryStorage implements Storage {
  private files = new Map<string, { data: Buffer; sha: string }>();
  /** Set to an error to make the next write fail (used to test rollback paths). */
  failNextWrite: StorageError | null = null;

  async check(): Promise<boolean> {
    return true;
  }

  async read(path: string): Promise<Blob | null> {
    const got = this.files.get(path);
    return got ? { data: Buffer.from(got.data), sha: got.sha } : null;
  }

  async list(path: string): Promise<FileEntry[]> {
    const prefix = path.replace(/\/+$/, "") + "/";
    const out: FileEntry[] = [];
    for (const [p, { sha }] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes("/")) continue;
      out.push({ name: rest, type: "file", sha });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async write(path: string, data: Buffer, _message: string, sha?: string): Promise<string> {
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      throw err;
    }
    const current = this.files.get(path);
    if (sha === undefined && current !== undefined) throw new Conflict();
    if (sha !== undefined && (current === undefined || current.sha !== sha)) throw new Conflict();
    const newSha = blobSha(data);
    this.files.set(path, { data: Buffer.from(data), sha: newSha });
    return newSha;
  }

  async delete(path: string, sha: string, _message: string): Promise<boolean> {
    const current = this.files.get(path);
    if (current === undefined) throw new NotFound();
    if (current.sha !== sha) throw new Conflict();
    this.files.delete(path);
    return true;
  }
}
