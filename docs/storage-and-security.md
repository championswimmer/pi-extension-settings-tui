# Storage, Layered Resolution & Security

`pi-extension-settings-tui` separates pure schema logic from persistence via `SettingsStore` and a pluggable `StorageAdapter` interface. By default it uses a hardened JSON file adapter that persists minimal overrides per scope and protects against untrusted repositories, symlinks, oversized files, and accidental secret persistence.

> **Related guides:** [Getting Started](getting-started.md) · [Field Types](field-types.md) · [TUI, Mouse & RPC](tui-mouse-and-rpc.md) · [Overview](../README.md)

---

## 1. Layered Resolution & Override-Only Persistence

Settings resolve in three layers:

```text
schema defaults  ──▶  global overrides  ──▶  project overrides (if trustedProject === true)
```

- **Override-only writes (`diffForScope`):**
  - Saving to **Global** writes only keys whose values differ from `schema.defaults`.
  - Saving to **Project** writes only keys whose values differ from the effective **Global** value (or from `schema.defaults` when Global does not override that key).
  - If a user changes a Global setting, every project that hasn't explicitly overridden that key automatically inherits the new Global value.
- **`deleteWhenEmpty` (default `true`):**
  - When all overrides for a scope are cleared (every key matches its base layer), `createJsonFileStorageAdapter` deletes that scope's JSON file instead of leaving behind an empty `{}` file. Set `deleteWhenEmpty: false` in `SettingsStoreOptions` / `JsonFileStorageOptions` to keep `{}` on disk instead.
- **Restore defaults:**
  - `store.restoreDefaults({ scope, trustedProject, expectedSnapshot })` (or the built-in `Restore defaults` row in the TUI/RPC menu) deletes the active scope's layer via `adapter.deleteLayer` (or writes `{}`) after confirmation, reverting the scope to its parent layer.

### Provenance Indicators

`store.load(...)` computes per-field provenance (`FieldProvenance`):

| Provenance | TUI column | RPC badge | Meaning |
| :--- | :--- | :--- | :--- |
| `"default"` | `   ` | `[default]` | Neither Global nor Project overrides this key. |
| `"global"` | `●  ` | `[G]` | Overridden in Global scope only. |
| `"project"` | `  ●` | `[P]` | Overridden in Project scope only. |
| `"both"` | `● ●` | `[P>G]` | Overridden in both Global and Project (Project wins). |

---

## 2. Customizing Storage Paths & File Names

### Default Layout

Without custom `storage` configuration, `resolveScopeFilePath` writes to:

- **Global:** `<agentDir>/<schema.id>/settings.json`
  - `resolveDefaultAgentDir()` honors `$PI_CODING_AGENT_DIR` (expanding `~` / `~/...`), falling back to `~/.pi/agent`.
- **Project:** `<cwd>/.pi/agent/<schema.id>/settings.json`

> **Schema ID constraint:** When using the default nested layout, `schema.id` must not be empty, `.`, `..`, or contain `/`, `\`, or NUL bytes (otherwise `SettingsSecurityError("INVALID_PATH")` is thrown).

### Configuring `fileName`, `globalPath`, and `projectPath`

You can customize paths directly in `defineSettings({ storage })`, or override them per call in `createSettingsStore(schema, options)` / `openSettingsDialog(ctx, options)`:

- `fileName?: string` — overrides `"settings.json"`.
- `globalPath?: string | ((ctx: { agentDir: string; id: string; fileName: string }) => string)`
  - If a relative string is given, it is resolved relative to `agentDir`.
- `projectPath?: string | ((ctx: { cwd: string; id: string; fileName: string }) => string)`
  - If a relative string is given, it is resolved relative to `cwd`.

#### Real-World Migration Example: Flat Extension Files

Many existing Pi extensions already store settings as flat JSON files such as `~/.pi/agent/my-ext.json` and `<cwd>/.pi/my-ext.json`. Match that layout seamlessly without breaking existing user configs:

```ts
import * as path from "node:path";
import { defineSettings, field } from "pi-extension-settings-tui";

export const schema = defineSettings({
  id: "my-ext",
  title: "My Extension",
  storage: {
    fileName: "my-ext.json",
    globalPath: ({ agentDir, fileName }) => path.join(agentDir, fileName),
    projectPath: ({ cwd, fileName }) => path.join(cwd, ".pi", fileName),
  },
  fields: {
    enabled: field.boolean({ label: "Enabled", default: true }),
  },
});
```

Or use relative string paths (resolved against `agentDir` and `cwd` respectively):

```ts
storage: {
  globalPath: "my-ext.json",      // -> <agentDir>/my-ext.json
  projectPath: ".pi/my-ext.json", // -> <cwd>/.pi/my-ext.json
}
```

---

## 3. Pluggable `StorageAdapter`

`SettingsStore` delegates all layer I/O to a `StorageAdapter`. In addition to the default `createJsonFileStorageAdapter`, the `/store` subpath exports two built-in adapters and supports custom implementations.

### `createSessionStorageAdapter` (Pi Session Entries)

For extensions that keep settings inside the active Pi session log (`pi.appendEntry`) instead of writing JSON files to disk:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSessionStorageAdapter,
  createSettingsStore,
  openSettingsDialog,
} from "pi-extension-settings-tui";
import { mySchema } from "./settings.js";

export default function sessionScopedExtension(pi: ExtensionAPI) {
  pi.registerCommand("my-settings", {
    description: "Edit session-scoped settings",
    handler: async (_args, ctx) => {
      const adapter = createSessionStorageAdapter({
        entryType: "my-extension:settings:v1",
        appendEntry: (type, data) => pi.appendEntry(type, data),
        getEntries: () => ctx.sessionManager.getEntries(),
        scope: "global", // optional, defaults to "global"
      });

      const store = createSettingsStore(mySchema, { adapter });
      await openSettingsDialog(ctx, { schema: mySchema, store });
    },
  });
}
```

How `createSessionStorageAdapter` works:
- `readLayer` scans `getEntries()` from newest to oldest for the latest matching `"custom"` entry with `customType === entryType` (or `entryType` fallback).
- Restoring defaults or writing `{}` appends a `{ __deleted: true }` tombstone entry so earlier session entries are logically cleared.
- Still enforces `findSecretKeys` (`SECRET_KEY_REJECTED`) and `expectedHash` optimistic concurrency checks (`ConcurrencyConflictError`).
- `getPaths()` reports `{ [scope]: "session://<entryType>" }`.

> **Tip:** If your schema uses `createSessionStorageAdapter`, set `scopes: ["global"]` (or match the adapter's `scope` option), because the session adapter only stores a single target scope and throws if asked to write to another scope.

### `createMemoryStorageAdapter` (Unit Tests)

Use `createMemoryStorageAdapter(initial?)` from `pi-extension-settings-tui/store` in unit tests so tests never touch the filesystem:

```ts
import { createMemoryStorageAdapter, createSettingsStore } from "pi-extension-settings-tui/store";
import { mySchema } from "./settings.js";

const adapter = createMemoryStorageAdapter({
  global: { mode: "strict" },
  project: { maxRetries: 5 },
});

const store = createSettingsStore(mySchema, { adapter });
const loaded = await store.load({ trustedProject: true });
```

### Writing a Custom `StorageAdapter`

Implement the `StorageAdapter` interface from `pi-extension-settings-tui/store`:

```ts
import type { SettingsScope } from "pi-extension-settings-tui/schema";
import {
  ConcurrencyConflictError,
  computeJsonHash,
  type LayerReadResult,
  type LayerWriteResult,
  type StorageAdapter,
} from "pi-extension-settings-tui/store";

export function createCustomStorageAdapter(): StorageAdapter {
  let storedData: Record<string, unknown> | null = null;
  let storedHash: string | null = null;

  return {
    getPaths(): Partial<Record<SettingsScope, string>> {
      return { global: "custom://settings" };
    },

    async readLayer(scope: SettingsScope): Promise<LayerReadResult> {
      if (scope !== "global" || !storedData) {
        return { data: null, hash: null, exists: false };
      }
      return { data: { ...storedData }, hash: storedHash, exists: true };
    },

    async writeLayer(
      scope: SettingsScope,
      data: Record<string, unknown>,
      options?: { expectedHash?: string | null },
    ): Promise<LayerWriteResult> {
      if (options?.expectedHash !== undefined && storedHash !== options.expectedHash) {
        throw new ConcurrencyConflictError(scope);
      }
      if (Object.keys(data).length === 0) {
        const existed = storedData !== null;
        storedData = null;
        storedHash = null;
        return { hash: null, deleted: existed };
      }
      storedData = { ...data };
      storedHash = computeJsonHash(JSON.stringify(storedData, null, 2) + "\n");
      return { hash: storedHash, deleted: false };
    },

    async deleteLayer(
      scope: SettingsScope,
      options?: { expectedHash?: string | null },
    ): Promise<void> {
      if (options?.expectedHash !== undefined && storedHash !== options.expectedHash) {
        throw new ConcurrencyConflictError(scope);
      }
      storedData = null;
      storedHash = null;
    },
  };
}
```

---

## 4. Migrations (`migrate`)

Use `migrate(raw, scope)` on `defineSettings(...)` to upgrade legacy keys or shapes before field validation runs:

```ts
export const schema = defineSettings({
  id: "my-extension",
  title: "My Extension",
  version: 2,
  migrate: (raw, _scope) => {
    const next = { ...raw };
    // Rename legacy boolean flag `verbose` -> `logLevel`
    if (typeof next.verbose === "boolean" && next.logLevel === undefined) {
      next.logLevel = next.verbose ? "debug" : "info";
      delete next.verbose;
    }
    return next;
  },
  fields: {
    logLevel: field.enum({
      label: "Log level",
      default: "info",
      options: [
        { value: "info", label: "Info" },
        { value: "debug", label: "Debug" },
      ],
    }),
  },
});
```

Load pipeline order inside `SettingsStore.load()`:
1. Read raw JSON from the adapter.
2. Strip any secret keys (`stripSecretKeys`) and record warnings.
3. Run `schema.config.migrate(raw, scope)` (if defined).
4. Strip any secret keys introduced by `migrate` and record warnings.
5. Run `schema.validatePartial(raw)` to sanitize values and warn on unknown/invalid keys.
6. Filter out any fields whose `scopes` array excludes `scope`.

---

## 5. Optimistic Concurrency (`ConcurrencyConflictError`)

Every `store.load()` returns `snapshot: { globalHash, projectHash }` (SHA-256 hashes of the raw serialized layers).

When `store.save(...)`, `store.patch(...)`, or `store.restoreDefaults(...)` is called with `expectedSnapshot` (which `SettingsDialogComponent` and `runRpcSettingsMenu` pass automatically):

- If the target scope's file or adapter state changed externally since `load()`, the store/adapter throws `ConcurrencyConflictError` (`code === "CONCURRENCY_CONFLICT"`).
- **In TUI mode:** The dialog catches the error, shows a red banner (`"Settings changed on disk. Press R or click Reload below to refresh."`), and renders a warning `[R Reload]` footer pill so the user never silently overwrites external edits.
- **In RPC mode:** The menu notifies the user and automatically reloads the latest values from the store.
- **Programmatic override:** Pass `force: true` to `store.save(...)` / `store.patch(...)` / `store.restoreDefaults(...)` to skip the snapshot check when an intentional overwrite is desired.

---

## 6. Defense-in-Depth Security Hardening

Because project settings files can live inside untrusted repositories, `pi-extension-settings-tui` enforces several security layers by default:

### Project Trust Gating
- `store.load({ trustedProject })` defaults `trustedProject` to `false`. Unless `trustedProject` is `true` (via `ctx.isProjectTrusted()` in `openSettingsDialog`), project overrides are **never read** and **never included** in `effective` or `provenance`.
- `store.save`, `store.patch`, and `store.restoreDefaults` throw if `scope === "project"` while `trustedProject` is `false`.
- In the UI, `SettingsDialogComponent` locks switching to Project scope when untrusted (`Global (Project untrusted)`), and `runRpcSettingsMenu` omits `project` from selectable scopes.

### Symlink Refusal & Atomic Writes
- `assertNoSymlinkSegments` checks path segments (anchored to `agentDir`/`cwd` as `baseRoot` when the target resides under them, safely resolving macOS `/var -> /private/var` and `/tmp -> /private/tmp` root symlinks) and throws `SettingsSecurityError("SYMLINK_REJECTED")` if any segment is a symbolic link.
- `readJsonFileHardened` opens files with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` and verifies `fstatSync(fd).isFile()`, rejecting symlinks (`ELOOP`) and FIFOs/directories (`NOT_REGULAR_FILE`).
- `ensureSecureDir` creates missing directories with mode `0o700` and verifies every segment via `lstatSync`.
- `writeJsonFileHardened` writes to a random temp file in the target directory using `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` with mode `0o600`, calls `fsyncSync`, re-checks `assertTargetNotSymlink`, and atomically `renameSync`s into place (cleaning up the temp file on failure).

### Size Cap (64 KiB)
- `MAX_SETTINGS_BYTES` is `65536` (`64 * 1024` bytes), configurable via `maxBytes` in `JsonFileStorageOptions`.
- Both `readJsonFileHardened` and `writeJsonFileHardened` reject larger payloads with `SettingsSecurityError("SIZE_LIMIT_EXCEEDED")`.

### Secret-Key Rejection
- `SECRET_KEY_PATTERN` (`/api.?key|token|secret|password|authorization|credential/i`) is checked recursively across plain objects and arrays (`findSecretKeys`):
  - **On write (`save`, `patch`, `writeJsonFileHardened`, `SessionStorageAdapter`, `MemoryStorageAdapter`):** Throws `SettingsSecurityError("SECRET_KEY_REJECTED")` and refuses to persist.
  - **On read (`SettingsStore.load`):** Strips matching keys recursively via `stripSecretKeys` and emits a user-visible warning (`Ignored secret key "..." in <scope> settings.`).

### Control-Character Sanitization
- `field.string` (with `stripControlChars !== false`) and `field.multiSelect` (with `allowCustom: true`) strip ANSI escape sequences (CSI, OSC, DCS/SOS/PM/APC, 2-byte ESC) and C0/C1 control characters using `stripControlChars`, preventing terminal injection when settings from untrusted files are rendered in the TUI.
