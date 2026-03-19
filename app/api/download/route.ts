import { readLocalStoredFile } from "@/lib/server/blob-storage";
import { detectMimeType } from "@/lib/compiler/utils";
import { errorJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAllowedPathname(pathname: string): boolean {
  return /^sessions\/[a-zA-Z0-9-]+\/(?:raw|outputs)\/.+/.test(pathname);
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const pathname = searchParams.get("pathname");

    if (!pathname || !isAllowedPathname(pathname)) {
      return errorJson("Invalid download pathname.");
    }

    const content = await readLocalStoredFile(pathname);
    return new Response(content, {
      headers: {
        "Content-Type": detectMimeType(pathname),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to download file.";
    return errorJson(message, 404);
  }
}
