import { promises as fs } from "node:fs";
import path from "node:path";

import type { AddonEntry, BehaviorPackEntry, ManifestData, WorkspaceCatalog } from "@/lib/types";
import { buildArtifactForTarget, type ArtifactBuildResult } from "@/lib/compiler/archive";

function extractPreTileString(input: string): string {
  const nameIndex = input.indexOf(".name");
  if (nameIndex === -1) {
    return "";
  }
  return input.slice(5, nameIndex);
}

function extractPreEntityString(input: string): string {
  const nameIndex = input.indexOf(".name");
  if (nameIndex === -1) {
    return "";
  }
  return input.slice(7, nameIndex);
}

function extractPostString(input: string): string {
  const equalIndex = input.indexOf("=");
  if (equalIndex === -1) {
    return "";
  }
  return input.slice(equalIndex + 1).replace(/\t#$/, "").trim();
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function renameFileSafe(sourcePath: string, nextFilename: string): Promise<boolean> {
  const targetPath = path.join(path.dirname(sourcePath), `${nextFilename}.json`);
  if (sourcePath === targetPath) {
    return true;
  }

  try {
    await fs.rename(sourcePath, targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function updateScriptVersionAndBuildArtifact(
  catalog: WorkspaceCatalog,
  target: BehaviorPackEntry | AddonEntry,
  fromVersion: string,
  toVersion: string,
): Promise<ArtifactBuildResult> {
  const behaviorPack = target.kind === "addOnPack" ? target.behaviorPack : target;
  const manifestPath = path.join(behaviorPack.absolutePath, "manifest.json");
  const manifest = await readJson<ManifestData>(manifestPath);
  if (!manifest?.dependencies?.length) {
    throw new Error("The selected pack does not declare any Script API dependency.");
  }

  let updated = false;
  for (const dependency of manifest.dependencies) {
    if (dependency.module_name !== "@minecraft/server" || !dependency.version) {
      continue;
    }

    if (!fromVersion || dependency.version === fromVersion) {
      dependency.version = toVersion;
      updated = true;
    }
  }

  if (!updated) {
    for (const dependency of manifest.dependencies) {
      if (dependency.module_name === "@minecraft/server") {
        dependency.version = toVersion;
        updated = true;
      }
    }
  }

  if (!updated) {
    throw new Error("The selected pack does not contain a writable Script API dependency.");
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return buildArtifactForTarget(catalog, target, "mcaddon");
}

export async function normalizeAddonAndBuildArtifact(
  catalog: WorkspaceCatalog,
  addOn: AddonEntry,
): Promise<ArtifactBuildResult & { logLines: string[] }> {
  const logLines: string[] = [];
  const resourcePackPath = addOn.resourcePack.absolutePath;
  const behaviorPackPath = addOn.behaviorPack.absolutePath;

  const languageContent = await fs.readFile(path.join(resourcePackPath, "texts", "en_US.lang"), "utf8");
  const entityEntries: string[][] = [];
  const itemEntries: string[][] = [];
  const tileEntries: string[][] = [];

  for (const line of languageContent.split(/\r?\n/)) {
    if (line.startsWith("entity.")) {
      entityEntries.push([extractPreEntityString(line), extractPostString(line)]);
      continue;
    }
    if (line.startsWith("item.")) {
      itemEntries.push([extractPreTileString(line), extractPostString(line)]);
      continue;
    }
    if (line.startsWith("tile.")) {
      tileEntries.push([extractPreTileString(line), extractPostString(line)]);
    }
  }

  const tilePath = path.join(behaviorPackPath, "blocks");
  const tileFiles = await fs.readdir(tilePath, { withFileTypes: true }).catch(() => []);
  for (const file of tileFiles) {
    if (!file.isFile() || !file.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(tilePath, file.name);
    const blockInfo = await readJson<{
      "minecraft:block"?: {
        components?: {
          "minecraft:geometry"?: {
            identifier?: string;
          };
        };
        description?: {
          identifier?: string;
        };
      };
    }>(filePath);
    const identifier = blockInfo?.["minecraft:block"]?.description?.identifier;
    if (!identifier) {
      continue;
    }

    for (const tileEntry of tileEntries) {
      if (identifier !== tileEntry[0]) {
        continue;
      }
      const geometryIdentifier =
        blockInfo?.["minecraft:block"]?.components?.["minecraft:geometry"]?.identifier;
      if (geometryIdentifier && geometryIdentifier !== "minecraft:geometry.full_block") {
        tileEntry[2] = geometryIdentifier;
      }
      logLines.push(`Renaming Tile: ${tileEntry[0]} to ${tileEntry[1]}`);
      await renameFileSafe(filePath, tileEntry[1]);
      break;
    }
  }

  const modelBlocksPath = path.join(resourcePackPath, "models", "blocks");
  async function walkModelFiles(currentDir: string): Promise<string[]> {
    const files: string[] = [];
    const entries = await fs.readdir(currentDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkModelFiles(entryPath)));
        continue;
      }
      if (entry.name.endsWith(".json")) {
        files.push(entryPath);
      }
    }
    return files;
  }

  for (const filePath of await walkModelFiles(modelBlocksPath)) {
    const modelInfo = await readJson<{
      "minecraft:geometry"?: Array<{
        description?: {
          identifier?: string;
        };
      }>;
    }>(filePath);
    const geometryIdentifier = modelInfo?.["minecraft:geometry"]?.[0]?.description?.identifier;
    if (!geometryIdentifier) {
      continue;
    }

    for (let index = 0; index < tileEntries.length; index += 1) {
      const tileEntry = tileEntries[index];
      if (!tileEntry[2] || tileEntry[2] !== geometryIdentifier) {
        continue;
      }
      logLines.push(`Renaming Tile Model: ${tileEntry[2]} to ${tileEntry[1]}`);
      await renameFileSafe(filePath, tileEntry[1]);
      tileEntries.splice(index, 1);
      break;
    }
  }

  const behaviorEntityPath = path.join(behaviorPackPath, "entities");
  const behaviorEntityFiles = await fs.readdir(behaviorEntityPath, { withFileTypes: true }).catch(() => []);
  for (const file of behaviorEntityFiles) {
    if (!file.isFile() || !file.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(behaviorEntityPath, file.name);
    const entityInfo = await readJson<{
      "minecraft:entity"?: {
        description?: {
          identifier?: string;
        };
      };
    }>(filePath);
    const identifier = entityInfo?.["minecraft:entity"]?.description?.identifier;
    if (!identifier) {
      continue;
    }

    for (const entityEntry of entityEntries) {
      if (identifier !== entityEntry[0]) {
        continue;
      }
      logLines.push(`Renaming Entity: ${entityEntry[0]} to ${entityEntry[1]}`);
      await renameFileSafe(filePath, entityEntry[1]);
      break;
    }
  }

  const resourceEntityPath = path.join(resourcePackPath, "entity");
  const resourceEntityFiles = await fs.readdir(resourceEntityPath, { withFileTypes: true }).catch(() => []);
  for (const file of resourceEntityFiles) {
    if (!file.isFile() || !file.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(resourceEntityPath, file.name);
    const entityInfo = await readJson<{
      "minecraft:client_entity"?: {
        description?: {
          identifier?: string;
        };
      };
    }>(filePath);
    const identifier = entityInfo?.["minecraft:client_entity"]?.description?.identifier;
    if (!identifier) {
      continue;
    }

    for (const entityEntry of entityEntries) {
      if (identifier !== entityEntry[0]) {
        continue;
      }
      logLines.push(`Renaming Resource Entity: ${entityEntry[0]} to ${entityEntry[1]}`);
      await renameFileSafe(filePath, entityEntry[1]);
      break;
    }
  }

  const itemPath = path.join(behaviorPackPath, "items");
  const itemFiles = await fs.readdir(itemPath, { withFileTypes: true }).catch(() => []);
  for (const file of itemFiles) {
    if (!file.isFile() || !file.name.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(itemPath, file.name);
    const itemInfo = await readJson<{
      "minecraft:item"?: {
        description?: {
          identifier?: string;
        };
      };
    }>(filePath);
    const identifier = itemInfo?.["minecraft:item"]?.description?.identifier;
    if (!identifier) {
      continue;
    }

    for (const itemEntry of itemEntries) {
      if (identifier !== itemEntry[0]) {
        continue;
      }
      logLines.push(`Renaming Item: ${itemEntry[0]} to ${itemEntry[1]}`);
      await renameFileSafe(filePath, itemEntry[1]);
      break;
    }
  }

  const artifact = await buildArtifactForTarget(catalog, addOn, "mcaddon");
  return {
    ...artifact,
    logLines,
  };
}
