/**
 * API behaviour through the real route handlers (Request in, Response out), with in-memory storage.
 * These mirror the checks from the earlier Flask test suite.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { call, Client, ensureCsrf, routes, signupUser, useMemoryServices, TEST_ENV } from "./helpers";
import { MemoryStorage } from "@/lib/storage";
import { jsonBytes } from "@/lib/storage";
import * as paths from "@/lib/paths";

// Route handlers
const appsRoute = () => import("@/app/api/v1/apps/route");
const appRoute = () => import("@/app/api/v1/apps/[appId]/route");
const keysRoute = () => import("@/app/api/v1/apps/[appId]/keys/route");
const keyRoute = () => import("@/app/api/v1/apps/[appId]/keys/[keyId]/route");
const dbList = () => import("@/app/api/v1/db/[appId]/[collection]/route");
const dbRec = () => import("@/app/api/v1/db/[appId]/[collection]/[recordId]/route");
const filesRoute = () => import("@/app/api/v1/files/route");
const fileRoute = () => import("@/app/api/v1/files/[fileId]/route");
const fileDownload = () => import("@/app/api/v1/files/[fileId]/download/route");
const legacyFiles = () => import("@/app/api/files/route");
const legacyFile = () => import("@/app/api/files/[name]/route");
const health = () => import("@/app/api/health/route");
const preflight = () => import("@/lib/api").then((m) => m.preflight);

let storage: MemoryStorage;

beforeEach(() => {
  storage = useMemoryServices();
});

/** Create an app as the given logged-in client and return its id. */
async function createApp(owner: Client, name = "Notes App"): Promise<string> {
  const { POST } = await appsRoute();
  const r = await call(POST, "/api/v1/apps", { client: owner, body: { name, description: "test" } });
  expect(r.status).toBe(201);
  return r.json.data.app.id;
}

/** Create a key for an app as the owner and return the full key string. */
async function createKey(owner: Client, appId: string, scopes: string[] = ["db:read", "db:write", "files:read", "files:write"], environment = "development"): Promise<string> {
  const { POST } = await keysRoute();
  const r = await call(POST, `/api/v1/apps/${appId}/keys`, {
    client: owner,
    params: { appId },
    body: { name: "test key", environment, scopes },
  });
  expect(r.status).toBe(201);
  return r.json.data.key.api_key;
}

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

describe("health and legacy endpoints", () => {
  it("health reports storage status and no configuration values", async () => {
    const { GET } = await health();
    const r = await call(GET, "/api/health");
    expect(r.status).toBe(200);
    expect(r.json.storage).toBe("ok");
    for (const v of Object.values(TEST_ENV).filter((x) => x.length >= 8)) expect(r.text).not.toContain(v);
  });

  it("keeps the legacy hello, time, and me endpoints", async () => {
    const hello = (await import("@/app/api/hello/route")).GET;
    const time = (await import("@/app/api/time/route")).GET;
    const me = (await import("@/app/api/me/route")).GET;
    expect((await call(hello, "/api/hello")).json.source).toBe("api-curl-test-repo");
    expect(typeof (await call(time, "/api/time")).json.utc).toBe("string");
    expect((await call(me, "/api/me")).json).toEqual({ user: null });
  });
});

describe("CSRF and auth", () => {
  it("refuses a cookie-authenticated write without a CSRF token", async () => {
    const client = new Client();
    await ensureCsrf(client);
    const { POST } = await routes.login;
    const r = await call(POST, "/api/v1/auth/login", { client, noCsrf: true, body: { username: "x", password: "y" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("CSRF_FAILED");
  });

  it("refuses a wrong CSRF token", async () => {
    const client = new Client();
    await ensureCsrf(client);
    const { POST } = await appsRoute();
    const r = await call(POST, "/api/v1/apps", { client, headers: { "x-csrf-token": "wrong" }, body: { name: "a" } });
    expect(r.status).toBe(403);
  });

  it("validates passwords and usernames before creating anything", async () => {
    const client = new Client();
    await ensureCsrf(client);
    const { POST } = await routes.signup;
    const short = await call(POST, "/api/v1/auth/signup", { client, body: { username: "shorty", password: "short" } });
    expect(short.status).toBe(400);
    expect(short.json.error.code).toBe("INVALID_PASSWORD");
    const bad = await call(POST, "/api/v1/auth/signup", { client, body: { username: "Bad Name!", password: "long-enough-pw" } });
    expect(bad.json.error.code).toBe("INVALID_USERNAME");
  });

  it("signs up, sets an HttpOnly session cookie, and reports the user", async () => {
    const client = new Client();
    await ensureCsrf(client);
    const { POST } = await routes.signup;
    const r = await call(POST, "/api/v1/auth/signup", { client, body: { username: "alice_01", password: "long-enough-pw" } });
    expect(r.status).toBe(201);
    expect(r.json.data.user.username).toBe("alice_01");
    expect(r.json.data.user).not.toHaveProperty("password_hash");
    expect(r.headers.getSetCookie().some((c) => /HttpOnly/.test(c) && /SameSite=Lax/.test(c))).toBe(true);
    const me = await call((await routes.me).GET, "/api/v1/auth/me", { client });
    expect(me.json.data.user.username).toBe("alice_01");
  });

  it("rejects a duplicate username", async () => {
    const a = new Client();
    await signupUser(a, "dupe_user");
    const b = new Client();
    await ensureCsrf(b);
    const r = await call((await routes.signup).POST, "/api/v1/auth/signup", { client: b, body: { username: "dupe_user", password: "another-pass-1" } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("USERNAME_TAKEN");
  });

  it("logs in with the right password and rejects the wrong one", async () => {
    const owner = new Client();
    await signupUser(owner, "bob_login", "bob-password-1");
    const other = new Client();
    await ensureCsrf(other);
    const { POST } = await routes.login;
    const bad = await call(POST, "/api/v1/auth/login", { client: other, body: { username: "bob_login", password: "nope-nope-1" } });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("INVALID_CREDENTIALS");
    const good = await call(POST, "/api/v1/auth/login", { client: other, body: { username: "bob_login", password: "bob-password-1" } });
    expect(good.status).toBe(200);
  });

  it("locks an account after repeated failures", async () => {
    const owner = new Client();
    await signupUser(owner, "carol_lock", "carol-password-1");
    const { POST } = await routes.login;
    for (let i = 0; i < 5; i++) {
      const c = new Client();
      await ensureCsrf(c);
      await call(POST, "/api/v1/auth/login", { client: c, body: { username: "carol_lock", password: "wrong-wrong-1" } });
    }
    const c = new Client();
    await ensureCsrf(c);
    const r = await call(POST, "/api/v1/auth/login", { client: c, body: { username: "carol_lock", password: "carol-password-1" } });
    expect(r.status).toBe(429);
    expect(r.json.error.code).toBe("RATE_LIMITED");
  });

  it("logs out and clears the session", async () => {
    const client = new Client();
    await signupUser(client, "dave_out");
    const out = await call((await routes.logout).POST, "/api/v1/auth/logout", { client });
    expect(out.status).toBe(200);
    const me = await call((await routes.me).GET, "/api/v1/auth/me", { client });
    expect(me.json.data.user).toBeNull();
  });

  it("ignores a forged or expired session cookie", async () => {
    const client = new Client();
    client.jar.set("pips_session", "eyJ1aWQiOiJ4In0.bogus-signature");
    const me = await call((await routes.me).GET, "/api/v1/auth/me", { client });
    expect(me.json.data.user).toBeNull();
  });

  it("accepts a password hash created by the earlier Python version", async () => {
    // Simulate an account written by the Flask version (werkzeug hash), then log in through the API.
    const uid = paths.newId();
    const name = "legacy_user";
    const hash = "scrypt:32768:8:1$P9HwgZ7Kfav4CLNo$93171ff6a7ba8f096dbbb9dfbabb03bdea104fabebfc7752876dae184e8a62dd3fa6013e3ccdfe0a824df58f79cb9db23e983bd8dd9b3e6fb4bce4a7f9b6fcf8";
    await storage.write(paths.usernameIndexPath(name), jsonBytes({ user_id: uid }), "seed");
    await storage.write(paths.userPath(uid), jsonBytes({ id: uid, username: name, password_hash: hash, created_at: "2026-01-01T00:00:00Z" }), "seed");
    const c = new Client();
    await ensureCsrf(c);
    const r = await call((await routes.login).POST, "/api/v1/auth/login", { client: c, body: { username: name, password: "correct horse battery" } });
    expect(r.status).toBe(200);
  });
});

describe("apps and API keys", () => {
  it("requires a logged-in owner for app management", async () => {
    const { GET } = await appsRoute();
    const r = await call(GET, "/api/v1/apps");
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe("UNAUTHENTICATED");
  });

  it("creates, lists, renames, and soft-deletes an app", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner, "My App");
    const list = await call((await appsRoute()).GET, "/api/v1/apps", { client: owner });
    expect(list.json.data.apps.map((a: any) => a.id)).toContain(appId);

    const patched = await call((await appRoute()).PATCH, `/api/v1/apps/${appId}`, { client: owner, params: { appId }, body: { name: "Renamed" } });
    expect(patched.json.data.app.name).toBe("Renamed");
    const bad = await call((await appRoute()).PATCH, `/api/v1/apps/${appId}`, { client: owner, params: { appId }, body: { owner_id: "x" } });
    expect(bad.json.error.code).toBe("INVALID_FIELDS");

    const noConfirm = await call((await appRoute()).DELETE, `/api/v1/apps/${appId}`, { client: owner, params: { appId }, body: {} });
    expect(noConfirm.json.error.code).toBe("CONFIRMATION_REQUIRED");
    const del = await call((await appRoute()).DELETE, `/api/v1/apps/${appId}`, { client: owner, params: { appId }, body: { confirm: appId } });
    expect(del.json.data.status).toBe("deleted");
    const gone = await call((await appRoute()).GET, `/api/v1/apps/${appId}`, { client: owner, params: { appId } });
    expect(gone.status).toBe(404);
  });

  it("hides other users' apps behind 404", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const stranger = new Client();
    await signupUser(stranger);
    const r = await call((await appRoute()).GET, `/api/v1/apps/${appId}`, { client: stranger, params: { appId } });
    expect(r.status).toBe(404);
  });

  it("creates a key once, never lists the secret, and validates scopes", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const { POST, GET } = await keysRoute();
    const bad = await call(POST, `/api/v1/apps/${appId}/keys`, { client: owner, params: { appId }, body: { name: "k", scopes: ["admin"] } });
    expect(bad.json.error.code).toBe("INVALID_SCOPES");
    const badExp = await call(POST, `/api/v1/apps/${appId}/keys`, { client: owner, params: { appId }, body: { name: "k", scopes: ["db:read"], expires_in_days: 0 } });
    expect(badExp.json.error.code).toBe("INVALID_EXPIRY");

    const key = await createKey(owner, appId, ["db:read"]);
    const list = await call(GET, `/api/v1/apps/${appId}/keys`, { client: owner, params: { appId } });
    expect(list.json.data.keys).toHaveLength(1);
    expect(list.text).not.toContain(key.split(".")[2]);
  });

  it("revokes keys, and a revoked key stops working", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const key = await createKey(owner, appId);
    const kid = key.split(".")[1];
    const { DELETE } = await keyRoute();
    const r = await call(DELETE, `/api/v1/apps/${appId}/keys/${kid}`, { client: owner, params: { appId, keyId: kid } });
    expect(r.status).toBe(200);
    const dbGet = await call((await dbRec()).GET, `/api/v1/db/${appId}/notes/${"a".repeat(24)}`, {
      headers: bearer(key),
      params: { appId, collection: "notes", recordId: "a".repeat(24) },
    });
    expect(dbGet.status).toBe(401);
    expect(dbGet.json.error.code).toBe("INVALID_API_KEY");
  });

  it("rejects forged keys", async () => {
    const r = await call((await dbList()).GET, "/api/v1/db/some-app-000000/notes", {
      headers: bearer("some-app-000000.abc.def"),
      params: { appId: "some-app-000000", collection: "notes" },
    });
    expect(r.status).toBe(401);
  });

  it("does not let an API key manage apps, even with a session cookie", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const key = await createKey(owner, appId);
    const r = await call((await appsRoute()).GET, "/api/v1/apps", { client: owner, headers: bearer(key) });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("PERMISSION_DENIED");
  });
});

describe("database API", () => {
  async function setup() {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const key = await createKey(owner, appId);
    return { owner, appId, key };
  }

  it("creates, reads, lists, patches (with null removal), and deletes records", async () => {
    const { appId, key } = await setup();
    const { POST } = await dbList();
    const created = await call(POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: { appId, collection: "notes" }, body: { text: "first", n: 1 } });
    expect(created.status).toBe(201);
    const rid = created.json.data.record.id;
    expect(created.json.data.record.version).toBe(1);

    const got = await call((await dbRec()).GET, `/api/v1/db/${appId}/notes/${rid}`, { headers: bearer(key), params: { appId, collection: "notes", recordId: rid } });
    expect(got.json.data.record.data).toEqual({ text: "first", n: 1 });

    const patched = await call((await dbRec()).PATCH, `/api/v1/db/${appId}/notes/${rid}`, { headers: bearer(key), params: { appId, collection: "notes", recordId: rid }, body: { n: null, done: true } });
    expect(patched.json.data.record.data).toEqual({ text: "first", done: true });
    expect(patched.json.data.record.version).toBe(2);

    await call((await dbList()).POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: { appId, collection: "notes" }, body: { text: "second" } });
    const list = await call((await dbList()).GET, `/api/v1/db/${appId}/notes?limit=1`, { headers: bearer(key), params: { appId, collection: "notes" } });
    expect(list.json.data.items).toHaveLength(1);
    expect(list.json.data.next_cursor).toBe(1);

    const del = await call((await dbRec()).DELETE, `/api/v1/db/${appId}/notes/${rid}`, { headers: bearer(key), params: { appId, collection: "notes", recordId: rid } });
    expect(del.json.data.deleted).toBe(true);
    const gone = await call((await dbRec()).GET, `/api/v1/db/${appId}/notes/${rid}`, { headers: bearer(key), params: { appId, collection: "notes", recordId: rid } });
    expect(gone.status).toBe(404);
  });

  it("returns 409 for a stale version and accepts the current one", async () => {
    const { appId, key } = await setup();
    const created = await call((await dbList()).POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: { appId, collection: "notes" }, body: { text: "v1" } });
    const rid = created.json.data.record.id;
    const params = { appId, collection: "notes", recordId: rid };
    const first = await call((await dbRec()).PUT, `/api/v1/db/${appId}/notes/${rid}`, { headers: { ...bearer(key), "if-match": "1" }, params, body: { text: "v2" } });
    expect(first.status).toBe(200);
    const stale = await call((await dbRec()).PUT, `/api/v1/db/${appId}/notes/${rid}`, { headers: { ...bearer(key), "if-match": "1" }, params, body: { text: "stale" } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe("VERSION_CONFLICT");
    const viaEnvelope = await call((await dbRec()).PUT, `/api/v1/db/${appId}/notes/${rid}`, { headers: bearer(key), params, body: { data: { text: "v3" }, expected_version: 2 } });
    expect(viaEnvelope.json.data.record.data).toEqual({ text: "v3" });
  });

  it("stores a body that happens to contain a 'data' field as the payload", async () => {
    const { appId, key } = await setup();
    const r = await call((await dbList()).POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: { appId, collection: "notes" }, body: { data: { nested: 1 }, title: "x" } });
    expect(r.json.data.record.data).toEqual({ data: { nested: 1 }, title: "x" });
  });

  it("validates JSON, body shape, size, collection names, and pagination", async () => {
    const { appId, key } = await setup();
    const { POST } = await dbList();
    const p = { appId, collection: "notes" };
    const badJson = await call(POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: p, raw: "not-json" });
    expect(badJson.json.error.code).toBe("INVALID_JSON");
    const arr = await call(POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: p, body: [1, 2] });
    expect(arr.json.error.code).toBe("INVALID_BODY");
    const big = await call(POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: p, body: { blob: "x".repeat(70_000) } });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("RECORD_TOO_LARGE");
    const badColl = await call(POST, `/api/v1/db/${appId}/Bad%20Name`, { headers: bearer(key), params: { appId, collection: "Bad Name" }, body: { a: 1 } });
    expect(badColl.json.error.code).toBe("INVALID_COLLECTION");
    const badPage = await call((await dbList()).GET, `/api/v1/db/${appId}/notes?limit=500`, { headers: bearer(key), params: p });
    expect(badPage.json.error.code).toBe("INVALID_PAGINATION");
    const badType = await call(POST, `/api/v1/db/${appId}/notes`, { headers: bearer(key), params: p, raw: "{}", contentType: "text/plain" });
    expect(badType.json.error.code).toBe("INVALID_CONTENT_TYPE");
  });

  it("rejects requests larger than the request limit with 413", async () => {
    const { appId, key } = await setup();
    const r = await call((await dbList()).POST, `/api/v1/db/${appId}/notes`, {
      headers: { ...bearer(key), "content-length": String(3 * 1024 * 1024) },
      params: { appId, collection: "notes" },
      raw: "{}",
    });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("keeps apps isolated: a key for one app cannot touch another", async () => {
    const owner = new Client();
    await signupUser(owner);
    const a = await createApp(owner, "App A");
    const b = await createApp(owner, "App B");
    const keyA = await createKey(owner, a);
    const r = await call((await dbList()).GET, `/api/v1/db/${b}/notes`, { headers: bearer(keyA), params: { appId: b, collection: "notes" } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("PERMISSION_DENIED");
  });

  it("enforces scopes: a read-only key cannot write", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const readOnly = await createKey(owner, appId, ["db:read"]);
    const r = await call((await dbList()).POST, `/api/v1/db/${appId}/notes`, { headers: bearer(readOnly), params: { appId, collection: "notes" }, body: { a: 1 } });
    expect(r.status).toBe(403);
  });
});

describe("file API", () => {
  async function setup() {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const key = await createKey(owner, appId);
    return { appId, key };
  }

  function upload(name: string, bytes: Buffer, type = "text/plain"): FormData {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return form;
  }

  it("uploads, lists, downloads, and deletes with a sanitized name", async () => {
    const { appId, key } = await setup();
    const up = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(key), form: upload("../../hello.txt", Buffer.from("http bytes")) });
    expect(up.status).toBe(201);
    expect(up.json.data.file.name).toBe("hello.txt");
    const fid = up.json.data.file.id;

    const dl = await call((await fileDownload()).GET, `/api/v1/files/${fid}/download`, { headers: bearer(key), params: { fileId: fid } });
    expect(dl.buf.toString()).toBe("http bytes");
    expect(dl.headers.get("content-disposition")).toContain("attachment");
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");

    const list = await call((await filesRoute()).GET, `/api/v1/files`, { headers: bearer(key) });
    expect(list.json.data.items).toHaveLength(1);
    expect(appId).toBeTruthy();

    const del = await call((await fileRoute()).DELETE, `/api/v1/files/${fid}`, { headers: bearer(key), params: { fileId: fid } });
    expect(del.status).toBe(200);
    const gone = await call((await fileDownload()).GET, `/api/v1/files/${fid}/download`, { headers: bearer(key), params: { fileId: fid } });
    expect(gone.status).toBe(404);
  });

  it("serves risky types as octet-stream, not as the uploaded type", async () => {
    const { key } = await setup();
    const up = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(key), form: upload("page.html", Buffer.from("<script>x</script>"), "text/html") });
    const fid = up.json.data.file.id;
    const dl = await call((await fileDownload()).GET, `/api/v1/files/${fid}/download`, { headers: bearer(key), params: { fileId: fid } });
    expect(dl.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("rejects empty and oversized files", async () => {
    const { key } = await setup();
    const empty = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(key), form: upload("e.txt", Buffer.alloc(0)) });
    expect(empty.json.error.code).toBe("EMPTY_FILE");
    const big = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(key), form: upload("big.bin", Buffer.alloc(1_000_001)) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("FILE_TOO_LARGE");
  });

  it("requires a file field and a key with file scopes", async () => {
    const owner = new Client();
    await signupUser(owner);
    const appId = await createApp(owner);
    const key = await createKey(owner, appId);
    const none = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(key), form: new FormData() });
    expect(none.json.error.code).toBe("MISSING_FILE");
    const dbOnly = await createKey(owner, appId, ["db:read"]);
    const denied = await call((await filesRoute()).GET, `/api/v1/files`, { headers: bearer(dbOnly) });
    expect(denied.status).toBe(403);
  });

  it("returns 404 for a file id that belongs to another app", async () => {
    const owner = new Client();
    await signupUser(owner);
    const a = await createApp(owner, "App A");
    const b = await createApp(owner, "App B");
    const keyA = await createKey(owner, a);
    const keyB = await createKey(owner, b);
    const up = await call((await filesRoute()).POST, `/api/v1/files`, { headers: bearer(keyA), form: upload("a.txt", Buffer.from("a")) });
    const fid = up.json.data.file.id;
    const r = await call((await fileRoute()).GET, `/api/v1/files/${fid}`, { headers: bearer(keyB), params: { fileId: fid } });
    expect(r.status).toBe(404);
  });
});

describe("legacy file API", () => {
  it("accepts the legacy key, and refuses anonymous callers", async () => {
    const anon = await call((await legacyFiles()).GET, "/api/files");
    expect(anon.status).toBe(401);

    const form = new FormData();
    form.append("file", new File([Buffer.from("legacy")], "old.txt"));
    const up = await call((await legacyFiles()).POST, "/api/files", { headers: { "x-api-key": TEST_ENV.LEGACY_API_KEY }, form });
    expect(up.status).toBe(201);
    expect(up.json).toEqual({ name: "old.txt", size: 6, replaced: false });

    const list = await call((await legacyFiles()).GET, "/api/files", { headers: { "x-api-key": TEST_ENV.LEGACY_API_KEY } });
    expect(list.json.files.map((f: any) => f.name)).toContain("old.txt");

    const dl = await call((await legacyFile()).GET, "/api/files/old.txt", { headers: { "x-api-key": TEST_ENV.LEGACY_API_KEY }, params: { name: "old.txt" } });
    expect(dl.buf.toString()).toBe("legacy");

    const del = await call((await legacyFile()).DELETE, "/api/files/old.txt", { headers: { "x-api-key": TEST_ENV.LEGACY_API_KEY }, params: { name: "old.txt" } });
    expect(del.json).toEqual({ deleted: "old.txt" });
  });

  it("lets a logged-in session use the legacy endpoints (with CSRF)", async () => {
    const user = new Client();
    await signupUser(user);
    const form = new FormData();
    form.append("file", new File([Buffer.from("s")], "s.txt"));
    const ok = await call((await legacyFiles()).POST, "/api/files", { client: user, form });
    expect(ok.status).toBe(201);
    const noCsrf = await call((await legacyFiles()).POST, "/api/files", { client: user, form: new FormData(), noCsrf: true });
    expect(noCsrf.status).toBe(403);
  });
});

describe("CORS and error handling", () => {
  it("echoes only allowlisted origins, with credentials, and never a wildcard", async () => {
    const pre = await preflight();
    const allowed = pre(new Request("http://t/api/v1/apps", { method: "OPTIONS", headers: { origin: "https://app.example.com" } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const denied = pre(new Request("http://t/api/v1/apps", { method: "OPTIONS", headers: { origin: "https://evil.example.com" } }));
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    expect(denied.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("returns the JSON envelope with no stack traces for unexpected failures", async () => {
    const user = new Client();
    await signupUser(user);
    storage.write = async () => {
      throw new Error("internal detail with ghp_leak_me_123");
    };
    const res = await call((await appsRoute()).POST, "/api/v1/apps", { client: user, body: { name: "x" } });
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe("INTERNAL_ERROR");
    expect(res.text).not.toContain("ghp_leak_me_123");
    expect(res.text).not.toContain("internal detail");
  });

  it("sends security headers on API responses", async () => {
    const r = await call((await health()).GET, "/api/health");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-request-id")).toMatch(/^[a-f0-9]{16}$/);
  });
});
