import { deleteApp, loadOwnedApp, requireAppScope, updateApp } from "@/lib/apps";
import { apiRoute, ok, ownerSessionUserId, preflight, principal, readJson } from "@/lib/api";

export const OPTIONS = preflight;

type Params = { appId: string };

export const GET = apiRoute<Params>(async (ctx, { appId }) => {
  const p = await principal(ctx);
  if (p.kind === "key") {
    return ok(ctx, { app: await requireAppScope(ctx.storage, p, appId, "db:read") });
  }
  return ok(ctx, { app: await loadOwnedApp(ctx.storage, p.userId, appId) });
});

export const PATCH = apiRoute<Params>(async (ctx, { appId }) => {
  const uid = ownerSessionUserId(ctx);
  const body = await readJson(ctx);
  return ok(ctx, { app: await updateApp(ctx.storage, uid, appId, body) });
});

export const DELETE = apiRoute<Params>(async (ctx, { appId }) => {
  const uid = ownerSessionUserId(ctx);
  const body = await readJson(ctx);
  return ok(ctx, await deleteApp(ctx.storage, ctx.cfg.apiKeyHashSecret, uid, appId, body.confirm));
});
