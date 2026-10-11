import * as paths from "@/lib/paths";
import { requireAppScope } from "@/lib/apps";
import { apiRoute, preflight } from "@/lib/api";
import { filePrincipal } from "@/lib/fileapi";
import * as files from "@/lib/files";

export const OPTIONS = preflight;

type Params = { fileId: string };

export const GET = apiRoute<Params>(async (ctx, { fileId }) => {
  const { p, appId } = await filePrincipal(ctx);
  await requireAppScope(ctx.storage, p, appId, "files:read");
  paths.fileId(fileId);
  const { meta, data } = await files.readContent(ctx.storage, appId, fileId);
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": meta.content_type,
      "Content-Disposition": `attachment; filename="${meta.name}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});
