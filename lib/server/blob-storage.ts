import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { list, put } from "@vercel/blob";

import type { UploadedBlobInfo } from "@/lib/types";
import { detectMimeType, sanitizeFileName } from "@/lib/compiler/utils";

const LOCAL_STORAGE_ROOT = path.join(os.tmpdir(), "addon-compiler-local-storage");

function hasBlobToken() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function ensureInside(rootDir: string, candidate: string) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedCandidate = path.resolve(candidate);
  const allowedPrefix = `${resolvedRoot}${path.sep}`;
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(allowedPrefix)) {
    throw new Error("Invalid storage pathname.");
  }
  return resolvedCandidate;
}

function getLocalStoragePath(pathnameValue: string) {
  const segments = pathnameValue.split("/").filter(Boolean);
  if (!segments.length) {
    throw new Error("Invalid storage pathname.");
  }
  return ensureInside(LOCAL_STORAGE_ROOT, path.join(LOCAL_STORAGE_ROOT, ...segments));
}

function buildLocalDownloadUrl(pathnameValue: string) {
  return `/api/download?pathname=${encodeURIComponent(pathnameValue)}`;
}

async function collectLocalFiles(currentDir: string): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectLocalFiles(entryPath)));
      continue;
    }
    files.push(entryPath);
  }

  return files;
}

export function isBlobConfigured() {
  return hasBlobToken();
}

async function toBuffer(content: ReadableStream<Uint8Array> | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(content)) {
    return content;
  }

  const response = new Response(content);
  return Buffer.from(await response.arrayBuffer());
}

export async function storeUpload(
  pathnameValue: string,
  content: ReadableStream<Uint8Array> | Buffer,
  contentType?: string,
) {
  const buffer = await toBuffer(content);

  if (hasBlobToken()) {
    return put(pathnameValue, buffer, {
      access: "public",
      addRandomSuffix: false,
      contentType,
    });
  }

  const destinationPath = getLocalStoragePath(pathnameValue);

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);

  return {
    pathname: pathnameValue,
    url: buildLocalDownloadUrl(pathnameValue),
  };
}

export async function readLocalStoredFile(pathnameValue: string): Promise<Buffer> {
  const filePath = getLocalStoragePath(pathnameValue);
  return fs.readFile(filePath);
}

export async function listSessionUploads(sessionId: string): Promise<UploadedBlobInfo[]> {
  if (!hasBlobToken()) {
    const rootDir = path.join(LOCAL_STORAGE_ROOT, "sessions", sessionId, "raw");
    const localFiles = await collectLocalFiles(rootDir);
    return localFiles.map((filePath) => {
      const relativePath = path.relative(LOCAL_STORAGE_ROOT, filePath).replaceAll("\\", "/");
      return {
        pathname: relativePath,
        url: buildLocalDownloadUrl(relativePath),
        localFilePath: filePath,
      };
    });
  }

  const prefix = `sessions/${sessionId}/raw/`;
  const uploads: UploadedBlobInfo[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({
      cursor,
      limit: 1000,
      prefix,
    });

    uploads.push(
      ...page.blobs.map((blob) => ({
        pathname: blob.pathname,
        url: "downloadUrl" in blob && typeof blob.downloadUrl === "string" ? blob.downloadUrl : blob.url,
      })),
    );

    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return uploads;
}

export async function uploadArtifact(
  sessionId: string,
  filename: string,
  content: Buffer,
): Promise<{ downloadUrl: string; filename: string }> {
  const safeFilename = sanitizeFileName(filename);
  const pathname = `sessions/${sessionId}/outputs/${Date.now()}-${safeFilename}`;

  if (!hasBlobToken()) {
    await storeUpload(pathname, content, detectMimeType(filename));
    return {
      downloadUrl: buildLocalDownloadUrl(pathname),
      filename: safeFilename,
    };
  }

  const result = await put(pathname, content, {
    access: "public",
    addRandomSuffix: false,
    contentType: detectMimeType(filename),
  });

  return {
    downloadUrl:
      "downloadUrl" in result && typeof result.downloadUrl === "string"
        ? result.downloadUrl
        : result.url,
    filename: safeFilename,
  };
}
