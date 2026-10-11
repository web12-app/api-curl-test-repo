/**
 * Runs once when the server starts. Validates configuration and logs problems by variable name
 * only. Secret values are never printed.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getServices } = await import("./lib/services");
  try {
    getServices();
    console.log("[config] required configuration is present");
  } catch (e) {
    console.error(`[config] ${(e as Error).message}`);
  }
}
