import { authenticate } from "@/lib/accounts";
import { apiRoute, clientIp, csrfToken, logIn, ok, preflight, readJson } from "@/lib/api";

export const OPTIONS = preflight;

export const POST = apiRoute(async (ctx) => {
  const body = await readJson(ctx);
  const user = await authenticate(ctx.storage, body.username ?? "", body.password ?? "", clientIp(ctx.req));
  logIn(ctx, user);
  return ok(ctx, { user, csrf_token: csrfToken(ctx) });
});
