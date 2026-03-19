import { list, put } from "@vercel/blob";

import type { UploadedBlobInfo } from "@/lib/types";
import { detectMimeType, sanitizeFileName } from "@/lib/compiler/utils";

export function ensureBlobToken() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not configured.");
  }
}

export async function listSessionUploads(sessionId: string): Promise<UploadedBlobInfo[]> {
  ensureBlobToken();

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
  ensureBlobToken();

  const safeFilename = sanitizeFileName(filename);
  const pathname = `sessions/${sessionId}/outputs/${Date.now()}-${safeFilename}`;
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
