import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

import { buildArtifactForTarget } from "@/lib/compiler/archive";
import { buildWorkspaceCatalog } from "@/lib/compiler/catalog";
import { cleanName } from "@/lib/compiler/utils";
import { extractUploadedArchives } from "@/lib/server/workspace";
import {
  normalizeAddonAndBuildArtifact,
  updateScriptVersionAndBuildArtifact,
} from "@/lib/compiler/transforms";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "addon-compiler-test-"));
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

async function writeText(filePath: string, value: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value);
}

async function zipDirectory(sourceDir: string, destinationFile: string) {
  const zip = new JSZip();

  async function addDirectory(currentDir: string, relativeDir = ""): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await addDirectory(entryPath, relativePath);
        continue;
      }

      zip.file(relativePath.replaceAll("\\", "/"), await fs.readFile(entryPath));
    }
  }

  await addDirectory(sourceDir);
  await fs.writeFile(destinationFile, await zip.generateAsync({ type: "nodebuffer" }));
}

async function createResourcePack(rootDir: string, folderName: string, uuid: string, displayName: string) {
  const packDir = path.join(rootDir, folderName);
  await writeJson(path.join(packDir, "manifest.json"), {
    format_version: 2,
    header: {
      name: "pack.name",
      uuid,
      version: [1, 0, 0],
    },
    modules: [
      {
        type: "resources",
        uuid: `${uuid}-module`,
        version: [1, 0, 0],
      },
    ],
  });
  await writeText(path.join(packDir, "texts", "en_US.lang"), `pack.name=${displayName}\nitem.demo:glow_ore.name=Glow Ore\n`);
  await fs.mkdir(path.join(packDir, "textures"), { recursive: true });
  await fs.writeFile(path.join(packDir, "pack_icon.png"), "icon");
  return packDir;
}

async function createBehaviorPack(
  rootDir: string,
  folderName: string,
  uuid: string,
  displayName: string,
  dependencyUuid?: string,
  scriptVersion = "1.8.0-beta",
) {
  const packDir = path.join(rootDir, folderName);
  const dependencies = [
    {
      module_name: "@minecraft/server",
      version: scriptVersion,
    },
  ];
  if (dependencyUuid) {
    dependencies.unshift({ uuid: dependencyUuid });
  }

  await writeJson(path.join(packDir, "manifest.json"), {
    format_version: 2,
    header: {
      name: "pack.name",
      uuid,
      version: [1, 0, 0],
    },
    modules: [
      {
        type: "data",
        uuid: `${uuid}-module`,
        version: [1, 0, 0],
      },
    ],
    dependencies,
  });
  await writeText(path.join(packDir, "texts", "en_US.lang"), `pack.name=${displayName}\n`);
  await fs.mkdir(path.join(packDir, "items"), { recursive: true });
  await fs.writeFile(path.join(packDir, "pack_icon.png"), "icon");
  return packDir;
}

async function createWorld(rootDir: string, folderName: string, displayName: string, rpUuid: string, bpUuid: string) {
  const worldDir = path.join(rootDir, folderName);
  await writeText(path.join(worldDir, "levelname.txt"), `${displayName}\n`);
  await writeJson(path.join(worldDir, "world_resource_packs.json"), [{ pack_id: rpUuid }]);
  await writeJson(path.join(worldDir, "world_behavior_packs.json"), [{ pack_id: bpUuid }]);
  await fs.writeFile(path.join(worldDir, "world_icon.jpeg"), "icon");
  return worldDir;
}

describe("compiler port", () => {
  test("cleanName strips known RP/BP suffixes", () => {
    expect(cleanName("Dungeon-BP")).toBe("Dungeon");
    expect(cleanName("Skylands Resource Pack")).toBe("Skylands Pack");
  });

  test("buildWorkspaceCatalog pairs packs into add-ons and resolves world dependencies", async () => {
    const rawDir = await makeTempDir();
    try {
      const rpUuid = "11111111-1111-1111-1111-111111111111";
      const bpUuid = "22222222-2222-2222-2222-222222222222";

      await createResourcePack(rawDir, "Demo RP", rpUuid, "Demo Resource");
      await createBehaviorPack(rawDir, "Demo BP", bpUuid, "Demo Behavior", rpUuid);
      await createWorld(rawDir, "Demo World", "My Demo World", rpUuid, bpUuid);

      const catalog = await buildWorkspaceCatalog("test-session", rawDir, []);

      expect(catalog.addOns).toHaveLength(1);
      expect(catalog.addOns[0].resourcePack.cleanName).toBe("Demo Resource");
      expect(catalog.addOns[0].behaviorPack.cleanName).toBe("Demo Behavior");
      expect(catalog.worlds).toHaveLength(1);
      expect(catalog.worlds[0].requiredRP).toHaveLength(1);
      expect(catalog.worlds[0].requiredBP).toHaveLength(1);
      expect(catalog.warnings).toEqual([]);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
    }
  });

  test("buildWorkspaceCatalog emits duplicate UUID warnings", async () => {
    const rawDir = await makeTempDir();
    try {
      const duplicateUuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      await createResourcePack(rawDir, "Duplicate RP One", duplicateUuid, "Duplicate RP One");
      await createResourcePack(rawDir, "Duplicate RP Two", duplicateUuid, "Duplicate RP Two");

      const catalog = await buildWorkspaceCatalog("duplicate-session", rawDir, []);

      expect(catalog.warnings.some((warning) => warning.type === "DUPLICATE_UUID")).toBe(true);
      expect(catalog.resourcePacks).toHaveLength(1);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
    }
  });

  test("buildWorkspaceCatalog detects archive-root packs without an enclosing folder", async () => {
    const rawDir = await makeTempDir();
    const extractedDir = await makeTempDir();
    try {
      await writeJson(path.join(extractedDir, "manifest.json"), {
        format_version: 2,
        header: {
          name: "pack.name",
          uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          version: [1, 0, 0],
        },
        modules: [
          {
            type: "resources",
            uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbc",
            version: [1, 0, 0],
          },
        ],
      });
      await writeText(path.join(extractedDir, "texts", "en_US.lang"), "pack.name=Root Archive Pack\n");

      const catalog = await buildWorkspaceCatalog("archive-root-session", rawDir, [
        { absolutePath: extractedDir, archiveName: "root.mcpack" },
      ]);

      expect(catalog.resourcePacks).toHaveLength(1);
      expect(catalog.resourcePacks[0].cleanName).toBe("Root Archive Pack");
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
      await fs.rm(extractedDir, { recursive: true, force: true });
    }
  });

  test("extractUploadedArchives unwraps nested mcpack files inside mcaddon uploads", async () => {
    const rawDir = await makeTempDir();
    const sourceDir = await makeTempDir();
    const extractedDir = await makeTempDir();
    try {
      const rpUuid = "71111111-1111-1111-1111-111111111111";
      const bpUuid = "72222222-2222-2222-2222-222222222222";
      const rpDir = path.join(sourceDir, "Chat RP");
      const bpDir = path.join(sourceDir, "Chat BP");

      await createResourcePack(sourceDir, "Chat RP", rpUuid, "Chat RP");
      await createBehaviorPack(sourceDir, "Chat BP", bpUuid, "Chat BP", rpUuid);

      const rpArchive = path.join(sourceDir, "chat addon RP.mcpack");
      const bpArchive = path.join(sourceDir, "chatAddon.mcpack");
      await zipDirectory(rpDir, rpArchive);
      await zipDirectory(bpDir, bpArchive);

      const outerArchive = new JSZip();
      outerArchive.file(path.basename(rpArchive), await fs.readFile(rpArchive));
      outerArchive.file(path.basename(bpArchive), await fs.readFile(bpArchive));
      await fs.writeFile(
        path.join(rawDir, "chat addon Revamp.mcaddon"),
        await outerArchive.generateAsync({ type: "nodebuffer" }),
      );

      const extractedRoots = await extractUploadedArchives(rawDir, extractedDir);
      const catalog = await buildWorkspaceCatalog("nested-archive-session", rawDir, extractedRoots);

      expect(catalog.addOns).toHaveLength(1);
      expect(catalog.addOns[0].resourcePack.cleanName).toBe("Chat RP");
      expect(catalog.addOns[0].behaviorPack.cleanName).toBe("Chat BP");
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
      await fs.rm(sourceDir, { recursive: true, force: true });
      await fs.rm(extractedDir, { recursive: true, force: true });
    }
  });

  test("buildArtifactForTarget returns correct export extensions", async () => {
    const rawDir = await makeTempDir();
    try {
      const rpUuid = "31111111-1111-1111-1111-111111111111";
      const bpUuid = "32222222-2222-2222-2222-222222222222";
      const standaloneRpUuid = "33333333-3333-3333-3333-333333333333";
      const standaloneBpUuid = "34444444-4444-4444-4444-444444444444";

      await createResourcePack(rawDir, "Addon RP", rpUuid, "Addon Resource");
      await createBehaviorPack(rawDir, "Addon BP", bpUuid, "Addon Behavior", rpUuid);
      await createResourcePack(rawDir, "Standalone RP", standaloneRpUuid, "Standalone Resource");
      await createBehaviorPack(rawDir, "Standalone BP", standaloneBpUuid, "Standalone Behavior", undefined, "null-script");
      await createWorld(rawDir, "Artifact World", "Artifact World", rpUuid, bpUuid);

      const catalog = await buildWorkspaceCatalog("artifact-session", rawDir, []);

      const addOnArtifact = await buildArtifactForTarget(catalog, catalog.addOns[0], "mcaddon");
      const resourceArtifact = await buildArtifactForTarget(catalog, catalog.resourcePacks[0], "mcaddon");
      const behaviorArtifact = await buildArtifactForTarget(catalog, catalog.behaviorPacks[0], "mcaddon");
      const worldArtifact = await buildArtifactForTarget(catalog, catalog.worlds[0], "mcaddon");

      expect(addOnArtifact.filename.endsWith(".mcaddon")).toBe(true);
      expect(resourceArtifact.filename.endsWith(".mcpack")).toBe(true);
      expect(behaviorArtifact.filename.endsWith(".mcpack")).toBe(true);
      expect(worldArtifact.filename.endsWith(".mcworld")).toBe(true);
      expect(addOnArtifact.buffer.byteLength).toBeGreaterThan(0);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
    }
  });

  test("buildArtifactForTarget keeps stable pack folder names for archive-root add-ons", async () => {
    const rawDir = await makeTempDir();
    const extractedRpDir = await makeTempDir();
    const extractedBpDir = await makeTempDir();
    try {
      const rpUuid = "61111111-1111-1111-1111-111111111111";
      const bpUuid = "62222222-2222-2222-2222-222222222222";

      await writeJson(path.join(extractedRpDir, "manifest.json"), {
        format_version: 2,
        header: {
          name: "pack.name",
          uuid: rpUuid,
          version: [1, 0, 0],
        },
        modules: [
          {
            type: "resources",
            uuid: "61111111-1111-1111-1111-111111111112",
            version: [1, 0, 0],
          },
        ],
      });
      await writeText(path.join(extractedRpDir, "texts", "en_US.lang"), "pack.name=Archive Root RP\n");

      await writeJson(path.join(extractedBpDir, "manifest.json"), {
        format_version: 2,
        header: {
          name: "pack.name",
          uuid: bpUuid,
          version: [1, 0, 0],
        },
        modules: [
          {
            type: "data",
            uuid: "62222222-2222-2222-2222-222222222223",
            version: [1, 0, 0],
          },
        ],
        dependencies: [
          {
            uuid: rpUuid,
          },
          {
            module_name: "@minecraft/server",
            version: "1.8.0-beta",
          },
        ],
      });
      await writeText(path.join(extractedBpDir, "texts", "en_US.lang"), "pack.name=Archive Root BP\n");

      const catalog = await buildWorkspaceCatalog("archive-addon-session", rawDir, [
        { absolutePath: extractedRpDir, archiveName: "Archive Root RP.mcpack" },
        { absolutePath: extractedBpDir, archiveName: "Archive Root BP.mcpack" },
      ]);

      expect(catalog.addOns).toHaveLength(1);

      const artifact = await buildArtifactForTarget(catalog, catalog.addOns[0], "zip");
      const archive = await JSZip.loadAsync(artifact.buffer);
      const archiveEntries = Object.keys(archive.files);

      expect(archiveEntries.some((name) => name.startsWith("Archive Root RP/manifest.json"))).toBe(true);
      expect(archiveEntries.some((name) => name.startsWith("Archive Root BP/manifest.json"))).toBe(true);
      expect(archiveEntries.some((name) => /^1-|^2-/.test(name))).toBe(false);
      expect(artifact.filename.endsWith(".zip")).toBe(true);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
      await fs.rm(extractedRpDir, { recursive: true, force: true });
      await fs.rm(extractedBpDir, { recursive: true, force: true });
    }
  });

  test("updateScriptVersionAndBuildArtifact rewrites the Script API version", async () => {
    const rawDir = await makeTempDir();
    try {
      const rpUuid = "41111111-1111-1111-1111-111111111111";
      const bpUuid = "42222222-2222-2222-2222-222222222222";

      await createResourcePack(rawDir, "Rewrite RP", rpUuid, "Rewrite Resource");
      const behaviorDir = await createBehaviorPack(rawDir, "Rewrite BP", bpUuid, "Rewrite Behavior", rpUuid, "2.1.0-beta");
      const catalog = await buildWorkspaceCatalog("rewrite-session", rawDir, []);

      const artifact = await updateScriptVersionAndBuildArtifact(
        catalog,
        catalog.addOns[0],
        "2.1.0-beta",
        "beta",
      );

      const manifestContent = await fs.readFile(path.join(behaviorDir, "manifest.json"), "utf8");
      expect(manifestContent.includes('"version": "beta"')).toBe(true);
      expect(artifact.filename.endsWith(".mcaddon")).toBe(true);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
    }
  });

  test("normalizeAddonAndBuildArtifact renames files based on en_US.lang keys", async () => {
    const rawDir = await makeTempDir();
    try {
      const rpUuid = "51111111-1111-1111-1111-111111111111";
      const bpUuid = "52222222-2222-2222-2222-222222222222";

      await createResourcePack(rawDir, "Normalize RP", rpUuid, "Normalize Resource");
      const behaviorDir = await createBehaviorPack(rawDir, "Normalize BP", bpUuid, "Normalize Behavior", rpUuid);
      await writeJson(path.join(behaviorDir, "items", "glow_ore.json"), {
        "minecraft:item": {
          description: {
            identifier: "demo:glow_ore",
          },
        },
      });

      const catalog = await buildWorkspaceCatalog("normalize-session", rawDir, []);
      const result = await normalizeAddonAndBuildArtifact(catalog, catalog.addOns[0]);

      expect(result.logLines.some((line) => line.includes("Glow Ore"))).toBe(true);
      await expect(fs.access(path.join(behaviorDir, "items", "Glow Ore.json"))).resolves.toBeUndefined();
      expect(result.filename.endsWith(".mcaddon")).toBe(true);

      const archive = await JSZip.loadAsync(result.buffer);
      expect(Object.keys(archive.files).some((name) => name.endsWith("Glow Ore.json"))).toBe(true);
    } finally {
      await fs.rm(rawDir, { recursive: true, force: true });
    }
  });
});
