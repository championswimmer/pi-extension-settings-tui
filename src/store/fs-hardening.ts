import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SECRET_KEY_PATTERN, findSecretKeys } from "../schema/index.js";
import { SettingsSecurityError } from "./types.js";

export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface ReadJsonFileOptions {
  readonly baseRoot?: string;
  readonly maxBytes?: number;
  readonly rejectSecretKeysOnRead?: boolean;
}

export interface ReadJsonFileResult {
  readonly exists: boolean;
  readonly data: Record<string, unknown> | null;
  readonly hash: string | null;
  readonly secretKeys: string[];
}

export interface WriteJsonFileOptions {
  readonly baseRoot?: string;
  readonly maxBytes?: number;
}

export function computeJsonHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === "object" && err !== null && "code" in err;
}

function assertValidPathString(filePath: string, label = "path"): void {
  if (typeof filePath !== "string" || filePath.trim().length === 0 || filePath.includes("\0")) {
    throw new SettingsSecurityError(
      "INVALID_PATH",
      `Invalid ${label}: path must be a non-empty string without NUL bytes.`,
      { path: filePath },
    );
  }
}

/**
 * Resolves the deepest existing ancestor of `targetPath` using `realpathSync`
 * so macOS root symlinks like `/var -> /private/var` or `/tmp -> /private/tmp`
 * do not trigger false positives when checking segments beneath `baseRoot`.
 */
function resolveExistingPrefixRealpath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const missingTail: string[] = [];
  let current = resolved;

  while (true) {
    try {
      const realAncestor = fs.realpathSync(current);
      return missingTail.length === 0
        ? realAncestor
        : path.join(realAncestor, ...missingTail.reverse());
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "ENOENT") {
        throw err;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return resolved;
      }
      missingTail.push(path.basename(current));
      current = parent;
    }
  }
}

function checkRelativeSegments(baseDir: string, rel: string): void {
  if (rel === "" || rel === ".") {
    return;
  }
  const segments = rel.split(path.sep).filter((s) => s.length > 0 && s !== ".");
  let current = baseDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new SettingsSecurityError(
        "SYMLINK_REJECTED",
        `Refusing symbolic link segment: ${current}`,
        { path: current },
      );
    }
  }
}

function isMacOsRootSymlink(segmentPath: string): boolean {
  if (process.platform !== "darwin") {
    return false;
  }
  return segmentPath === "/var" || segmentPath === "/tmp" || segmentPath === "/etc";
}

function checkAllSegmentsFromRoot(resolvedTarget: string): void {
  const parsed = path.parse(resolvedTarget);
  let current = parsed.root;
  const rest = resolvedTarget.slice(parsed.root.length);
  const segments = rest.split(path.sep).filter((s) => s.length > 0 && s !== ".");

  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") {
        return;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      if (i === 0 && i < segments.length - 1 && isMacOsRootSymlink(current)) {
        current = fs.realpathSync(current);
        continue;
      }
      throw new SettingsSecurityError(
        "SYMLINK_REJECTED",
        `Refusing symbolic link segment: ${current}`,
        { path: current },
      );
    }
  }
}

export function assertNoSymlinkSegments(targetPath: string, baseRoot?: string): void {
  assertValidPathString(targetPath, "targetPath");
  if (baseRoot !== undefined) {
    assertValidPathString(baseRoot, "baseRoot");
  }

  const resolvedTarget = path.resolve(targetPath);

  if (baseRoot !== undefined) {
    const resolvedBase = path.resolve(baseRoot);
    const realBase = resolveExistingPrefixRealpath(resolvedBase);

    const relFromResolved = path.relative(resolvedBase, resolvedTarget);
    if (
      relFromResolved === "" ||
      (!relFromResolved.startsWith("..") && !path.isAbsolute(relFromResolved))
    ) {
      checkRelativeSegments(realBase, relFromResolved);
      return;
    }

    const relFromReal = path.relative(realBase, resolvedTarget);
    if (
      relFromReal === "" ||
      (!relFromReal.startsWith("..") && !path.isAbsolute(relFromReal))
    ) {
      checkRelativeSegments(realBase, relFromReal);
      return;
    }
  }

  checkAllSegmentsFromRoot(resolvedTarget);
}

export function ensureSecureDir(dirPath: string, baseRoot?: string): void {
  assertValidPathString(dirPath, "dirPath");
  assertNoSymlinkSegments(dirPath, baseRoot);

  const resolvedDir = path.resolve(dirPath);
  const toCreate: string[] = [];
  let current = resolvedDir;

  while (true) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new SettingsSecurityError(
          "SYMLINK_REJECTED",
          `Refusing symbolic link directory: ${current}`,
          { path: current },
        );
      }
      if (!stat.isDirectory()) {
        throw new SettingsSecurityError(
          "INVALID_PATH",
          `Expected directory at ${current}, found non-directory.`,
          { path: current },
        );
      }
      break;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "ENOENT") {
        throw err;
      }
      toCreate.push(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  for (let i = toCreate.length - 1; i >= 0; i -= 1) {
    const dirToCreate = toCreate[i];
    try {
      fs.mkdirSync(dirToCreate, { mode: 0o700 });
    } catch (err) {
      if (!isErrnoException(err) || err.code !== "EEXIST") {
        throw err;
      }
    }
    const stat = fs.lstatSync(dirToCreate);
    if (stat.isSymbolicLink()) {
      throw new SettingsSecurityError(
        "SYMLINK_REJECTED",
        `Refusing symbolic link directory: ${dirToCreate}`,
        { path: dirToCreate },
      );
    }
    if (!stat.isDirectory()) {
      throw new SettingsSecurityError(
        "INVALID_PATH",
        `Expected directory at ${dirToCreate}, found non-directory.`,
        { path: dirToCreate },
      );
    }
  }
}

export function readJsonFileHardened(
  filePath: string,
  options?: ReadJsonFileOptions,
): ReadJsonFileResult {
  assertValidPathString(filePath, "filePath");
  const maxBytes = options?.maxBytes ?? MAX_SETTINGS_BYTES;
  const resolvedPath = path.resolve(filePath);

  assertNoSymlinkSegments(resolvedPath, options?.baseRoot);

  const flags =
    fs.constants.O_RDONLY |
    (fs.constants.O_NOFOLLOW ?? 0) |
    (fs.constants.O_NONBLOCK ?? 0);

  let fd: number | null = null;
  try {
    try {
      fd = fs.openSync(resolvedPath, flags);
    } catch (err) {
      if (isErrnoException(err)) {
        if (err.code === "ENOENT") {
          return { exists: false, data: null, hash: null, secretKeys: [] };
        }
        if (err.code === "ELOOP") {
          throw new SettingsSecurityError(
            "SYMLINK_REJECTED",
            `Refusing to open symbolic link: ${resolvedPath}`,
            { path: resolvedPath },
          );
        }
      }
      throw err;
    }

    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new SettingsSecurityError(
        "NOT_REGULAR_FILE",
        `Settings path is not a regular file: ${resolvedPath}`,
        { path: resolvedPath },
      );
    }
    if (stat.size > maxBytes) {
      throw new SettingsSecurityError(
        "SIZE_LIMIT_EXCEEDED",
        `Settings file (${stat.size} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
        { path: resolvedPath, size: stat.size, maxBytes },
      );
    }

    const content = fs.readFileSync(fd, "utf8");
    const actualBytes = Buffer.byteLength(content, "utf8");
    if (actualBytes > maxBytes) {
      throw new SettingsSecurityError(
        "SIZE_LIMIT_EXCEEDED",
        `Settings file (${actualBytes} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
        { path: resolvedPath, size: actualBytes, maxBytes },
      );
    }

    const parsed: unknown = JSON.parse(content);
    if (!isPlainRecord(parsed)) {
      throw new Error(`Settings file ${resolvedPath} must contain a JSON object.`);
    }

    const secretKeys = findSecretKeys(parsed);
    if (options?.rejectSecretKeysOnRead && secretKeys.length > 0) {
      throw new SettingsSecurityError(
        "SECRET_KEY_REJECTED",
        `Settings file contains forbidden secret key(s): ${secretKeys.join(", ")}`,
        { path: resolvedPath, keys: secretKeys },
      );
    }

    return {
      exists: true,
      data: parsed,
      hash: computeJsonHash(content),
      secretKeys,
    };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors in cleanup.
      }
    }
  }
}

export function stripSecretKeys(
  value: Record<string, unknown>,
  prefix = "",
): { cleaned: Record<string, unknown>; strippedKeys: string[] } {
  const strippedKeys: string[] = [];

  function cleanValue(input: unknown, currentPath: string): unknown {
    if (Array.isArray(input)) {
      return input.map((item, index) => cleanValue(item, `${currentPath}[${index}]`));
    }
    if (!isPlainRecord(input)) {
      return input;
    }
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
      const nextPath = currentPath ? `${currentPath}.${key}` : key;
      if (SECRET_KEY_PATTERN.test(key)) {
        strippedKeys.push(nextPath);
        continue;
      }
      out[key] = cleanValue(val, nextPath);
    }
    return out;
  }

  const cleaned = cleanValue(value, prefix) as Record<string, unknown>;
  return { cleaned, strippedKeys };
}

export function writeJsonFileHardened(
  filePath: string,
  data: Record<string, unknown>,
  options?: WriteJsonFileOptions,
): string {
  assertValidPathString(filePath, "filePath");
  if (!isPlainRecord(data)) {
    throw new Error("Settings payload must be a plain JSON object.");
  }

  const secretKeys = findSecretKeys(data);
  if (secretKeys.length > 0) {
    throw new SettingsSecurityError(
      "SECRET_KEY_REJECTED",
      `Refusing to persist forbidden secret key(s): ${secretKeys.join(", ")}`,
      { keys: secretKeys },
    );
  }

  const maxBytes = options?.maxBytes ?? MAX_SETTINGS_BYTES;
  const serialized = JSON.stringify(data, null, 2) + "\n";
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > maxBytes) {
    throw new SettingsSecurityError(
      "SIZE_LIMIT_EXCEEDED",
      `Settings payload (${byteLength} bytes) exceeds maximum allowed size (${maxBytes} bytes).`,
      { size: byteLength, maxBytes },
    );
  }

  const resolvedTarget = path.resolve(filePath);
  const dirPath = path.dirname(resolvedTarget);
  ensureSecureDir(dirPath, options?.baseRoot);

  assertTargetNotSymlink(resolvedTarget);

  const tmpPath = path.join(dirPath, `.settings.${crypto.randomUUID()}.tmp`);
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);

  let fd: number | null = null;
  let renamed = false;
  try {
    fd = fs.openSync(tmpPath, flags, 0o600);
    const buffer = Buffer.from(serialized, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) {
        throw new Error(`Short write while persisting settings temp file: ${tmpPath}`);
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    assertTargetNotSymlink(resolvedTarget);
    fs.renameSync(tmpPath, resolvedTarget);
    renamed = true;
    return computeJsonHash(serialized);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors in cleanup.
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup errors if temp file was never created or already removed.
      }
    }
  }
}

function assertTargetNotSymlink(resolvedTarget: string): void {
  try {
    const stat = fs.lstatSync(resolvedTarget);
    if (stat.isSymbolicLink()) {
      throw new SettingsSecurityError(
        "SYMLINK_REJECTED",
        `Refusing symbolic link target: ${resolvedTarget}`,
        { path: resolvedTarget },
      );
    }
    if (!stat.isFile()) {
      throw new SettingsSecurityError(
        "NOT_REGULAR_FILE",
        `Target path exists and is not a regular file: ${resolvedTarget}`,
        { path: resolvedTarget },
      );
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
}

export function deleteFileHardened(filePath: string, baseRoot?: string): boolean {
  assertValidPathString(filePath, "filePath");
  const resolvedPath = path.resolve(filePath);
  assertNoSymlinkSegments(resolvedPath, baseRoot);
  assertTargetNotSymlink(resolvedPath);

  try {
    fs.unlinkSync(resolvedPath);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return false;
    }
    throw err;
  }
}
