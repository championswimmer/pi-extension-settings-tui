import * as os from "node:os";
import * as path from "node:path";
import type { FieldMap, SettingsSchema, SettingsScope } from "../schema/index.js";
import {
  MAX_SETTINGS_BYTES,
  deleteFileHardened,
  readJsonFileHardened,
  writeJsonFileHardened,
} from "./fs-hardening.js";
import {
  ConcurrencyConflictError,
  SettingsSecurityError,
  type JsonFileStorageOptions,
  type LayerReadResult,
  type LayerWriteResult,
  type StorageAdapter,
} from "./types.js";

export function resolveDefaultAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) {
    if (envDir === "~") {
      return os.homedir();
    }
    if (envDir.startsWith("~/") || envDir.startsWith(`~${path.sep}`)) {
      return path.join(os.homedir(), envDir.slice(2));
    }
    return path.resolve(envDir);
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function assertSafeSchemaId(id: string): void {
  if (
    !id ||
    id.includes("\0") ||
    id.includes("/") ||
    id.includes("\\") ||
    id === "." ||
    id === ".."
  ) {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      `Invalid schema id for default path resolution: "${id}"`,
      { id },
    );
  }
}

function assertSafeFileName(fileName: string): void {
  if (
    typeof fileName !== "string" ||
    fileName.trim().length === 0 ||
    fileName.includes("\0") ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName === "." ||
    fileName === ".."
  ) {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      `Invalid fileName for default path resolution: "${String(fileName)}"`,
      { fileName },
    );
  }
}

/**
 * Validate a relative `settingsFile` path (e.g. `"my-ext.json"` or `"my-ext/settings.json"`)
 * and return its validated path segments. Rejects absolute paths, drive prefixes,
 * empty/trailing-slash paths, NUL bytes, and `.` / `..` segments.
 */
export function assertSafeRelativeSettingsFile(settingsFile: string): string[] {
  if (typeof settingsFile !== "string" || settingsFile.includes("\0")) {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      `Invalid settingsFile path: "${String(settingsFile)}"`,
      { settingsFile },
    );
  }
  const trimmed = settingsFile.trim();
  if (
    trimmed.length === 0 ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith("\\")
  ) {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      `Invalid relative settingsFile path: "${settingsFile}"`,
      { settingsFile },
    );
  }
  const segments = trimmed.split(/[/\\]/);
  for (const seg of segments) {
    if (seg.length === 0 || seg === "." || seg === "..") {
      throw new SettingsSecurityError(
        "INVALID_PATH",
        `Invalid segment "${seg}" in settingsFile path: "${settingsFile}"`,
        { settingsFile, segment: seg },
      );
    }
  }
  return segments;
}

export function resolveScopeFilePath<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  scope: SettingsScope,
  options?: JsonFileStorageOptions,
): string {
  if (scope === "session") {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      'JSON file storage adapter does not resolve file paths for "session" scope.',
      { scope },
    );
  }
  const agentDir = path.resolve(options?.agentDir ?? resolveDefaultAgentDir());
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const effectiveSettingsFile =
    options?.settingsFile ?? schema.settingsFile ?? schema.storage.settingsFile;
  const fileName =
    options?.fileName ??
    schema.storage.fileName ??
    (effectiveSettingsFile
      ? path.posix.basename(effectiveSettingsFile.replaceAll("\\", "/")) || "settings.json"
      : "settings.json");
  const id = schema.id;

  if (scope === "global") {
    const configured = options?.globalPath ?? schema.storage.globalPath;
    if (typeof configured === "function") {
      return path.resolve(
        configured({ agentDir, id, fileName, settingsFile: effectiveSettingsFile }),
      );
    }
    if (typeof configured === "string") {
      return path.isAbsolute(configured)
        ? path.resolve(configured)
        : path.resolve(agentDir, configured);
    }
    if (effectiveSettingsFile !== undefined) {
      const segs = assertSafeRelativeSettingsFile(effectiveSettingsFile);
      return path.join(agentDir, ...segs);
    }
    assertSafeSchemaId(id);
    assertSafeFileName(fileName);
    return path.join(agentDir, id, fileName);
  }

  const configured = options?.projectPath ?? schema.storage.projectPath;
  if (typeof configured === "function") {
    return path.resolve(
      configured({ cwd, id, fileName, settingsFile: effectiveSettingsFile }),
    );
  }
  if (typeof configured === "string") {
    return path.isAbsolute(configured)
      ? path.resolve(configured)
      : path.resolve(cwd, configured);
  }
  if (effectiveSettingsFile !== undefined) {
    const segs = assertSafeRelativeSettingsFile(effectiveSettingsFile);
    return path.join(cwd, ".pi", ...segs);
  }
  assertSafeSchemaId(id);
  assertSafeFileName(fileName);
  return path.join(cwd, ".pi", id, fileName);
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const rel = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function createJsonFileStorageAdapter<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  options?: JsonFileStorageOptions,
): StorageAdapter {
  const agentDir = path.resolve(options?.agentDir ?? resolveDefaultAgentDir());
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const deleteWhenEmpty = options?.deleteWhenEmpty ?? true;
  const maxBytes = options?.maxBytes ?? MAX_SETTINGS_BYTES;

  const paths: Partial<Record<SettingsScope, string>> = {};
  const baseRoots: Partial<Record<SettingsScope, string>> = {};

  if (schema.scopes.includes("global")) {
    const globalFile = resolveScopeFilePath(schema, "global", options);
    paths.global = globalFile;
    if (isWithinRoot(globalFile, agentDir)) {
      baseRoots.global = agentDir;
    }
  }
  if (schema.scopes.includes("project")) {
    const projectFile = resolveScopeFilePath(schema, "project", options);
    paths.project = projectFile;
    if (isWithinRoot(projectFile, cwd)) {
      baseRoots.project = cwd;
    }
  }

  function getFileInfo(scope: SettingsScope): { filePath: string; baseRoot?: string } {
    const filePath = paths[scope] ?? resolveScopeFilePath(schema, scope, options);
    const baseRoot =
      baseRoots[scope] ??
      (scope === "global"
        ? isWithinRoot(filePath, agentDir)
          ? agentDir
          : undefined
        : isWithinRoot(filePath, cwd)
          ? cwd
          : undefined);
    return { filePath, baseRoot };
  }

  function assertExpectedHash(
    scope: SettingsScope,
    filePath: string,
    baseRoot: string | undefined,
    expectedHash: string | null | undefined,
  ): void {
    if (expectedHash === undefined) {
      return;
    }
    const current = readJsonFileHardened(filePath, { baseRoot, maxBytes });
    if (current.hash !== expectedHash) {
      throw new ConcurrencyConflictError(scope);
    }
  }

  return {
    getPaths(): Partial<Record<SettingsScope, string>> {
      return { ...paths };
    },

    async readLayer(scope: SettingsScope): Promise<LayerReadResult> {
      if (scope === "session") {
        return { data: null, hash: null, exists: false };
      }
      const { filePath, baseRoot } = getFileInfo(scope);
      const res = readJsonFileHardened(filePath, { baseRoot, maxBytes });
      return {
        data: res.data,
        hash: res.hash,
        exists: res.exists,
      };
    },

    async writeLayer(
      scope: SettingsScope,
      data: Record<string, unknown>,
      writeOptions?: { expectedHash?: string | null },
    ): Promise<LayerWriteResult> {
      if (scope === "session") {
        throw new Error(
          'JSON file storage adapter cannot write "session" scope. Provide options.session, options.sessionAdapter, or a custom StorageAdapter.',
        );
      }
      const { filePath, baseRoot } = getFileInfo(scope);
      assertExpectedHash(scope, filePath, baseRoot, writeOptions?.expectedHash);

      if (deleteWhenEmpty && Object.keys(data).length === 0) {
        const deleted = deleteFileHardened(filePath, baseRoot);
        return { hash: null, deleted };
      }

      const hash = writeJsonFileHardened(filePath, data, { baseRoot, maxBytes });
      return { hash, deleted: false };
    },

    async deleteLayer(
      scope: SettingsScope,
      deleteOptions?: { expectedHash?: string | null },
    ): Promise<void> {
      if (scope === "session") {
        throw new Error(
          'JSON file storage adapter cannot delete "session" scope. Provide options.session, options.sessionAdapter, or a custom StorageAdapter.',
        );
      }
      const { filePath, baseRoot } = getFileInfo(scope);
      assertExpectedHash(scope, filePath, baseRoot, deleteOptions?.expectedHash);
      deleteFileHardened(filePath, baseRoot);
    },
  };
}
