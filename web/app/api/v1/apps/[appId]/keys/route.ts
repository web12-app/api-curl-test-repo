import { createKey, listKeys, loadOwnedApp } from "@/lib/apps";
import { apiRoute, ok, ownerSessionUserId, preflight, readJson } from "@/lib/api";

export const OPTIONS = preflight;

type Params = { appId: string };

export const GET = apiRoute<Params>(async (ctx, { appId }) => {
  const uid = ownerSessionUserId(ctx);
  await loadOwnedApp(ctx.storage, uid, appId);
  return ok(ctx, { keys: await listKeys(ctx.storage, appId) });
});

export const POST = apiRoute<Params>(async (ctx, { appId }) => {
  const uid = ownerSessionUserId(ctx);
  await loadOwnedApp(ctx.storage, uid, appId);
  const body = await readJson(ctx);
  const key = await createKey(
    ctx.storage,
    ctx.cfg.apiKeyHashSecret,
    appId,
    body.name ?? "",
    body.environment ?? "development",
    body.scopes ?? [],
    body.expires_in_days,
  );
  return ok(ctx, { key, notice: "Store this key now. It will not be shown again." }, 201);
});
