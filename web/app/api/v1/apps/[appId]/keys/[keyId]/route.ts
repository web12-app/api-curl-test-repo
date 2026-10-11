import { loadOwnedApp, revokeKey } from "@/lib/apps";
import { apiRoute, ok, ownerSessionUserId, preflight } from "@/lib/api";

export const OPTIONS = preflight;

type Params = { appId: string; keyId: string };

export const DELETE = apiRoute<Params>(async (ctx, { appId, keyId }) => {
  const uid = ownerSessionUserId(ctx);
  await loadOwnedApp(ctx.storage, uid, appId);
  return ok(ctx, { key: await revokeKey(ctx.storage, appId, keyId) });
});
