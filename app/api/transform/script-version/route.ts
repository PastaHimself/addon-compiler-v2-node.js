import { updateScriptVersionAndBuildArtifact } from "@/lib/compiler/transforms";
import { errorJson, okJson } from "@/lib/server/http";
import { uploadArtifact } from "@/lib/server/blob-storage";
import { loadSessionCatalog, requireCatalogTarget } from "@/lib/server/session-catalog";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  let cleanup: (() => Promise<void>) | undefined;

  try {
    const body = (await request.json()) as {
      sessionId?: string;
      targetId?: string;
      fromVersion?: string;
      toVersion?: string;
    };

    if (!body.sessionId || !body.targetId || !body.toVersion) {
      return errorJson("sessionId, targetId, and toVersion are required.");
    }

    const loaded = await loadSessionCatalog(body.sessionId);
    cleanup = loaded.cleanup;

    const target = requireCatalogTarget(loaded.catalog, body.targetId);
    if (target.kind !== "behaviorPack" && target.kind !== "addOnPack") {
      return errorJson("Script version updates only support behavior packs and add-ons.");
    }

    const artifact = await updateScriptVersionAndBuildArtifact(
      loaded.catalog,
      target,
      body.fromVersion ?? "",
      body.toVersion,
    );
    const uploaded = await uploadArtifact(body.sessionId, artifact.filename, artifact.buffer);

    return okJson({
      downloadUrl: uploaded.downloadUrl,
      filename: uploaded.filename,
      summary: `Updated Script API version for ${target.cleanName}.`,
      warnings: loaded.catalog.warnings,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to update the Script API version.";
    return errorJson(message, 500);
  } finally {
    await cleanup?.();
  }
}
