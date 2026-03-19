import type { CompileRequest } from "@/lib/types";
import { buildArtifactForTarget } from "@/lib/compiler/archive";
import { errorJson, okJson } from "@/lib/server/http";
import { uploadArtifact } from "@/lib/server/blob-storage";
import { loadSessionCatalog, requireCatalogTarget } from "@/lib/server/session-catalog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const body = (await request.json()) as Partial<CompileRequest>;
    if (!body.sessionId || !body.targetId || !body.targetType || !body.format) {
      return errorJson("sessionId, targetId, targetType, and format are required.");
    }

    const loaded = await loadSessionCatalog(body.sessionId);
    cleanup = loaded.cleanup;

    const target = requireCatalogTarget(loaded.catalog, body.targetId);
    if (target.kind !== body.targetType) {
      return errorJson("The requested target type does not match the uploaded catalog.");
    }

    const artifact = await buildArtifactForTarget(loaded.catalog, target, body.format);
    const uploaded = await uploadArtifact(body.sessionId, artifact.filename, artifact.buffer);

    return okJson({
      downloadUrl: uploaded.downloadUrl,
      filename: uploaded.filename,
      summary: artifact.summary,
      warnings: loaded.catalog.warnings,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to compile target.";
    return errorJson(message, 500);
  } finally {
    await cleanup?.();
  }
}
