import type {
  FieldProvenance,
  SettingsLayersData,
  SettingsScope,
  StoragePathConfig,
} from "../schema/index.js";
import type { SessionStorageOptions } from "./session-adapter.js";

export class ConcurrencyConflictError extends Error {
  readonly code = "CONCURRENCY_CONFLICT" as const;
  readonly scope: SettingsScope;

  constructor(scope: SettingsScope, message?: string) {
    super(
      message ??
        `Settings concurrency conflict detected for "${scope}" scope. Reload before saving.`,
    );
    this.name = "ConcurrencyConflictError";
    this.scope = scope;
  }
}

export type SecurityErrorCode =
  | "SYMLINK_REJECTED"
  | "SIZE_LIMIT_EXCEEDED"
  | "SECRET_KEY_REJECTED"
  | "INVALID_PATH"
  | "NOT_REGULAR_FILE";

export class SettingsSecurityError extends Error {
  readonly code: SecurityErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: SecurityErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SettingsSecurityError";
    this.code = code;
    this.details = details;
  }
}

export interface LayerReadResult {
  readonly data: Record<string, unknown> | null;
  readonly hash: string | null;
  readonly exists: boolean;
}

export interface LayerWriteResult {
  readonly hash: string | null;
  readonly deleted?: boolean;
}

export interface StorageAdapter {
  getPaths?(): Partial<Record<SettingsScope, string>>;
  readLayer(scope: SettingsScope): Promise<LayerReadResult>;
  writeLayer(
    scope: SettingsScope,
    data: Record<string, unknown>,
    options?: { expectedHash?: string | null },
  ): Promise<LayerWriteResult>;
  deleteLayer?(
    scope: SettingsScope,
    options?: { expectedHash?: string | null },
  ): Promise<void>;
}

export interface LayersSnapshot {
  readonly globalHash: string | null;
  readonly projectHash: string | null;
  readonly sessionHash?: string | null;
}

export interface LoadedSettings<TValues extends Record<string, unknown>> {
  readonly effective: TValues;
  readonly layers: SettingsLayersData<TValues>;
  readonly provenance: Record<keyof TValues & string, FieldProvenance>;
  readonly warnings: string[];
  readonly rejectedKeys: Readonly<Record<SettingsScope, readonly string[]>>;
  readonly trustedProject: boolean;
  readonly paths: Partial<Record<SettingsScope, string>>;
  readonly snapshot: LayersSnapshot;
  readonly migratedScopes: readonly SettingsScope[];
}

export interface SaveSettingsOptions {
  readonly scope: SettingsScope;
  readonly trustedProject?: boolean;
  readonly expectedSnapshot?: LayersSnapshot;
  readonly force?: boolean;
}

export interface SaveSettingsResult<TValues extends Record<string, unknown>> {
  readonly savedScope: SettingsScope;
  readonly writtenKeys: string[];
  readonly deletedFile: boolean;
  readonly loaded: LoadedSettings<TValues>;
}

export interface LoadSettingsOptions {
  readonly trustedProject?: boolean;
  readonly persistMigration?: boolean;
}

export interface JsonFileStorageOptions {
  readonly agentDir?: string;
  readonly cwd?: string;
  readonly settingsFile?: string;
  readonly fileName?: string;
  readonly globalPath?: StoragePathConfig["globalPath"];
  readonly projectPath?: StoragePathConfig["projectPath"];
  readonly deleteWhenEmpty?: boolean;
  readonly maxBytes?: number;
}

export interface LayeredStorageAdapterOptions {
  readonly global?: StorageAdapter;
  readonly project?: StorageAdapter;
  readonly session?: StorageAdapter;
  readonly fallback?: StorageAdapter;
}

export interface SettingsStoreOptions extends JsonFileStorageOptions {
  readonly adapter?: StorageAdapter;
  readonly sessionAdapter?: StorageAdapter;
  readonly session?: Omit<SessionStorageOptions, "scope">;
}
