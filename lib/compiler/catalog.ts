import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  AddonEntry,
  BehaviorPackEntry,
  DiscoveredDirectory,
  ManifestData,
  PackWarning,
  RequiredPackRef,
  ResourcePackEntry,
  WarningType,
  WorkspaceCatalog,
  WorldEntry,
} from "@/lib/types";
import {
  byCleanName,
  calculateNameSimilarity,
  cleanName,
  makeStableId,
  normalizeRelativePath,
  relativeFrom,
} from "@/lib/compiler/utils";

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function buildWarning(type: WarningType, message: string): PackWarning {
  return { type, message };
}

async function resolvePackName(
  packPath: string,
  entryName: string,
  manifestName: string | undefined,
): Promise<string> {
  if (manifestName !== "pack.name") {
    return entryName;
  }

  const languageFilePath = path.join(packPath, "texts", "en_US.lang");
  const languageContent = await readTextFile(languageFilePath);
  if (!languageContent) {
    return entryName;
  }

  for (const line of languageContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("pack.name=")) {
      continue;
    }
    const [, value = ""] = trimmed.split("=", 2);
    return value.trim() || entryName;
  }

  return entryName;
}

function isWorldDirectory(fileNames: Set<string>): boolean {
  return (
    fileNames.has("levelname.txt") ||
    fileNames.has("world_resource_packs.json") ||
    fileNames.has("world_behavior_packs.json")
  );
}

async function discoverDirectories(
  rootDir: string,
  logicalRoot: string,
  sourceType: "folder" | "archive",
  sourceArchiveName?: string,
): Promise<DiscoveredDirectory[]> {
  const discovered: DiscoveredDirectory[] = [];

  async function visit(currentDir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const relative = path.relative(rootDir, currentDir);
    const logicalPath = relative
      ? `${logicalRoot}/${normalizeRelativePath(relative)}`
      : logicalRoot;

    const fileNames = new Set(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );

    if (isWorldDirectory(fileNames)) {
      discovered.push({
        absolutePath: currentDir,
        logicalPath,
        rawRoot: rootDir,
        sourceArchiveName,
        sourceType,
      });
      return;
    }

    if (fileNames.has("manifest.json")) {
      discovered.push({
        absolutePath: currentDir,
        logicalPath,
        rawRoot: rootDir,
        sourceArchiveName,
        sourceType,
      });
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(currentDir, entry.name));
      }
    }
  }

  await visit(rootDir);
  return discovered;
}

async function readDependencyRefs(
  filePath: string,
  packs: Array<
    Pick<ResourcePackEntry | BehaviorPackEntry, "id" | "cleanName" | "kind" | "logicalPath" | "iconUploadPath"> & {
      uuid: string;
    }
  >,
): Promise<RequiredPackRef[]> {
  const manifestEntries = await readJsonFile<Array<{ pack_id?: string }>>(filePath);
  if (!manifestEntries?.length) {
    return [];
  }

  const refs: RequiredPackRef[] = [];
  for (const manifestEntry of manifestEntries) {
    if (!manifestEntry.pack_id) {
      continue;
    }

    const pack = packs.find((candidate) => candidate.uuid === manifestEntry.pack_id);
    if (!pack) {
      continue;
    }

    refs.push({
      id: pack.id,
      cleanName: pack.cleanName,
      kind: pack.kind,
      logicalPath: pack.logicalPath,
      iconUploadPath: pack.iconUploadPath,
    });
  }

  return refs;
}

async function buildResourcePackEntry(discovered: DiscoveredDirectory): Promise<ResourcePackEntry | null> {
  const manifestPath = path.join(discovered.absolutePath, "manifest.json");
  const manifest = await readJsonFile<ManifestData>(manifestPath);
  const uuid = manifest?.header?.uuid;
  if (!uuid) {
    return null;
  }

  const entryName = path.basename(discovered.absolutePath);
  const resolvedName = await resolvePackName(discovered.absolutePath, entryName, manifest.header?.name);
  const iconAbsolutePath = path.join(discovered.absolutePath, "pack_icon.png");

  return {
    id: makeStableId("resourcePack", discovered.logicalPath),
    kind: "resourcePack",
    cleanName: resolvedName,
    absolutePath: discovered.absolutePath,
    logicalPath: discovered.logicalPath,
    iconAbsolutePath,
    iconUploadPath:
      discovered.sourceType === "folder" ? relativeFrom(discovered.rawRoot, iconAbsolutePath) : undefined,
    sourceArchiveName: discovered.sourceArchiveName,
    sourceType: discovered.sourceType,
    isSignatures: await fs
      .access(path.join(discovered.absolutePath, "signatures.json"))
      .then(() => true)
      .catch(() => false),
    uuid,
  };
}

async function buildBehaviorPackEntry(discovered: DiscoveredDirectory): Promise<BehaviorPackEntry | null> {
  const manifestPath = path.join(discovered.absolutePath, "manifest.json");
  const manifest = await readJsonFile<ManifestData>(manifestPath);
  const uuid = manifest?.header?.uuid;
  if (!uuid) {
    return null;
  }

  const entryName = path.basename(discovered.absolutePath);
  const resolvedName = await resolvePackName(discovered.absolutePath, entryName, manifest.header?.name);
  const iconAbsolutePath = path.join(discovered.absolutePath, "pack_icon.png");

  const dependenciesUUID: string[] = [];
  let scriptState = "null-script";

  for (const dependency of manifest.dependencies ?? []) {
    if (dependency.uuid) {
      dependenciesUUID.push(dependency.uuid);
    }

    if (dependency.module_name === "@minecraft/server" && dependency.version) {
      scriptState = dependency.version;
    }
  }

  return {
    id: makeStableId("behaviorPack", discovered.logicalPath),
    kind: "behaviorPack",
    cleanName: resolvedName,
    absolutePath: discovered.absolutePath,
    logicalPath: discovered.logicalPath,
    iconAbsolutePath,
    iconUploadPath:
      discovered.sourceType === "folder" ? relativeFrom(discovered.rawRoot, iconAbsolutePath) : undefined,
    sourceArchiveName: discovered.sourceArchiveName,
    sourceType: discovered.sourceType,
    isSignatures: await fs
      .access(path.join(discovered.absolutePath, "signatures.json"))
      .then(() => true)
      .catch(() => false),
    uuid,
    dependenciesUUID,
    scriptState,
  };
}

async function buildWorldEntry(
  discovered: DiscoveredDirectory,
  resourcePacks: ResourcePackEntry[],
  behaviorPacks: BehaviorPackEntry[],
): Promise<WorldEntry> {
  const levelName = (await readTextFile(path.join(discovered.absolutePath, "levelname.txt")))?.trim();
  const iconAbsolutePath = path.join(discovered.absolutePath, "world_icon.jpeg");

  return {
    id: makeStableId("world", discovered.logicalPath),
    kind: "world",
    cleanName: levelName || path.basename(discovered.absolutePath),
    absolutePath: discovered.absolutePath,
    logicalPath: discovered.logicalPath,
    iconAbsolutePath,
    iconUploadPath:
      discovered.sourceType === "folder" ? relativeFrom(discovered.rawRoot, iconAbsolutePath) : undefined,
    sourceArchiveName: discovered.sourceArchiveName,
    sourceType: discovered.sourceType,
    requiredRP: await readDependencyRefs(
      path.join(discovered.absolutePath, "world_resource_packs.json"),
      resourcePacks,
    ),
    requiredBP: await readDependencyRefs(
      path.join(discovered.absolutePath, "world_behavior_packs.json"),
      behaviorPacks,
    ),
  };
}

function sanitizeResourcePacks(resourcePacks: ResourcePackEntry[]): {
  valid: ResourcePackEntry[];
  warnings: PackWarning[];
} {
  const grouped = new Map<string, ResourcePackEntry[]>();
  for (const resourcePack of resourcePacks) {
    grouped.set(resourcePack.uuid, [...(grouped.get(resourcePack.uuid) ?? []), resourcePack]);
  }

  const valid: ResourcePackEntry[] = [];
  const warnings: PackWarning[] = [];

  for (const [uuid, group] of grouped.entries()) {
    if (group.length === 1) {
      valid.push(group[0]);
      continue;
    }

    valid.push(group[0]);
    warnings.push({
      ...buildWarning(
        "DUPLICATE_UUID",
        `Duplicate Resource Pack UUID (${uuid}) found in: ${group
          .map((entry) => entry.cleanName)
          .join(", ")}. Using first one.`,
      ),
      conflictingResourcePackIds: group.map((entry) => entry.id),
    });
  }

  return { valid, warnings };
}

function sanitizeBehaviorPacks(behaviorPacks: BehaviorPackEntry[]): {
  valid: BehaviorPackEntry[];
  warnings: PackWarning[];
} {
  const grouped = new Map<string, BehaviorPackEntry[]>();
  for (const behaviorPack of behaviorPacks) {
    grouped.set(behaviorPack.uuid, [...(grouped.get(behaviorPack.uuid) ?? []), behaviorPack]);
  }

  const valid: BehaviorPackEntry[] = [];
  const warnings: PackWarning[] = [];

  for (const [uuid, group] of grouped.entries()) {
    if (group.length === 1) {
      valid.push(group[0]);
      continue;
    }

    valid.push(group[0]);
    warnings.push({
      ...buildWarning(
        "DUPLICATE_UUID",
        `Duplicate Behavior Pack UUID (${uuid}) found in: ${group
          .map((entry) => entry.cleanName)
          .join(", ")}. Using first one.`,
      ),
      conflictingBehaviorPackIds: group.map((entry) => entry.id),
    });
  }

  return { valid, warnings };
}

function sortPacks(
  resourcePacks: ResourcePackEntry[],
  behaviorPacks: BehaviorPackEntry[],
): {
  resourcePacks: ResourcePackEntry[];
  addOns: AddonEntry[];
  behaviorPacks: BehaviorPackEntry[];
  warnings: PackWarning[];
} {
  const warnings: PackWarning[] = [];
  const sanitizedRPs = sanitizeResourcePacks(resourcePacks);
  const sanitizedBPs = sanitizeBehaviorPacks(behaviorPacks);
  warnings.push(...sanitizedRPs.warnings, ...sanitizedBPs.warnings);

  const rpMap = new Map<string, ResourcePackEntry>();
  const rpOrder: string[] = [];
  for (const resourcePack of sanitizedRPs.valid) {
    rpMap.set(resourcePack.uuid, resourcePack);
    rpOrder.push(resourcePack.uuid);
  }

  const claims = new Map<string, BehaviorPackEntry[]>();
  const orphanCandidates = new Map<string, BehaviorPackEntry>();

  for (const behaviorPack of sanitizedBPs.valid) {
    let foundDependency = false;
    for (const dependencyUuid of behaviorPack.dependenciesUUID) {
      if (!rpMap.has(dependencyUuid)) {
        continue;
      }
      claims.set(dependencyUuid, [...(claims.get(dependencyUuid) ?? []), behaviorPack]);
      foundDependency = true;
      break;
    }
    if (!foundDependency) {
      orphanCandidates.set(behaviorPack.uuid, behaviorPack);
    }
  }

  const addOns: AddonEntry[] = [];
  const usedResourcePacks = new Set<string>();
  const usedBehaviorPacks = new Set<string>();

  for (const [resourcePackUuid, bidders] of claims.entries()) {
    const resourcePack = rpMap.get(resourcePackUuid);
    if (!resourcePack) {
      continue;
    }

    let winner: BehaviorPackEntry | null = null;
    let winnerScore = -1;

    for (const bidder of bidders) {
      const score = calculateNameSimilarity(bidder.cleanName, resourcePack.cleanName);
      if (score > winnerScore) {
        winner = bidder;
        winnerScore = score;
      }
    }

    if (!winner) {
      continue;
    }

    if (bidders.length > 1) {
      warnings.push({
        ...buildWarning(
          "DEPENDENCY_CONFLICT",
          `Multiple BPs (${bidders
            .map((entry) => entry.cleanName)
            .join(", ")}) claimed RP '${resourcePack.cleanName}'. Winner: '${winner.cleanName}'`,
        ),
        resourcePackId: resourcePack.id,
        involvedBehaviorPackIds: bidders.map((entry) => entry.id),
        winnerBehaviorPackId: winner.id,
      });
    } else if (winnerScore === 0) {
      warnings.push({
        ...buildWarning(
          "NAME_MISMATCH",
          `BP '${winner.cleanName}' claimed RP '${resourcePack.cleanName}' via UUID, but names look unrelated.`,
        ),
        resourcePackId: resourcePack.id,
        involvedBehaviorPackIds: bidders.map((entry) => entry.id),
        winnerBehaviorPackId: winner.id,
      });
    }

    addOns.push({
      id: makeStableId("addOnPack", `${resourcePack.logicalPath}|${winner.logicalPath}`),
      kind: "addOnPack",
      cleanName: cleanName(winner.cleanName),
      resourcePack,
      behaviorPack: winner,
    });
    usedResourcePacks.add(resourcePack.uuid);
    usedBehaviorPacks.add(winner.uuid);
  }

  const exclusiveResourcePacks = rpOrder
    .map((uuid) => rpMap.get(uuid))
    .filter((entry): entry is ResourcePackEntry => Boolean(entry && !usedResourcePacks.has(entry.uuid)));

  const exclusiveBehaviorPacks: BehaviorPackEntry[] = [];
  for (const behaviorPack of orphanCandidates.values()) {
    exclusiveBehaviorPacks.push(behaviorPack);
  }
  for (const behaviorPack of sanitizedBPs.valid) {
    if (usedBehaviorPacks.has(behaviorPack.uuid)) {
      continue;
    }
    if (orphanCandidates.has(behaviorPack.uuid)) {
      continue;
    }
    exclusiveBehaviorPacks.push(behaviorPack);
  }

  exclusiveResourcePacks.sort(byCleanName);
  exclusiveBehaviorPacks.sort(byCleanName);
  addOns.sort(byCleanName);
  warnings.sort((left, right) => left.message.localeCompare(right.message));

  return {
    resourcePacks: exclusiveResourcePacks,
    addOns,
    behaviorPacks: exclusiveBehaviorPacks,
    warnings,
  };
}

export async function buildWorkspaceCatalog(
  sessionId: string,
  rawDir: string,
  extractedArchiveRoots: Array<{ absolutePath: string; archiveName: string }>,
): Promise<WorkspaceCatalog> {
  const discoveredRoots: DiscoveredDirectory[] = [
    ...(await discoverDirectories(rawDir, "raw", "folder")),
  ];

  for (const extractedArchiveRoot of extractedArchiveRoots) {
    const logicalRoot = `archive/${normalizeRelativePath(extractedArchiveRoot.archiveName)}`;
    discoveredRoots.push(
      ...(await discoverDirectories(
        extractedArchiveRoot.absolutePath,
        logicalRoot,
        "archive",
        extractedArchiveRoot.archiveName,
      )),
    );
  }

  const resourcePacks: ResourcePackEntry[] = [];
  const behaviorPacks: BehaviorPackEntry[] = [];
  const worldDirectories: DiscoveredDirectory[] = [];

  for (const discovered of discoveredRoots) {
    const entryNames = new Set(
      await fs
        .readdir(discovered.absolutePath)
        .then((entries) => entries)
        .catch(() => [] as string[]),
    );
    if (isWorldDirectory(entryNames)) {
      worldDirectories.push(discovered);
      continue;
    }

    const manifest = await readJsonFile<ManifestData>(path.join(discovered.absolutePath, "manifest.json"));
    const behaviorPack = await buildBehaviorPackEntry(discovered);
    const resourcePack = await buildResourcePackEntry(discovered);
    const moduleTypes = new Set((manifest?.modules ?? []).map((module) => module.type).filter(Boolean));

    const bpScore = behaviorPack
      ? Number(moduleTypes.has("data")) * 3 +
        Number(moduleTypes.has("script")) * 2 +
        behaviorPack.dependenciesUUID.length +
        Number(behaviorPack.scriptState !== "null-script") +
        Number(entryNames.has("entities")) +
        Number(entryNames.has("items")) +
        Number(entryNames.has("blocks"))
      : -1;
    const rpScore = resourcePack
      ? Number(moduleTypes.has("resources")) * 3 +
        Number(entryNames.has("textures")) * 2 +
        Number(entryNames.has("models")) +
        Number(entryNames.has("entity")) +
        Number(entryNames.has("animations"))
      : -1;

    if (moduleTypes.has("resources") && resourcePack) {
      resourcePacks.push(resourcePack);
      continue;
    }
    if ((moduleTypes.has("data") || moduleTypes.has("script")) && behaviorPack) {
      behaviorPacks.push(behaviorPack);
      continue;
    }
    if (behaviorPack && bpScore >= rpScore) {
      behaviorPacks.push(behaviorPack);
      continue;
    }
    if (resourcePack) {
      resourcePacks.push(resourcePack);
      continue;
    }
  }

  const sortedPacks = sortPacks(resourcePacks, behaviorPacks);
  const allResourcePacksForWorlds = [
    ...sortedPacks.resourcePacks,
    ...sortedPacks.addOns.map((addon) => addon.resourcePack),
  ];
  const allBehaviorPacksForWorlds = [
    ...sortedPacks.behaviorPacks,
    ...sortedPacks.addOns.map((addon) => addon.behaviorPack),
  ];
  const normalizedWorlds = await Promise.all(
    worldDirectories.map((directory) => buildWorldEntry(directory, allResourcePacksForWorlds, allBehaviorPacksForWorlds)),
  );
  normalizedWorlds.sort(byCleanName);

  return {
    sessionId,
    resourcePacks: sortedPacks.resourcePacks,
    addOns: sortedPacks.addOns,
    behaviorPacks: sortedPacks.behaviorPacks,
    worlds: normalizedWorlds,
    warnings: sortedPacks.warnings,
  };
}

export function findCatalogTarget(catalog: WorkspaceCatalog, targetId: string) {
  return (
    catalog.resourcePacks.find((entry) => entry.id === targetId) ??
    catalog.behaviorPacks.find((entry) => entry.id === targetId) ??
    catalog.addOns.find((entry) => entry.id === targetId) ??
    catalog.worlds.find((entry) => entry.id === targetId) ??
    null
  );
}
