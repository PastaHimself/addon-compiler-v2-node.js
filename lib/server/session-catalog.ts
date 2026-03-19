import type { WorkspaceCatalog, WorkspacePaths } from "@/lib/types";
import { buildWorkspaceCatalog, findCatalogTarget } from "@/lib/compiler/catalog";
import {
  createWorkspacePaths,
  extractUploadedArchives,
  hydrateSessionUploads,
  removeWorkspace,
} from "@/lib/server/workspace";

export interface LoadedSessionCatalog {
  catalog: WorkspaceCatalog;
  paths: WorkspacePaths;
  cleanup: () => Promise<void>;
}

export async function loadSessionCatalog(sessionId: string): Promise<LoadedSessionCatalog> {
  const paths = await createWorkspacePaths(sessionId);
  await hydrateSessionUploads(sessionId, paths.rawDir);
  const extractedArchiveRoots = await extractUploadedArchives(paths.rawDir, paths.extractedDir);
  const catalog = await buildWorkspaceCatalog(sessionId, paths.rawDir, extractedArchiveRoots);

  return {
    catalog,
    paths,
    cleanup: () => removeWorkspace(paths.rootDir),
  };
}

export function requireCatalogTarget(catalog: WorkspaceCatalog, targetId: string) {
  const target = findCatalogTarget(catalog, targetId);
  if (!target) {
    throw new Error("Requested target was not found in the uploaded session.");
  }
  return target;
}
