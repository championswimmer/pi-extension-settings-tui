import { cloneValue, findSecretKeys, type SettingsScope } from "../schema/index.js";
import { computeJsonHash, isPlainRecord } from "./fs-hardening.js";
import {
  ConcurrencyConflictError,
  SettingsSecurityError,
  type LayerReadResult,
  type LayerWriteResult,
  type StorageAdapter,
} from "./types.js";

export interface SessionEntryLike {
  readonly type?: string;
  readonly customType?: string;
  readonly entryType?: string;
  readonly data?: unknown;
}

export interface SessionStorageOptions {
  readonly entryType: string;
  readonly appendEntry: (
    entryType: string,
    data: Record<string, unknown>,
  ) => void | Promise<void>;
  readonly getEntries: () => readonly SessionEntryLike[];
  readonly scope?: SettingsScope;
  readonly matchEntry?: (entry: SessionEntryLike) => boolean;
  readonly deserialize?: (data: Record<string, unknown>) => Record<string, unknown> | null;
  readonly serialize?: (data: Record<string, unknown>) => Record<string, unknown>;
  readonly deletedData?: Record<string, unknown>;
}

const DELETED_TOMBSTONE_KEY = "__deleted";

export function createSessionStorageAdapter(
  options: SessionStorageOptions,
): StorageAdapter {
  const targetScope: SettingsScope = options.scope ?? "global";
  const pathLabel = `session://${options.entryType}`;

  function readLatestSync(): LayerReadResult {
    const entries = options.getEntries();
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (!entry) {
        continue;
      }
      if (entry.type !== undefined && entry.type !== "custom") {
        continue;
      }
      const entryName = entry.customType ?? entry.entryType;
      if (entryName !== options.entryType) {
        continue;
      }
      if (options.matchEntry && !options.matchEntry(entry)) {
        continue;
      }
      if (!isPlainRecord(entry.data)) {
        return { data: null, hash: null, exists: false };
      }
      if (entry.data[DELETED_TOMBSTONE_KEY] === true) {
        return { data: null, hash: null, exists: false };
      }
      const rawClone = cloneValue(entry.data);
      const unwrapped = options.deserialize ? options.deserialize(rawClone) : rawClone;
      if (unwrapped === null || !isPlainRecord(unwrapped)) {
        return { data: null, hash: null, exists: false };
      }
      const cloned = cloneValue(unwrapped);
      const serialized = JSON.stringify(cloned, null, 2) + "\n";
      return {
        data: cloned,
        hash: computeJsonHash(serialized),
        exists: true,
      };
    }
    return { data: null, hash: null, exists: false };
  }

  function buildTombstone(): Record<string, unknown> {
    return {
      ...(options.deletedData ? cloneValue(options.deletedData) : {}),
      [DELETED_TOMBSTONE_KEY]: true,
    };
  }

  function assertTargetScope(scope: SettingsScope): void {
    if (scope !== targetScope) {
      throw new Error(
        `Session storage adapter is configured for "${targetScope}" scope only; cannot write "${scope}".`,
      );
    }
  }

  return {
    getPaths(): Partial<Record<SettingsScope, string>> {
      return { [targetScope]: pathLabel };
    },

    async readLayer(scope: SettingsScope): Promise<LayerReadResult> {
      if (scope !== targetScope) {
        return { data: null, hash: null, exists: false };
      }
      return readLatestSync();
    },

    async writeLayer(
      scope: SettingsScope,
      data: Record<string, unknown>,
      writeOptions?: { expectedHash?: string | null },
    ): Promise<LayerWriteResult> {
      assertTargetScope(scope);
      if (!isPlainRecord(data)) {
        throw new Error("Session settings payload must be a plain JSON object.");
      }

      const secretKeys = findSecretKeys(data);
      if (secretKeys.length > 0) {
        throw new SettingsSecurityError(
          "SECRET_KEY_REJECTED",
          `Refusing to persist forbidden secret key(s): ${secretKeys.join(", ")}`,
          { keys: secretKeys },
        );
      }

      const current = readLatestSync();
      if (
        writeOptions?.expectedHash !== undefined &&
        current.hash !== writeOptions.expectedHash
      ) {
        throw new ConcurrencyConflictError(scope);
      }

      if (Object.keys(data).length === 0) {
        if (current.exists) {
          await options.appendEntry(options.entryType, buildTombstone());
          return { hash: null, deleted: true };
        }
        return { hash: null, deleted: false };
      }

      const payload = cloneValue(data);
      const serialized = JSON.stringify(payload, null, 2) + "\n";
      const hash = computeJsonHash(serialized);
      const entryPayload = options.serialize ? options.serialize(cloneValue(payload)) : payload;
      if (!isPlainRecord(entryPayload)) {
        throw new Error("Serialized session settings payload must be a plain JSON object.");
      }
      const serializedSecrets = findSecretKeys(entryPayload);
      if (serializedSecrets.length > 0) {
        throw new SettingsSecurityError(
          "SECRET_KEY_REJECTED",
          `Refusing to persist forbidden secret key(s): ${serializedSecrets.join(", ")}`,
          { keys: serializedSecrets },
        );
      }
      await options.appendEntry(options.entryType, entryPayload);
      return { hash, deleted: false };
    },

    async deleteLayer(
      scope: SettingsScope,
      deleteOptions?: { expectedHash?: string | null },
    ): Promise<void> {
      assertTargetScope(scope);
      const current = readLatestSync();
      if (
        deleteOptions?.expectedHash !== undefined &&
        current.hash !== deleteOptions.expectedHash
      ) {
        throw new ConcurrencyConflictError(scope);
      }
      if (current.exists) {
        await options.appendEntry(options.entryType, buildTombstone());
      }
    },
  };
}
