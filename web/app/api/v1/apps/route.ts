import { createApp, listOwnedApps } from "@/lib/apps";
import { apiRoute, ok, ownerSessionUserId, preflight, readJson } from "@/lib/api";

export const OPTIONS = preflight;

// Owner session only. API keys cannot manage apps.
export const GET = apiRoute(async (ctx) => {
  const uid = ownerSessionUserId(ctx);
  return ok(ctx, { apps: await listOwnedApps(ctx.storage, uid) });
});

export const POST = apiRoute(async (ctx) => {
  const uid = ownerSessionUserId(ctx);
  const body = await readJson(ctx);
  const app = await createApp(ctx.storage, uid, body.name ?? "", body.description);
  return ok(ctx, { app }, 201);
});
