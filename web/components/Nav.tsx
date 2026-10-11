"use client";

import { useEffect, useState } from "react";
import { apiCall } from "@/lib/client";

/** Shows Dashboard and Log out when signed in, Log in and Sign up otherwise. */
export default function Nav() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => {
    apiCall<{ user: { username: string } | null }>("GET", "/api/v1/auth/me")
      .then((d) => setSignedIn(Boolean(d.data?.user)))
      .catch(() => setSignedIn(false));
  }, []);

  if (signedIn === null) return <nav />;
  return signedIn ? (
    <nav>
      <a href="/dashboard">Dashboard</a>
      <a href="/logout">Log out</a>
    </nav>
  ) : (
    <nav>
      <a href="/login">Log in</a>
      <a href="/signup">Sign up</a>
    </nav>
  );
}
