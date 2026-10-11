import { loadUser } from "@/lib/accounts";
import { apiRoute, ok, preflight } from "@/lib/api";

export const OPTIONS = preflight;

export const GET = apiRoute(async (ctx) => {
  return ok(ctx, { user: await loadUser(ctx.storage, ctx.session.uid) });
});
