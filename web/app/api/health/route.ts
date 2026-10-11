import { apiRoute, preflight } from "@/lib/api";
import { StorageError } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const OPTIONS = preflight;

// Reports storage status only. Never includes configuration values or repository details.
export const GET = apiRoute(async ({ storage }) => {
  let store: "ok" | "unavailable" = "ok";
  try {
    await storage.check();
  } catch (e) {
    if (!(e instanceof StorageError)) throw e;
    store = "unavailable";
  }
  const status = store === "ok" ? 200 : 503;
  return Response.json(
    { status: store === "ok" ? "ok" : "degraded", storage: store, time: new Date().toISOString() },
    { status },
  );
});
