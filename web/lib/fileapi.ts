/**
 * Helpers shared by the app-scoped file routes.
 */
import { principal, readBodyLimited, type Ctx } from "./api";
import { ApiError } from "./errors";
import type { KeyPrincipal, Principal } from "./apps";

/** Resolve who is calling and which app they act on. Key principals are bound to one app. */
export async function filePrincipal(ctx: Ctx): Promise<{ p: Principal; appId: string }> {
  const p = await principal(ctx);
  const appId = p.kind === "key" ? (p as KeyPrincipal).appId : (ctx.url.searchParams.get("app_id") ?? "");
  return { p, appId };
}

/** Read the uploaded file from a multipart body, or throw MISSING_FILE. */
export async function uploadedFile(ctx: Ctx): Promise<{ name: string; data: Buffer }> {
  const raw = await readBodyLimited(ctx.req, ctx.cfg.maxRequestBytes);
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(raw), {
      headers: { "content-type": ctx.req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    throw new ApiError(400, "MISSING_FILE", "Send the file in form field 'file'.");
  }
  const value = form.get("file");
  if (!value || typeof value === "string") {
    throw new ApiError(400, "MISSING_FILE", "Send the file in form field 'file'.");
  }
  return { name: value.name ?? "", data: Buffer.from(await value.arrayBuffer()) };
}
