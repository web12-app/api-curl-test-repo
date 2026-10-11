import { apiRoute, logOut, ok, preflight } from "@/lib/api";

export const OPTIONS = preflight;

export const POST = apiRoute(async (ctx) => {
  logOut(ctx);
  return ok(ctx, { logged_out: true });
});
