import { promises as fs } from "node:fs";
import path from "node:path";

import JSZip from "jszip";

import type {
  AddonEntry,
  BehaviorPackEntry,
  ResourcePackEntry,
  WorkspaceCatalog,
  WorldEntry,
} from "@/lib/types";
import { sanitizeFileName, toPosix, withFileExtension } from "@/lib/compiler/utils";

export interface ArtifactBuildResult {
  buffer: Buffer;
  filename: string;
  summary: string;
}

async function collectFiles(sourceDir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    files.push(entryPath);
  }
  return files;
}

async function addDirectoryToZip(zip: JSZip, sourceDir: string, zipPrefix = "") {
  const files = await collectFiles(sourceDir);
  for (const filePath of files) {
    const relativePath = toPosix(path.relative(sourceDir, filePath));
    const archivePath = zipPrefix ? toPosix(path.join(zipPrefix, relativePath)) : relativePath;
    zip.file(archivePath, await fs.readFile(filePath));
  }
}

function resolvePackArchiveRootName(
  entry: ResourcePackEntry | BehaviorPackEntry | WorldEntry,
): string {
  const currentDirName = path.basename(entry.absolutePath);
  if (entry.sourceType !== "archive" || !entry.sourceArchiveName) {
    return currentDirName;
  }

  const archiveLogicalPath = `archive/${toPosix(entry.sourceArchiveName)}`;
  if (entry.logicalPath !== archiveLogicalPath) {
    return currentDirName;
  }

  return sanitizeFileName(path.basename(entry.sourceArchiveName, path.extname(entry.sourceArchiveName)));
}

function buildOutputFilename(
  type: "resourcePack" | "behaviorPack" | "addOnPack" | "world",
  cleanName: string,
  format: "mcaddon" | "zip",
): string {
  const baseName = sanitizeFileName(cleanName);
  switch (type) {
    case "resourcePack":
      return withFileExtension(`${baseName} Resource Pack`, "mcpack");
    case "behaviorPack":
      return withFileExtension(`${baseName} Behavior Pack`, "mcpack");
    case "world":
      return withFileExtension(`${baseName} World`, "mcworld");
    default:
      return withFileExtension(`${baseName} Addon`, format);
  }
}

function allResourcePacks(catalog: WorkspaceCatalog): ResourcePackEntry[] {
  return [...catalog.resourcePacks, ...catalog.addOns.map((entry) => entry.resourcePack)];
}

function allBehaviorPacks(catalog: WorkspaceCatalog): BehaviorPackEntry[] {
  return [...catalog.behaviorPacks, ...catalog.addOns.map((entry) => entry.behaviorPack)];
}

function resolveWorldDependencyPacks(
  catalog: WorkspaceCatalog,
  world: WorldEntry,
): { resourcePacks: ResourcePackEntry[]; behaviorPacks: BehaviorPackEntry[] } {
  const resourcePackMap = new Map(allResourcePacks(catalog).map((entry) => [entry.id, entry]));
  const behaviorPackMap = new Map(allBehaviorPacks(catalog).map((entry) => [entry.id, entry]));

  return {
    resourcePacks: world.requiredRP
      .map((required) => resourcePackMap.get(required.id))
      .filter((entry): entry is ResourcePackEntry => Boolean(entry)),
    behaviorPacks: world.requiredBP
      .map((required) => behaviorPackMap.get(required.id))
      .filter((entry): entry is BehaviorPackEntry => Boolean(entry)),
  };
}

async function buildResourcePackArtifact(resourcePack: ResourcePackEntry): Promise<ArtifactBuildResult> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, resourcePack.absolutePath);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer,
    filename: buildOutputFilename("resourcePack", resourcePack.cleanName, "mcaddon"),
    summary: `Compiled resource pack ${resourcePack.cleanName}.`,
  };
}

async function buildBehaviorPackArtifact(behaviorPack: BehaviorPackEntry): Promise<ArtifactBuildResult> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, behaviorPack.absolutePath);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer,
    filename: buildOutputFilename("behaviorPack", behaviorPack.cleanName, "mcaddon"),
    summary: `Compiled behavior pack ${behaviorPack.cleanName}.`,
  };
}

async function buildAddonArtifact(
  addOn: AddonEntry,
  format: "mcaddon" | "zip",
): Promise<ArtifactBuildResult> {
  const zip = new JSZip();
  await addDirectoryToZip(
    zip,
    addOn.resourcePack.absolutePath,
    resolvePackArchiveRootName(addOn.resourcePack),
  );
  await addDirectoryToZip(
    zip,
    addOn.behaviorPack.absolutePath,
    resolvePackArchiveRootName(addOn.behaviorPack),
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return {
    buffer,
    filename: buildOutputFilename("addOnPack", addOn.cleanName, format),
    summary: `Compiled add-on ${addOn.cleanName}.`,
  };
}

async function buildWorldArtifact(
  catalog: WorkspaceCatalog,
  world: WorldEntry,
): Promise<ArtifactBuildResult> {
  const zip = new JSZip();
  await addDirectoryToZip(zip, world.absolutePath);

  const requiredPacks = resolveWorldDependencyPacks(catalog, world);
  for (const resourcePack of requiredPacks.resourcePacks) {
    await addDirectoryToZip(
      zip,
      resourcePack.absolutePath,
      path.join("resource_packs", resolvePackArchiveRootName(resourcePack)),
    );
  }

  for (const behaviorPack of requiredPacks.behaviorPacks) {
    await addDirectoryToZip(
      zip,
      behaviorPack.absolutePath,
      path.join("behavior_packs", resolvePackArchiveRootName(behaviorPack)),
    );
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    buffer,
    filename: buildOutputFilename("world", world.cleanName, "mcaddon"),
    summary: `Compiled world ${world.cleanName}.`,
  };
}

export async function buildArtifactForTarget(
  catalog: WorkspaceCatalog,
  target: ResourcePackEntry | BehaviorPackEntry | AddonEntry | WorldEntry,
  format: "mcaddon" | "zip",
): Promise<ArtifactBuildResult> {
  switch (target.kind) {
    case "resourcePack":
      return buildResourcePackArtifact(target);
    case "behaviorPack":
      return buildBehaviorPackArtifact(target);
    case "addOnPack":
      return buildAddonArtifact(target, format);
    case "world":
      return buildWorldArtifact(catalog, target);
    default:
      throw new Error("Unsupported compile target.");
  }
}
