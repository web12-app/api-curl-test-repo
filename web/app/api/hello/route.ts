import { preflight } from "@/lib/api";

export const OPTIONS = preflight;

// Legacy endpoint, kept with its original response for existing clients.
export async function GET() {
  return Response.json({ message: "Hello from Python!", source: "api-curl-test-repo" });
}
