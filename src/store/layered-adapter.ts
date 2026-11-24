import type { SettingsScope } from "../schema/index.js";
import type {
  LayerReadResult,
  LayerWriteResult,
  LayeredStorageAdapterOptions,
  StorageAdapter,
} from "./types.js";

const ALL_SCOPES: readonly SettingsScope[] = ["global", "project", "session"];

export function createLayeredStorageAdapter(
  adapters: LayeredStorageAdapterOptions,
): StorageAdapter {
  function resolveAdapter(scope: SettingsScope): StorageAdapter | undefined {
    return adapters[scope] ?? adapters.fallback;
  }

  return {
    getPaths(): Partial<Record<SettingsScope, string>> {
      const out: Partial<Record<SettingsScope, string>> = {};
      for (const scope of ALL_SCOPES) {
        const adapter = resolveAdapter(scope);
        const pathValue = adapter?.getPaths?.()?.[scope];
        if (pathValue !== undefined) {
          out[scope] = pathValue;
        }
      }
      return out;
    },

    async readLayer(scope: SettingsScope): Promise<LayerReadResult> {
      const adapter = resolveAdapter(scope);
      if (!adapter) {
        return { data: null, hash: null, exists: false };
      }
      return adapter.readLayer(scope);
    },

    async writeLayer(
      scope: SettingsScope,
      data: Record<string, unknown>,
      options?: { expectedHash?: string | null },
    ): Promise<LayerWriteResult> {
      const adapter = resolveAdapter(scope);
      if (!adapter) {
        throw new Error(`No storage adapter configured for "${scope}" scope.`);
      }
      return adapter.writeLayer(scope, data, options);
    },

    async deleteLayer(
      scope: SettingsScope,
      options?: { expectedHash?: string | null },
    ): Promise<void> {
      const adapter = resolveAdapter(scope);
      if (!adapter) {
        throw new Error(`No storage adapter configured for "${scope}" scope.`);
      }
      if (adapter.deleteLayer) {
        await adapter.deleteLayer(scope, options);
      } else {
        await adapter.writeLayer(scope, {}, options);
      }
    },
  };
}
