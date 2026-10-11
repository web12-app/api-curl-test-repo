import * as paths from "@/lib/paths";
import { requireAppScope } from "@/lib/apps";
import { apiRoute, ok, preflight, principal, readJson } from "@/lib/api";
import * as records from "@/lib/records";

export const OPTIONS = preflight;

type Params = { appId: string; collection: string };

export const GET = apiRoute<Params>(async (ctx, { appId, collection }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:read");
  paths.appId(appId);
  paths.collection(collection);
  const sp = ctx.url.searchParams;
  const page = await records.listPage(
    ctx.storage,
    appId,
    collection,
    sp.get("limit") ?? undefined,
    sp.get("cursor") ?? undefined,
  );
  return ok(ctx, page);
});

export const POST = apiRoute<Params>(async (ctx, { appId, collection }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:write");
  paths.appId(appId);
  paths.collection(collection);
  const body = await readJson(ctx);
  const rec = await records.create(ctx.storage, ctx.cfg.maxRecordBytes, appId, collection, body);
  return ok(ctx, { record: rec }, 201);
});
