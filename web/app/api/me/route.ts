import { loadUser } from "@/lib/accounts";
import { apiRoute, preflight } from "@/lib/api";

export const OPTIONS = preflight;

// Legacy alias: returns only the username, in the original response shape.
export const GET = apiRoute(async ({ storage, session }) => {
  const user = await loadUser(storage, session.uid);
  return Response.json({ user: user?.username ?? null });
});
