import { errorJson, okJson } from "@/lib/server/http";
import { loadSessionCatalog } from "@/lib/server/session-catalog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const { sessionId } = (await request.json()) as { sessionId?: string };
    if (!sessionId) {
      return errorJson("sessionId is required.");
    }

    const loaded = await loadSessionCatalog(sessionId);
    cleanup = loaded.cleanup;
    return okJson(loaded.catalog);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build catalog.";
    return errorJson(message, 500);
  } finally {
    await cleanup?.();
  }
}
