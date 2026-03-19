import { put } from "@vercel/blob";

import { errorJson, okJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAllowedPathname(pathname: string): boolean {
  return /^sessions\/[a-zA-Z0-9-]+\/raw\/.+/.test(pathname);
}

export async function POST(request: Request) {
  try {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return errorJson(
        "Blob uploads are not configured. Set BLOB_READ_WRITE_TOKEN in Vercel project settings.",
        500,
      );
    }

    const { searchParams } = new URL(request.url);
    const pathname = searchParams.get("pathname");
    if (!pathname || !isAllowedPathname(pathname)) {
      return errorJson("Invalid upload pathname.");
    }

    if (!request.body) {
      return errorJson("Missing upload body.");
    }

    const blob = await put(pathname, request.body, {
      access: "public",
      addRandomSuffix: false,
      contentType: request.headers.get("content-type") ?? undefined,
    });

    return okJson(blob);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to upload file.";
    return errorJson(message, 400);
  }
}
