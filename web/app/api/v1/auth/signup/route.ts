import { createUser } from "@/lib/accounts";
import { ApiError } from "@/lib/errors";
import { apiRoute, clientIp, csrfToken, logIn, ok, preflight, readJson } from "@/lib/api";
import { limiter } from "@/lib/ratelimit";

export const OPTIONS = preflight;

const SIGNUP_PER_IP = { limit: 10, windowSec: 3600 };

export const POST = apiRoute(async (ctx) => {
  const body = await readJson(ctx);
  if (!limiter.allow(`signup-ip:${clientIp(ctx.req)}`, SIGNUP_PER_IP.limit, SIGNUP_PER_IP.windowSec)) {
    throw new ApiError(429, "RATE_LIMITED", "Too many signups from this network. Try again later.");
  }
  const user = await createUser(ctx.storage, body.username ?? "", body.password ?? "");
  logIn(ctx, user);
  return ok(ctx, { user, csrf_token: csrfToken(ctx) }, 201);
});
