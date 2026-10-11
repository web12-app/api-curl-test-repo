"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { apiCall, ApiCallError } from "@/lib/client";

export default function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isSignup = mode === "signup";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiCall("POST", isSignup ? "/api/v1/auth/signup" : "/api/v1/auth/login", { username, password });
      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiCallError ? err.message : "Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h1>{isSignup ? "Create an account" : "Log in"}</h1>
      <form onSubmit={submit}>
        <label htmlFor="username">Username</label>
        <input
          id="username"
          name="username"
          type="text"
          required
          autoComplete="username"
          pattern="[A-Za-z0-9_]{3,32}"
          title="3-32 letters, digits, or underscores"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={isSignup ? 8 : undefined}
          autoComplete={isSignup ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Please wait…" : isSignup ? "Sign up" : "Log in"}
          </button>
        </div>
      </form>
      <p className="muted">
        {isSignup ? (
          <>Already have an account? <a href="/login">Log in</a></>
        ) : (
          <>New here? <a href="/signup">Sign up</a></>
        )}
      </p>
    </div>
  );
}
