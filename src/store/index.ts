export {
  ConcurrencyConflictError,
  SettingsSecurityError,
  type JsonFileStorageOptions,
  type LayerReadResult,
  type LayerWriteResult,
  type LayeredStorageAdapterOptions,
  type LayersSnapshot,
  type LoadSettingsOptions,
  type LoadedSettings,
  type SaveSettingsOptions,
  type SaveSettingsResult,
  type SecurityErrorCode,
  type SettingsStoreOptions,
  type StorageAdapter,
} from "./types.js";
export {
  MAX_SETTINGS_BYTES,
  assertNoSymlinkSegments,
  computeJsonHash,
  deleteFileHardened,
  ensureSecureDir,
  isPlainRecord,
  readJsonFileHardened,
  stripSecretKeys,
  writeJsonFileHardened,
  type ReadJsonFileOptions,
  type ReadJsonFileResult,
  type WriteJsonFileOptions,
} from "./fs-hardening.js";
export {
  assertSafeRelativeSettingsFile,
  createJsonFileStorageAdapter,
  resolveDefaultAgentDir,
  resolveScopeFilePath,
} from "./json-adapter.js";
export {
  createSessionStorageAdapter,
  type SessionEntryLike,
  type SessionStorageOptions,
} from "./session-adapter.js";
export { createMemoryStorageAdapter } from "./memory-adapter.js";
export { createLayeredStorageAdapter } from "./layered-adapter.js";
export { SettingsStore, createSettingsStore } from "./settings-store.js";
