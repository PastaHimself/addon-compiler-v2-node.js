"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AddonEntry,
  BehaviorPackEntry,
  CompileRequest,
  PackWarning,
  ResourcePackEntry,
  WorkspaceCatalog,
  WorldEntry,
} from "@/lib/types";

type ThemeOption = "overworld" | "redstone" | "sandstone";

interface PendingUpload {
  file: File;
  uploadPath: string;
}

interface DownloadItem {
  id: string;
  filename: string;
  downloadUrl: string;
  summary: string;
}

const PREFERENCES_KEY = "addon-compiler-web-preferences";
const MAX_SERVER_UPLOAD_BYTES = 4 * 1024 * 1024;

const directoryInputProps = {
  directory: "",
  webkitdirectory: "",
} as unknown as InputHTMLAttributes<HTMLInputElement>;

function createSessionId() {
  return crypto.randomUUID();
}

function normalizeClientRelativePath(file: File): string {
  const relativePath =
    "webkitRelativePath" in file && typeof file.webkitRelativePath === "string"
      ? file.webkitRelativePath
      : "";

  return (relativePath || file.name).replaceAll("\\", "/").replace(/^\/+/, "");
}

function buildInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatConsoleTimestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Request failed.");
  }
  return payload;
}

async function uploadFileToServer(pathname: string, file: File) {
  const response = await fetch(`/api/uploads?pathname=${encodeURIComponent(pathname)}`, {
    method: "POST",
    body: file,
    headers: file.type
      ? {
          "Content-Type": file.type,
        }
      : undefined,
  });

  const payload = (await response.json()) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || "Upload failed.");
  }
}

function isUpdateableScriptVersion(scriptState: string | undefined): boolean {
  return Boolean(scriptState && scriptState.endsWith("-beta"));
}

function getEntryIconPath(
  entry: ResourcePackEntry | BehaviorPackEntry | WorldEntry,
  previewUrls: Record<string, string>,
) {
  if (!entry.iconUploadPath) {
    return undefined;
  }
  return previewUrls[entry.iconUploadPath];
}

function Section({
  label,
  title,
  children,
}: Readonly<{
  label: string;
  title: string;
  children: ReactNode;
}>) {
  return (
    <section className="panel section-panel">
      <div className="section-header">
        <div>
          <div className="small-label">{label}</div>
          <h2 className="section-title">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

export function AddonCompilerApp() {
  const folderInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [sessionId, setSessionId] = useState<string>(() => createSessionId());
  const [theme, setTheme] = useState<ThemeOption>("overworld");
  const [format, setFormat] = useState<"mcaddon" | "zip">("mcaddon");
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const previewUrlsRef = useRef<Record<string, string>>({});
  const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
  const [status, setStatus] = useState(
    "Select extracted folders or packaged files, then upload them into a session.",
  );
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<DownloadItem[]>([]);
  const [normalizeLog, setNormalizeLog] = useState<string[]>([]);
  const [activityLog, setActivityLog] = useState<string[]>([]);

  useEffect(() => {
    const stored = window.localStorage.getItem(PREFERENCES_KEY);
    if (!stored) {
      document.documentElement.dataset.theme = "overworld";
      return;
    }

    try {
      const parsed = JSON.parse(stored) as {
        theme?: ThemeOption;
        format?: "mcaddon" | "zip";
      };
      if (parsed.theme) {
        setTheme(parsed.theme);
        document.documentElement.dataset.theme = parsed.theme;
      }
      if (parsed.format) {
        setFormat(parsed.format);
      }
    } catch {
      document.documentElement.dataset.theme = "overworld";
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ theme, format }));
  }, [theme, format]);

  useEffect(() => {
    previewUrlsRef.current = previewUrls;
  }, [previewUrls]);

  useEffect(() => {
    return () => {
      Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const catalogStats = useMemo(
    () => ({
      resourcePacks: catalog?.resourcePacks.length ?? 0,
      addOns: catalog?.addOns.length ?? 0,
      behaviorPacks: catalog?.behaviorPacks.length ?? 0,
      worlds: catalog?.worlds.length ?? 0,
    }),
    [catalog],
  );

  function appendActivity(message: string) {
    const line = `[${formatConsoleTimestamp()}] ${message}`;
    setActivityLog((current) => [line, ...current].slice(0, 120));
  }

  function mergePendingFiles(files: FileList | null) {
    if (!files?.length) {
      return;
    }

    setPendingUploads((current) => {
      const next = new Map(current.map((item) => [item.uploadPath, item]));
      const previewNext = { ...previewUrlsRef.current };

      for (const file of Array.from(files)) {
        const uploadPath = normalizeClientRelativePath(file);
        next.set(uploadPath, { file, uploadPath });

        const lowerName = file.name.toLowerCase();
        if (
          lowerName === "pack_icon.png" ||
          lowerName === "world_icon.jpeg" ||
          lowerName === "world_icon.jpg"
        ) {
          if (previewNext[uploadPath]) {
            URL.revokeObjectURL(previewNext[uploadPath]);
          }
          previewNext[uploadPath] = URL.createObjectURL(file);
        }
      }

      setPreviewUrls(previewNext);
      return Array.from(next.values()).sort((left, right) =>
        left.uploadPath.localeCompare(right.uploadPath),
      );
    });

    appendActivity(`Staged ${files.length} file(s) for upload.`);
  }

  async function refreshCatalog(activeSessionId = sessionId) {
    try {
      appendActivity(`Refreshing catalog for session ${activeSessionId}.`);
      const nextCatalog = await postJson<WorkspaceCatalog>("/api/catalog", {
        sessionId: activeSessionId,
      });
      setCatalog(nextCatalog);
      setStatus(`Catalog refreshed for session ${activeSessionId}.`);
      appendActivity(
        `Catalog ready: ${nextCatalog.resourcePacks.length} RP, ${nextCatalog.addOns.length} add-ons, ${nextCatalog.behaviorPacks.length} BP, ${nextCatalog.worlds.length} worlds.`,
      );
      return nextCatalog;
    } catch (error) {
      const message = messageFromUnknown(error);
      setStatus(message);
      appendActivity(`Catalog refresh failed: ${message}`);
      throw error;
    }
  }

  async function uploadPendingFiles() {
    if (!pendingUploads.length) {
      setStatus("There are no selected files to upload.");
      return;
    }

    const oversizedFile = pendingUploads.find((pending) => pending.file.size > MAX_SERVER_UPLOAD_BYTES);
    if (oversizedFile) {
      setStatus(
        `Server uploads on Vercel are limited per file. ${oversizedFile.uploadPath} is too large (${formatBytes(
          oversizedFile.file.size,
        )}).`,
      );
      appendActivity(`Upload blocked: ${oversizedFile.uploadPath} exceeds the server file limit.`);
      return;
    }

    setBusy(true);
    setStatus(`Uploading ${pendingUploads.length} file(s) to session ${sessionId}...`);
    appendActivity(`Uploading ${pendingUploads.length} staged file(s) to session ${sessionId}.`);

    try {
      let completed = 0;
      for (const pending of pendingUploads) {
        await uploadFileToServer(`sessions/${sessionId}/raw/${pending.uploadPath}`, pending.file);
        completed += 1;
        setStatus(`Uploaded ${completed}/${pendingUploads.length} file(s)...`);
        appendActivity(`Uploaded ${pending.uploadPath} (${completed}/${pendingUploads.length}).`);
      }
      await refreshCatalog();
    } catch (error) {
      const message = messageFromUnknown(error);
      setStatus(message);
      appendActivity(`Upload failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  function resetSession() {
    const nextSessionId = createSessionId();
    Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = {};
    setSessionId(nextSessionId);
    setPendingUploads([]);
    setPreviewUrls({});
    setCatalog(null);
    setDownloads([]);
    setNormalizeLog([]);
    setActivityLog([]);
    setStatus(`Started a new local session ${nextSessionId}. Upload files to continue.`);
    appendActivity(`Started new session ${nextSessionId}.`);
  }

  async function runCompile(targetType: CompileRequest["targetType"], targetId: string) {
    setBusy(true);
    setStatus(`Compiling ${targetType}...`);
    appendActivity(`Compiling ${targetType} ${targetId} as ${format}.`);
    try {
      const result = await postJson<Omit<DownloadItem, "id"> & { warnings?: PackWarning[] }>(
        "/api/compile",
        {
          sessionId,
          targetId,
          targetType,
          format,
        },
      );
      setDownloads((current) => [{ ...result, id: crypto.randomUUID() }, ...current]);
      setStatus(result.summary);
      appendActivity(`Compile complete: ${result.filename}.`);
    } catch (error) {
      const message = messageFromUnknown(error);
      setStatus(message);
      appendActivity(`Compile failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runScriptUpdate(targetId: string, fromVersion: string) {
    setBusy(true);
    setStatus("Updating Script API version...");
    appendActivity(`Updating Script API for ${targetId} from ${fromVersion || "current"} to beta.`);
    try {
      const result = await postJson<Omit<DownloadItem, "id">>(
        "/api/transform/script-version",
        {
          sessionId,
          targetId,
          fromVersion,
          toVersion: "beta",
        },
      );
      setDownloads((current) => [{ ...result, id: crypto.randomUUID() }, ...current]);
      setStatus(result.summary);
      appendActivity(`Script API update complete: ${result.filename}.`);
    } catch (error) {
      const message = messageFromUnknown(error);
      setStatus(message);
      appendActivity(`Script API update failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runNormalize(addonId: string) {
    setBusy(true);
    setStatus("Normalizing add-on...");
    appendActivity(`Normalizing add-on ${addonId}.`);
    try {
      const result = await postJson<Omit<DownloadItem, "id"> & { logLines?: string[] }>(
        "/api/transform/normalize",
        {
          sessionId,
          addonId,
        },
      );
      setDownloads((current) => [{ ...result, id: crypto.randomUUID() }, ...current]);
      setNormalizeLog(result.logLines ?? []);
      setStatus(result.summary);
      appendActivity(`Normalize complete: ${result.filename}.`);
    } catch (error) {
      const message = messageFromUnknown(error);
      setStatus(message);
      appendActivity(`Normalize failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  function renderResourcePack(entry: ResourcePackEntry) {
    const iconPath = getEntryIconPath(entry, previewUrls);
    return (
      <article className="entry-card" key={entry.id}>
        <div className="entry-media">
          {iconPath ? (
            <img alt="" src={iconPath} />
          ) : (
            <div className="entry-fallback">{buildInitials(entry.cleanName)}</div>
          )}
        </div>
        <div>
          <h3 className="entry-title">{entry.cleanName}</h3>
          <div className="entry-meta">{entry.logicalPath}</div>
          <div className="badge-row">
            <span className="badge">UUID {entry.uuid}</span>
            <span className="badge">
              {entry.sourceType === "folder" ? "Folder upload" : "Archive import"}
            </span>
            {entry.isSignatures ? <span className="badge">Has signatures</span> : null}
          </div>
        </div>
        <div className="entry-actions">
          <button
            className="action-button primary"
            disabled={busy}
            onClick={() => void runCompile("resourcePack", entry.id)}
          >
            Compile
          </button>
        </div>
      </article>
    );
  }

  function renderBehaviorPack(entry: BehaviorPackEntry) {
    const iconPath = getEntryIconPath(entry, previewUrls);
    return (
      <article className="entry-card" key={entry.id}>
        <div className="entry-media">
          {iconPath ? (
            <img alt="" src={iconPath} />
          ) : (
            <div className="entry-fallback">{buildInitials(entry.cleanName)}</div>
          )}
        </div>
        <div>
          <h3 className="entry-title">{entry.cleanName}</h3>
          <div className="entry-meta">{entry.logicalPath}</div>
          <div className="badge-row">
            <span className="badge">UUID {entry.uuid}</span>
            <span className="badge">Script {entry.scriptState}</span>
            <span className="badge">
              {entry.sourceType === "folder" ? "Folder upload" : "Archive import"}
            </span>
          </div>
        </div>
        <div className="entry-actions">
          {isUpdateableScriptVersion(entry.scriptState) ? (
            <button
              className="action-button secondary"
              disabled={busy}
              onClick={() => void runScriptUpdate(entry.id, entry.scriptState)}
            >
              Update API
            </button>
          ) : null}
          <button
            className="action-button primary"
            disabled={busy}
            onClick={() => void runCompile("behaviorPack", entry.id)}
          >
            Compile
          </button>
        </div>
      </article>
    );
  }

  function renderAddon(entry: AddonEntry) {
    const iconPath =
      getEntryIconPath(entry.behaviorPack, previewUrls) ||
      getEntryIconPath(entry.resourcePack, previewUrls);

    return (
      <article className="entry-card" key={entry.id}>
        <div className="entry-media">
          {iconPath ? (
            <img alt="" src={iconPath} />
          ) : (
            <div className="entry-fallback">{buildInitials(entry.cleanName)}</div>
          )}
        </div>
        <div>
          <h3 className="entry-title">{entry.cleanName}</h3>
          <div className="entry-meta">
            BP: {entry.behaviorPack.cleanName}
            <br />
            RP: {entry.resourcePack.cleanName}
          </div>
          <div className="badge-row">
            <span className="badge">Script {entry.behaviorPack.scriptState}</span>
            <span className="badge">
              {entry.behaviorPack.sourceType === "folder" ? "Folder upload" : "Archive import"}
            </span>
          </div>
        </div>
        <div className="entry-actions">
          {isUpdateableScriptVersion(entry.behaviorPack.scriptState) ? (
            <button
              className="action-button secondary"
              disabled={busy}
              onClick={() =>
                void runScriptUpdate(entry.id, entry.behaviorPack.scriptState)
              }
            >
              Update API
            </button>
          ) : null}
          <button
            className="action-button secondary"
            disabled={busy}
            onClick={() => void runNormalize(entry.id)}
          >
            Normalize
          </button>
          <button
            className="action-button primary"
            disabled={busy}
            onClick={() => void runCompile("addOnPack", entry.id)}
          >
            Compile
          </button>
        </div>
      </article>
    );
  }

  function renderWorld(entry: WorldEntry) {
    const iconPath = getEntryIconPath(entry, previewUrls);
    return (
      <article className="entry-card" key={entry.id}>
        <div className="entry-media">
          {iconPath ? (
            <img alt="" src={iconPath} />
          ) : (
            <div className="entry-fallback">{buildInitials(entry.cleanName)}</div>
          )}
        </div>
        <div>
          <h3 className="entry-title">{entry.cleanName}</h3>
          <div className="entry-meta">{entry.logicalPath}</div>
          <div className="badge-row">
            <span className="badge">{entry.requiredRP.length} required RP</span>
            <span className="badge">{entry.requiredBP.length} required BP</span>
            <span className="badge">
              {entry.sourceType === "folder" ? "Folder upload" : "Archive import"}
            </span>
          </div>
        </div>
        <div className="entry-actions">
          <button
            className="action-button primary"
            disabled={busy}
            onClick={() => void runCompile("world", entry.id)}
          >
            Compile
          </button>
        </div>
      </article>
    );
  }

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-grid">
          <div>
            <div className="small-label">BlockState Team rewrite</div>
            <h1 className="hero-title">Minecraft Add-On Compiler</h1>
            <p className="hero-copy">
              Upload extracted Bedrock folders or packaged add-on files, build a live
              catalog, then compile packs, worlds, and normalized add-ons directly from
              a Vercel-hosted Node.js backend.
            </p>
            <div className="status-banner">{status}</div>
          </div>

          <aside className="panel prefs-panel">
            <div className="small-label">Session</div>
            <div className="subtle-text">Current session ID</div>
            <div className="badge-row" style={{ marginTop: 12 }}>
              <span className="badge">{sessionId}</span>
            </div>
            <div className="controls-grid" style={{ marginTop: 18 }}>
              <label className="field">
                <span className="field-label">Default export</span>
                <select
                  className="select"
                  value={format}
                  onChange={(event) =>
                    setFormat(event.target.value as "mcaddon" | "zip")
                  }
                >
                  <option value="mcaddon">MCADDON</option>
                  <option value="zip">ZIP</option>
                </select>
              </label>
              <label className="field">
                <span className="field-label">Theme</span>
                <select
                  className="select"
                  value={theme}
                  onChange={(event) =>
                    setTheme(event.target.value as ThemeOption)
                  }
                >
                  <option value="overworld">Overworld</option>
                  <option value="redstone">Redstone</option>
                  <option value="sandstone">Sandstone</option>
                </select>
              </label>
            </div>
            <div className="action-row">
              <button
                className="action-button secondary"
                disabled={busy}
                onClick={() => {
                  void refreshCatalog().catch(() => undefined);
                }}
              >
                Refresh catalog
              </button>
              <button
                className="action-button danger"
                disabled={busy}
                onClick={resetSession}
              >
                New session
              </button>
            </div>
          </aside>
        </div>
      </section>

      <div className="stack">
        <section className="panel upload-panel">
          <div className="section-header">
            <div>
              <div className="small-label">Upload flow</div>
              <h2 className="section-title">Stage source files</h2>
            </div>
          </div>
          <p className="subtle-text">
            Use folder upload for extracted packs and worlds. Use file upload for
            packaged archives such as <code>.mcpack</code>, <code>.mcaddon</code>,
            <code>.mcworld</code>, and <code>.zip</code>.
          </p>
          <div className="action-row">
            <button
              className="file-button"
              disabled={busy}
              onClick={() => folderInputRef.current?.click()}
            >
              Select folders
            </button>
            <button
              className="file-button"
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
            >
              Select files
            </button>
            <button
              className="action-button primary"
              disabled={busy || pendingUploads.length === 0}
              onClick={() => void uploadPendingFiles()}
            >
              Upload to session
            </button>
          </div>

          <input
            {...directoryInputProps}
            ref={folderInputRef}
            className="hidden-input"
            type="file"
            multiple
            onClick={(event) => {
              event.currentTarget.value = "";
            }}
            onChange={(event) => {
              mergePendingFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <input
            ref={fileInputRef}
            className="hidden-input"
            type="file"
            multiple
            accept=".zip,.mcpack,.mcaddon,.mcworld"
            onClick={(event) => {
              event.currentTarget.value = "";
            }}
            onChange={(event) => {
              mergePendingFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />

          {pendingUploads.length ? (
            <div className="file-list">
              {pendingUploads.map((pending) => (
                <div className="file-chip" key={pending.uploadPath}>
                  <strong>{pending.uploadPath}</strong>
                  <div className="subtle-text">{formatBytes(pending.file.size)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-empty">No local files staged yet.</div>
          )}
        </section>

        <section className="stats-grid">
          <div className="stat-card">
            <div className="stat-label">Resource Packs</div>
            <div className="stat-value">{catalogStats.resourcePacks}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Add-Ons</div>
            <div className="stat-value">{catalogStats.addOns}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Behavior Packs</div>
            <div className="stat-value">{catalogStats.behaviorPacks}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Worlds</div>
            <div className="stat-value">{catalogStats.worlds}</div>
          </div>
        </section>

        <Section label="Results" title="Download center">
          {downloads.length ? (
            <div className="download-list">
              {downloads.map((download) => (
                <article className="download-card" key={download.id}>
                  <div>
                    <strong>{download.filename}</strong>
                    <div className="subtle-text">{download.summary}</div>
                  </div>
                  <a
                    className="download-link"
                    href={download.downloadUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Download
                  </a>
                </article>
              ))}
            </div>
          ) : (
            <div className="muted-empty">
              Compiled files and transforms will appear here.
            </div>
          )}
        </Section>

        <Section label="Normalize log" title="Rename output">
          {normalizeLog.length ? (
            <div className="log-list">
              {normalizeLog.map((line, index) => (
                <div className="log-line" key={`${line}-${index}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-empty">
              Normalize an add-on to see file rename activity here.
            </div>
          )}
        </Section>

        <Section label="Console" title="Activity">
          {activityLog.length ? (
            <div className="log-list console-list">
              {activityLog.map((line, index) => (
                <div className="log-line console-line" key={`${line}-${index}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <div className="muted-empty">
              Upload, refresh, compile, and transform activity will appear here.
            </div>
          )}
        </Section>

        <Section label="Warnings" title="Catalog warnings">
          {catalog?.warnings.length ? (
            <div className="warning-list">
              {catalog.warnings.map((warning, index) => (
                <article
                  className="warning-card"
                  key={`${warning.type}-${index}`}
                >
                  <div className="warning-type">{warning.type}</div>
                  <div style={{ marginTop: 10 }}>{warning.message}</div>
                </article>
              ))}
            </div>
          ) : (
            <div className="muted-empty">No warnings in the current catalog.</div>
          )}
        </Section>

        <Section label="Catalog" title="Resource Packs">
          <div className="card-grid">
            {catalog?.resourcePacks.length ? (
              catalog.resourcePacks.map(renderResourcePack)
            ) : (
              <div className="muted-empty">Nothing cataloged yet.</div>
            )}
          </div>
        </Section>

        <Section label="Catalog" title="Add-Ons">
          <div className="card-grid">
            {catalog?.addOns.length ? (
              catalog.addOns.map(renderAddon)
            ) : (
              <div className="muted-empty">
                No add-ons discovered in this session.
              </div>
            )}
          </div>
        </Section>

        <Section label="Catalog" title="Behavior Packs">
          <div className="card-grid">
            {catalog?.behaviorPacks.length ? (
              catalog.behaviorPacks.map(renderBehaviorPack)
            ) : (
              <div className="muted-empty">
                No standalone behavior packs discovered.
              </div>
            )}
          </div>
        </Section>

        <Section label="Catalog" title="Worlds">
          <div className="card-grid">
            {catalog?.worlds.length ? (
              catalog.worlds.map(renderWorld)
            ) : (
              <div className="muted-empty">No worlds discovered in this session.</div>
            )}
          </div>
        </Section>
      </div>
    </main>
  );
}
