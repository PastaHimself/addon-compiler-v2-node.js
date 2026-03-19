import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

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

    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!isAllowedPathname(pathname)) {
          throw new Error("Invalid upload target.");
        }

        return {
          addRandomSuffix: false,
          tokenPayload: JSON.stringify({
            pathname,
          }),
        };
      },
      onUploadCompleted: async () => {
        return;
      },
    });

    return okJson(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create upload token.";
    return errorJson(message, 400);
  }
}
