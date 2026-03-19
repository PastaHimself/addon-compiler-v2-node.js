import { normalizeAddonAndBuildArtifact } from "@/lib/compiler/transforms";
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
      addonId?: string;
    };

    if (!body.sessionId || !body.addonId) {
      return errorJson("sessionId and addonId are required.");
    }

    const loaded = await loadSessionCatalog(body.sessionId);
    cleanup = loaded.cleanup;

    const target = requireCatalogTarget(loaded.catalog, body.addonId);
    if (target.kind !== "addOnPack") {
      return errorJson("Normalize only supports add-ons with both RP and BP.");
    }

    const artifact = await normalizeAddonAndBuildArtifact(loaded.catalog, target);
    const uploaded = await uploadArtifact(body.sessionId, artifact.filename, artifact.buffer);

    return okJson({
      downloadUrl: uploaded.downloadUrl,
      filename: uploaded.filename,
      summary: `Normalized ${target.cleanName} and generated a fresh add-on archive.`,
      warnings: loaded.catalog.warnings,
      logLines: artifact.logLines,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to normalize the add-on.";
    return errorJson(message, 500);
  } finally {
    await cleanup?.();
  }
}
