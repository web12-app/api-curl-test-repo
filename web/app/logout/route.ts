import type { Config } from "@/lib/config";
import { clearSessionCookie } from "@/lib/session";
import { getServices } from "@/lib/services";

// Clears the session cookie and returns to the home page. Matches the earlier Flask behavior.
export async function GET(req: Request) {
  let cookieCfg: Pick<Config, "cookieSecure" | "cookieSameSite"> = { cookieSecure: true, cookieSameSite: "Lax" };
  try {
    cookieCfg = getServices().config;
  } catch {
    // Misconfigured: still clear the cookie with safe defaults.
  }
  const headers = new Headers({ Location: new URL("/", req.url).toString() });
  headers.append("Set-Cookie", clearSessionCookie(cookieCfg));
  return new Response(null, { status: 302, headers });
}
