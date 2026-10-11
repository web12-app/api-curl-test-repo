import { requireAppScope } from "@/lib/apps";
import { apiRoute, ok, preflight } from "@/lib/api";
import { filePrincipal, uploadedFile } from "@/lib/fileapi";
import * as files from "@/lib/files";

export const OPTIONS = preflight;

export const GET = apiRoute(async (ctx) => {
  const { p, appId } = await filePrincipal(ctx);
  await requireAppScope(ctx.storage, p, appId, "files:read");
  const sp = ctx.url.searchParams;
  return ok(ctx, await files.listFiles(ctx.storage, appId, sp.get("limit") ?? undefined, sp.get("cursor") ?? undefined));
});

export const POST = apiRoute(async (ctx) => {
  const { p, appId } = await filePrincipal(ctx);
  await requireAppScope(ctx.storage, p, appId, "files:write");
  const file = await uploadedFile(ctx);
  const createdBy = p.kind === "key" ? `key:${p.keyId}` : `user:${p.userId}`;
  const meta = await files.upload(ctx.storage, ctx.cfg.maxFileBytes, appId, file.name, file.data, createdBy);
  return ok(ctx, { file: meta }, 201);
});
