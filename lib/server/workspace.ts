import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import type { WorkspacePaths } from "@/lib/types";
import { listSessionUploads } from "@/lib/server/blob-storage";
import { normalizeRelativePath, sanitizeFileName } from "@/lib/compiler/utils";

const ARCHIVE_EXTENSIONS = new Set([".zip", ".mcpack", ".mcaddon", ".mcworld"]);

export async function createWorkspacePaths(sessionId: string): Promise<WorkspacePaths> {
  const prefix = path.join(os.tmpdir(), `addon-compiler-${sessionId}-`);
  const rootDir = await fs.mkdtemp(prefix);
  const rawDir = path.join(rootDir, "raw");
  const extractedDir = path.join(rootDir, "archives");

  await fs.mkdir(rawDir, { recursive: true });
  await fs.mkdir(extractedDir, { recursive: true });

  return {
    rootDir,
    rawDir,
    extractedDir,
  };
}

function ensureInside(rootDir: string, candidate: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidate);
  const allowedPrefix = `${resolvedRoot}${path.sep}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(allowedPrefix)) {
    throw new Error("Archive contains an invalid path.");
  }
  return resolvedCandidate;
}

async function downloadBlobToFile(url: string, destinationPath: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download uploaded blob: ${response.status}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, content);
}

export async function hydrateSessionUploads(sessionId: string, rawDir: string): Promise<string[]> {
  const uploads = await listSessionUploads(sessionId);
  const relativePaths: string[] = [];

  for (const upload of uploads) {
    const relativePath = normalizeRelativePath(upload.pathname.replace(`sessions/${sessionId}/raw/`, ""));
    if (!relativePath) {
      continue;
    }
    relativePaths.push(relativePath);
    const destinationPath = ensureInside(rawDir, path.join(rawDir, relativePath));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (upload.localFilePath) {
      await fs.copyFile(upload.localFilePath, destinationPath);
      continue;
    }
    await downloadBlobToFile(upload.url, destinationPath);
  }

  return relativePaths;
}

async function extractArchive(sourcePath: string, destinationDir: string) {
  const content = await fs.readFile(sourcePath);
  const zip = await JSZip.loadAsync(content);

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) {
      continue;
    }

    const normalizedEntryName = normalizeRelativePath(entryName);
    const destinationPath = ensureInside(destinationDir, path.join(destinationDir, normalizedEntryName));
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, await entry.async("nodebuffer"));
  }
}

async function collectFiles(currentDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

export async function extractUploadedArchives(
  rawDir: string,
  extractedDir: string,
): Promise<Array<{ absolutePath: string; archiveName: string }>> {
  const files = await collectFiles(rawDir);
  const roots: Array<{ absolutePath: string; archiveName: string }> = [];
  let index = 0;

  for (const filePath of files) {
    const extension = path.extname(filePath).toLowerCase();
    if (!ARCHIVE_EXTENSIONS.has(extension)) {
      continue;
    }

    index += 1;
    const archiveName = path.basename(filePath);
    const rootName = `${index}-${sanitizeFileName(archiveName).replace(/\s+/g, "-")}`;
    const archiveRoot = path.join(extractedDir, rootName);
    await fs.mkdir(archiveRoot, { recursive: true });
    await extractArchive(filePath, archiveRoot);
    roots.push({
      absolutePath: archiveRoot,
      archiveName,
    });
  }

  return roots;
}

export async function removeWorkspace(rootDir: string) {
  await fs.rm(rootDir, { recursive: true, force: true });
}
