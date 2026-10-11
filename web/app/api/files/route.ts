import { apiRoute, legacyAuth, legacyError, preflight, readBodyLimited } from "@/lib/api";
import * as paths from "@/lib/paths";

export const OPTIONS = preflight;

// Legacy file API, kept for existing clients. Files live under files/<name> (not app-scoped).
export const GET = apiRoute(async (ctx) => {
  legacyAuth(ctx);
  const items = (await ctx.storage.list("files"))
    .filter((i) => i.type === "file")
    .map((i) => ({ name: i.name, sha: i.sha }));
  return Response.json({ files: items });
});

export const POST = apiRoute(async (ctx) => {
  legacyAuth(ctx);
  const raw = await readBodyLimited(ctx.req, ctx.cfg.maxRequestBytes);
  let file: File | null = null;
  try {
    const form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": ctx.req.headers.get("content-type") ?? "" },
    }).formData();
    const value = form.get("file");
    file = value && typeof value !== "string" ? value : null;
  } catch {
    file = null;
  }
  if (!file) return legacyError(ctx, 400, "Send the file in form field 'file'.");

  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > ctx.cfg.maxFileBytes) return legacyError(ctx, 413, "File too large.");
  const safe = paths.safeFilename(file.name);
  const path = `files/${safe}`;
  const current = await ctx.storage.read(path);
  await ctx.storage.write(path, data, `upload ${safe}`, current?.sha);
  return Response.json({ name: safe, size: data.length, replaced: current !== null }, { status: 201 });
});
