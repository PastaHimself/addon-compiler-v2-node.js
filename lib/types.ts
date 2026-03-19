export type PackTargetType =
  | "resourcePack"
  | "behaviorPack"
  | "addOnPack"
  | "world";

export type EntrySourceType = "folder" | "archive";

export type WarningType =
  | "DEPENDENCY_CONFLICT"
  | "NAME_MISMATCH"
  | "DUPLICATE_UUID";

export interface ManifestDependency {
  uuid?: string;
  module_name?: string;
  version?: string;
}

export interface ManifestData {
  header?: {
    name?: string;
    uuid?: string;
  };
  dependencies?: ManifestDependency[];
  modules?: Array<{
    type?: string;
  }>;
}

export interface BaseCatalogEntry {
  id: string;
  kind: PackTargetType;
  cleanName: string;
  sourceType: EntrySourceType;
  logicalPath: string;
  absolutePath: string;
  iconAbsolutePath?: string;
  iconUploadPath?: string;
  sourceArchiveName?: string;
}

export interface ResourcePackEntry extends BaseCatalogEntry {
  kind: "resourcePack";
  uuid: string;
  isSignatures: boolean;
}

export interface BehaviorPackEntry extends BaseCatalogEntry {
  kind: "behaviorPack";
  uuid: string;
  isSignatures: boolean;
  dependenciesUUID: string[];
  scriptState: string;
}

export interface RequiredPackRef {
  id: string;
  cleanName: string;
  kind: "resourcePack" | "behaviorPack";
  logicalPath: string;
  iconUploadPath?: string;
}

export interface AddonEntry {
  id: string;
  kind: "addOnPack";
  cleanName: string;
  resourcePack: ResourcePackEntry;
  behaviorPack: BehaviorPackEntry;
}

export interface WorldEntry extends BaseCatalogEntry {
  kind: "world";
  requiredRP: RequiredPackRef[];
  requiredBP: RequiredPackRef[];
}

export interface PackWarning {
  type: WarningType;
  message: string;
  resourcePackId?: string;
  involvedBehaviorPackIds?: string[];
  winnerBehaviorPackId?: string;
  conflictingResourcePackIds?: string[];
  conflictingBehaviorPackIds?: string[];
}

export interface WorkspaceCatalog {
  sessionId: string;
  resourcePacks: ResourcePackEntry[];
  addOns: AddonEntry[];
  behaviorPacks: BehaviorPackEntry[];
  worlds: WorldEntry[];
  warnings: PackWarning[];
}

export interface CompileRequest {
  sessionId: string;
  targetType: PackTargetType;
  targetId: string;
  format: "mcaddon" | "zip";
}

export interface TransformResult {
  downloadUrl: string;
  filename: string;
  summary: string;
  warnings?: PackWarning[];
  logLines?: string[];
}

export interface UploadedBlobInfo {
  pathname: string;
  url: string;
  localFilePath?: string;
}

export interface DiscoveredDirectory {
  absolutePath: string;
  logicalPath: string;
  sourceType: EntrySourceType;
  sourceArchiveName?: string;
  rawRoot: string;
}

export interface WorkspacePaths {
  rootDir: string;
  rawDir: string;
  extractedDir: string;
}
