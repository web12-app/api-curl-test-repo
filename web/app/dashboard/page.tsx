"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiCall, ApiCallError, csrfToken } from "@/lib/client";

interface App {
  id: string;
  name: string;
  description: string;
}

interface Key {
  id: string;
  name: string;
  environment: string;
  scopes: string[];
  revoked_at: string | null;
}

interface LegacyFile {
  name: string;
  sha: string;
}

const SCOPES = ["db:read", "db:write", "files:read", "files:write"];

function errText(e: unknown): string {
  return e instanceof ApiCallError ? e.message : "Something went wrong. Try again.";
}

export default function DashboardPage() {
  const router = useRouter();
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    apiCall<{ user: { username: string } | null }>("GET", "/api/v1/auth/me")
      .then((d) => {
        if (!d.data?.user) router.replace("/login");
        else setUsername(d.data.user.username);
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  if (username === null) return <p className="muted">Loading…</p>;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="muted">Signed in as <strong>{username}</strong></p>
      <AppsPanel />
      <LegacyFilesPanel />
    </>
  );
}

// ---------------------------------------------------------------- apps and keys
function AppsPanel() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [current, setCurrent] = useState<App | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiCall<{ apps: App[] }>("GET", "/api/v1/apps");
      setApps(d.data?.apps ?? []);
    } catch (e) {
      setStatus({ text: errText(e), ok: false });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    try {
      await apiCall("POST", "/api/v1/apps", { name: name.trim() });
      setName("");
      setStatus({ text: "App created.", ok: true });
      load();
    } catch (err) {
      setStatus({ text: errText(err), ok: false });
    }
  }

  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Your apps</h3>
        <form className="inline" onSubmit={create}>
          <input
            type="text"
            maxLength={80}
            placeholder="New app name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn" type="submit">Create app</button>
        </form>
        {status && <p className={status.ok ? "ok" : "error"}>{status.text}</p>}
        <table>
          <tbody>
            {apps === null && <tr><td className="muted">Loading…</td></tr>}
            {apps?.length === 0 && <tr><td className="muted">No apps yet. Create one above.</td></tr>}
            {apps?.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name}
                  <div className="muted">{a.id}</div>
                </td>
                <td className="right">
                  <button className="btn secondary small" onClick={() => setCurrent(a)}>Manage keys</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current && <KeysPanel app={current} />}
    </>
  );
}

function KeysPanel({ app }: { app: App }) {
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [name, setName] = useState("");
  const [env, setEnv] = useState("development");
  const [scopes, setScopes] = useState<string[]>(["db:read", "db:write"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await apiCall<{ keys: Key[] }>("GET", `/api/v1/apps/${encodeURIComponent(app.id)}/keys`);
      setKeys(d.data?.keys ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }, [app.id]);

  useEffect(() => {
    setSecret(null);
    setError("");
    load();
  }, [app.id, load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    try {
      const d = await apiCall<{ key: { api_key: string } }>(
        "POST",
        `/api/v1/apps/${encodeURIComponent(app.id)}/keys`,
        { name: name.trim(), environment: env, scopes },
      );
      setSecret(d.data?.key.api_key ?? null);
      setName("");
      load();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function revoke(kid: string) {
    if (!confirm("Revoke this key? Requests using it will stop working.")) return;
    try {
      await apiCall("DELETE", `/api/v1/apps/${encodeURIComponent(app.id)}/keys/${encodeURIComponent(kid)}`);
      load();
    } catch (err) {
      setError(errText(err));
    }
  }

  function toggleScope(s: string) {
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>API keys for {app.name}</h3>
      <form className="inline" onSubmit={create}>
        <input type="text" maxLength={80} placeholder="Key name" required value={name} onChange={(e) => setName(e.target.value)} />
        <select value={env} onChange={(e) => setEnv(e.target.value)} style={{ width: "auto" }}>
          <option value="development">development</option>
          <option value="production">production</option>
        </select>
        {SCOPES.map((s) => (
          <label key={s} className="check">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggleScope(s)} /> {s}
          </label>
        ))}
        <button className="btn" type="submit" disabled={scopes.length === 0}>Create key</button>
      </form>
      {error && <p className="error">{error}</p>}
      {secret && (
        <div className="warn">
          <p><strong>Copy this key now.</strong> It will not be shown again.</p>
          <code>{secret}</code>
        </div>
      )}
      <table>
        <tbody>
          {keys === null && <tr><td className="muted">Loading…</td></tr>}
          {keys?.length === 0 && <tr><td className="muted">No keys yet.</td></tr>}
          {keys?.map((k) => (
            <tr key={k.id}>
              <td>
                {k.name}
                <div className="muted">
                  {k.environment} · {k.scopes.join(", ")} · {k.revoked_at ? "revoked" : "active"}
                </div>
              </td>
              <td className="right">
                {!k.revoked_at && (
                  <button className="btn danger small" onClick={() => revoke(k.id)}>Revoke</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------- legacy file storage
function LegacyFilesPanel() {
  const [files, setFiles] = useState<LegacyFile[] | null>(null);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [picked, setPicked] = useState<File | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/files", { credentials: "same-origin" });
    if (!r.ok) {
      setStatus({ text: "Could not load files.", ok: false });
      return;
    }
    const j = await r.json();
    setFiles(j.files ?? []);
  }, []);

  useEffect(() => {
    load().catch(() => setStatus({ text: "Could not load files.", ok: false }));
  }, [load]);

  async function upload() {
    if (!picked) return setStatus({ text: "Choose a file first.", ok: false });
    const fd = new FormData();
    fd.append("file", picked, picked.name);
    const r = await fetch("/api/files", {
      method: "POST",
      headers: { "X-CSRF-Token": await csrfToken() },
      body: fd,
      credentials: "same-origin",
    });
    if (!r.ok) return setStatus({ text: "Upload failed.", ok: false });
    setStatus({ text: `Uploaded ${picked.name}`, ok: true });
    setPicked(null);
    load();
  }

  async function download(name: string) {
    const r = await fetch(`/api/files/${encodeURIComponent(name)}`, { credentials: "same-origin" });
    if (!r.ok) return setStatus({ text: "Download failed.", ok: false });
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }

  async function remove(name: string) {
    if (!confirm(`Delete ${name}?`)) return;
    const r = await fetch(`/api/files/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": await csrfToken() },
      credentials: "same-origin",
    });
    if (!r.ok) return setStatus({ text: "Delete failed.", ok: false });
    load();
  }

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Upload a file (legacy storage)</h3>
      <input type="file" onChange={(e) => setPicked(e.target.files?.[0] ?? null)} />
      <div className="actions">
        <button className="btn" onClick={upload}>Upload</button>
      </div>
      {status && <p className={status.ok ? "ok" : "error"}>{status.text}</p>}
      <table>
        <tbody>
          {files === null && <tr><td className="muted">Loading…</td></tr>}
          {files?.length === 0 && <tr><td className="muted">No files yet.</td></tr>}
          {files?.map((f) => (
            <tr key={f.name}>
              <td>{f.name}</td>
              <td className="right">
                <button className="btn secondary small" onClick={() => download(f.name)}>Download</button>
                <button className="btn danger small" onClick={() => remove(f.name)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
