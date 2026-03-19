import { createHash } from "node:crypto";
import path from "node:path";

const CLEAN_SUFFIXES = [
  "-RP",
  "RP",
  "-rp",
  "rp",
  "resource",
  "Resource",
  "resource pack",
  "-resource-pack",
  "resource-pack",
  "_resource_pack",
  "resource_pack",
  "-BP",
  "BP",
  "-bp",
  "bp",
  "behavior",
  "Behavior",
  "behavior pack",
  "-behavior-pack",
  "behavior-pack",
  "_behavior_pack",
  "behavior_pack",
];

export function toPosix(input: string): string {
  return input.replaceAll("\\", "/");
}

export function normalizeRelativePath(input: string): string {
  return toPosix(input).replace(/^\/+/, "").replace(/\/+/g, "/");
}

export function cleanName(name: string): string {
  let current = name;
  for (const suffix of CLEAN_SUFFIXES) {
    current = current.replaceAll(suffix, "");
  }
  return current.trim();
}

export function tokenize(input: string): string[] {
  return input.toLowerCase().replaceAll("-", " ").replaceAll("_", " ").split(/\s+/).filter(Boolean);
}

export function calculateNameSimilarity(nameA: string, nameB: string): number {
  const tokensA = tokenize(nameA);
  const tokensB = tokenize(nameB);
  let score = 0;

  for (const a of tokensA) {
    if (a.length < 3) {
      continue;
    }
    for (const b of tokensB) {
      if (b.length < 3) {
        continue;
      }
      if (a === b) {
        score += 1;
      }
    }
  }

  return score;
}

export function byCleanName<T extends { cleanName: string }>(left: T, right: T): number {
  return left.cleanName.toLowerCase().localeCompare(right.cleanName.toLowerCase());
}

export function makeStableId(prefix: string, value: string): string {
  return `${prefix}:${createHash("sha1").update(value).digest("hex").slice(0, 12)}`;
}

export function sanitizeFileName(input: string): string {
  const sanitized = input.replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized || "addon-compiler-export";
}

export function withFileExtension(filename: string, extension: string): string {
  if (filename.endsWith(`.${extension}`)) {
    return filename;
  }
  return `${filename}.${extension}`;
}

export function relativeFrom(rootDir: string, targetPath: string): string {
  return normalizeRelativePath(path.relative(rootDir, targetPath));
}

export function detectMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  switch (extension) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".mcpack":
    case ".mcaddon":
    case ".mcworld":
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
