import { apiRoute, csrfToken, ok, preflight } from "@/lib/api";

export const OPTIONS = preflight;

// Issues the CSRF token for this session. Send it back as X-CSRF-Token on writes.
export const GET = apiRoute(async (ctx) => ok(ctx, { csrf_token: csrfToken(ctx) }));
