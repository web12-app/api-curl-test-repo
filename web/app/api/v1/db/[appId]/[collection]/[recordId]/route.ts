import * as paths from "@/lib/paths";
import { requireAppScope } from "@/lib/apps";
import { apiRoute, ok, preflight, principal, readJson } from "@/lib/api";
import type { Ctx } from "@/lib/api";
import * as records from "@/lib/records";

export const OPTIONS = preflight;

type Params = { appId: string; collection: string; recordId: string };

/** Version from If-Match (preferred) or ?expected_version=. A body envelope takes precedence. */
function headerExpected(ctx: Ctx): string | undefined {
  return ctx.req.headers.get("if-match") || ctx.url.searchParams.get("expected_version") || undefined;
}

async function validate(ctx: Ctx, appId: string, collection: string, recordId: string) {
  paths.appId(appId);
  paths.collection(collection);
  paths.recordId(recordId);
}

export const GET = apiRoute<Params>(async (ctx, { appId, collection, recordId }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:read");
  await validate(ctx, appId, collection, recordId);
  return ok(ctx, { record: await records.get(ctx.storage, appId, collection, recordId) });
});

export const PUT = apiRoute<Params>(async (ctx, { appId, collection, recordId }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:write");
  await validate(ctx, appId, collection, recordId);
  const [data, bodyExpected] = records.unwrapEnvelope(await readJson(ctx));
  const expected = bodyExpected ?? headerExpected(ctx);
  const rec = await records.replace(ctx.storage, ctx.cfg.maxRecordBytes, appId, collection, recordId, data, expected);
  return ok(ctx, { record: rec });
});

export const PATCH = apiRoute<Params>(async (ctx, { appId, collection, recordId }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:write");
  await validate(ctx, appId, collection, recordId);
  const [changes, bodyExpected] = records.unwrapEnvelope(await readJson(ctx));
  const expected = bodyExpected ?? headerExpected(ctx);
  const rec = await records.patch(ctx.storage, ctx.cfg.maxRecordBytes, appId, collection, recordId, changes, expected);
  return ok(ctx, { record: rec });
});

export const DELETE = apiRoute<Params>(async (ctx, { appId, collection, recordId }) => {
  await requireAppScope(ctx.storage, await principal(ctx), appId, "db:write");
  await validate(ctx, appId, collection, recordId);
  return ok(ctx, await records.remove(ctx.storage, appId, collection, recordId, headerExpected(ctx)), 200);
});
