import * as paths from "@/lib/paths";
import { requireAppScope } from "@/lib/apps";
import { apiRoute, ok, preflight } from "@/lib/api";
import { filePrincipal } from "@/lib/fileapi";
import * as files from "@/lib/files";

export const OPTIONS = preflight;

type Params = { fileId: string };

export const GET = apiRoute<Params>(async (ctx, { fileId }) => {
  const { p, appId } = await filePrincipal(ctx);
  await requireAppScope(ctx.storage, p, appId, "files:read");
  paths.fileId(fileId);
  return ok(ctx, { file: await files.getPublic(ctx.storage, appId, fileId) });
});

export const DELETE = apiRoute<Params>(async (ctx, { fileId }) => {
  const { p, appId } = await filePrincipal(ctx);
  await requireAppScope(ctx.storage, p, appId, "files:write");
  paths.fileId(fileId);
  return ok(ctx, await files.remove(ctx.storage, appId, fileId));
});
