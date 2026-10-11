import { legacyAuth, apiRoute, legacyError, preflight } from "@/lib/api";
import * as paths from "@/lib/paths";

export const OPTIONS = preflight;

type Params = { name: string };

export const GET = apiRoute<Params>(async (ctx, { name }) => {
  legacyAuth(ctx);
  const safe = paths.safeFilename(name);
  const got = await ctx.storage.read(`files/${safe}`);
  if (!got) return legacyError(ctx, 404, "File not found.");
  return new Response(new Uint8Array(got.data), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const DELETE = apiRoute<Params>(async (ctx, { name }) => {
  legacyAuth(ctx);
  const safe = paths.safeFilename(name);
  const got = await ctx.storage.read(`files/${safe}`);
  if (!got) return legacyError(ctx, 404, "File not found.");
  await ctx.storage.delete(`files/${safe}`, got.sha, `delete ${safe}`);
  return Response.json({ deleted: safe });
});
