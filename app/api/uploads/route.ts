import { handleUpload } from "@vercel/blob/client";

import { errorJson, okJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAllowedPathname(pathname: string): boolean {
  return /^sessions\/[a-zA-Z0-9-]+\/raw\/.+/.test(pathname);
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!isAllowedPathname(pathname)) {
          throw new Error("Invalid upload target.");
        }

        return {
          addRandomSuffix: false,
        };
      },
      onUploadCompleted: async () => {
        return;
      },
    });

    return okJson(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create upload token.";
    return errorJson(message, 500);
  }
}
