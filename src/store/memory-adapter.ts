import { cloneValue, findSecretKeys, type SettingsScope } from "../schema/index.js";
import { computeJsonHash, isPlainRecord } from "./fs-hardening.js";
import {
  ConcurrencyConflictError,
  SettingsSecurityError,
  type LayerReadResult,
  type LayerWriteResult,
  type StorageAdapter,
} from "./types.js";

interface StoredMemoryLayer {
  readonly data: Record<string, unknown>;
  readonly hash: string;
}

export function createMemoryStorageAdapter(
  initial?: Partial<Record<SettingsScope, Record<string, unknown>>>,
): StorageAdapter {
  const layers = new Map<SettingsScope, StoredMemoryLayer>();

  if (initial) {
    for (const scope of ["global", "project"] as const) {
      const value = initial[scope];
      if (value !== undefined) {
        if (!isPlainRecord(value)) {
          throw new Error(`Initial "${scope}" layer must be a plain object.`);
        }
        const cloned = cloneValue(value);
        const serialized = JSON.stringify(cloned, null, 2) + "\n";
        layers.set(scope, {
          data: cloned,
          hash: computeJsonHash(serialized),
        });
      }
    }
  }

  return {
    getPaths(): Partial<Record<SettingsScope, string>> {
      return {
        global: "memory://global",
        project: "memory://project",
      };
    },

    async readLayer(scope: SettingsScope): Promise<LayerReadResult> {
      const entry = layers.get(scope);
      if (!entry) {
        return { data: null, hash: null, exists: false };
      }
      return {
        data: cloneValue(entry.data),
        hash: entry.hash,
        exists: true,
      };
    },

    async writeLayer(
      scope: SettingsScope,
      data: Record<string, unknown>,
      writeOptions?: { expectedHash?: string | null },
    ): Promise<LayerWriteResult> {
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

      const currentHash = layers.get(scope)?.hash ?? null;
      if (
        writeOptions?.expectedHash !== undefined &&
        currentHash !== writeOptions.expectedHash
      ) {
        throw new ConcurrencyConflictError(scope);
      }

      if (Object.keys(data).length === 0) {
        const existed = layers.has(scope);
        layers.delete(scope);
        return { hash: null, deleted: existed };
      }

      const cloned = cloneValue(data);
      const serialized = JSON.stringify(cloned, null, 2) + "\n";
      const hash = computeJsonHash(serialized);
      layers.set(scope, { data: cloned, hash });
      return { hash, deleted: false };
    },

    async deleteLayer(
      scope: SettingsScope,
      deleteOptions?: { expectedHash?: string | null },
    ): Promise<void> {
      const currentHash = layers.get(scope)?.hash ?? null;
      if (
        deleteOptions?.expectedHash !== undefined &&
        currentHash !== deleteOptions.expectedHash
      ) {
        throw new ConcurrencyConflictError(scope);
      }
      layers.delete(scope);
    },
  };
}
