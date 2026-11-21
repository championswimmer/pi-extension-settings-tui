# pi-extension-settings-tui

Declarative, mouse-capable TUI settings dialog and hardened layered JSON persistence library for [Pi](https://github.com/earendil-works/pi-coding-agent) extensions over `@earendil-works/pi-tui`.

- **Zero runtime dependencies** (Node.js `>=22.0.0`, pure ESM + strict TypeScript)
- **Declarative schema & exact TS inference** (`typeof schema.Type` infers literal unions for `enum` and `multiSelect`)
- **Single-overlay `@earendil-works/pi-tui` dialog** with an internal sub-route stack (`ConfirmRoute`, `TextInputRoute`, `SelectRoute`, `MultiSelectRoute`, and `custom` sub-routes) and strict terminal height budgeting
- **Fullscreen SGR mouse support** (`capturesViewportInput`, clickable tabs, rows, action pills, wheel scrolling) alongside full keyboard navigation
- **Layered Global & Project overrides** (`defaults -> global -> project`), writing only overridden keys and deleting empty layer files cleanly
- **Hardened file I/O**: symlink segment rejection, `0o700`/`0o600` atomic temp-file writes, 64 KiB size cap, recursive secret-key rejection, SHA-256 optimistic concurrency, and project trust gating
- **Configurable storage paths & adapters**: customize `fileName`, `globalPath`, or `projectPath` (string or resolver function), or use `createSessionStorageAdapter` / `createMemoryStorageAdapter`
- **Draft (`Ctrl+S`) & Immediate save modes**
- **Automatic RPC & headless fallback** (`ctx.mode === "rpc"` menus via `ctx.ui.*`, structured non-opening result in `print` / `json` / `!ctx.hasUI`)

---

## Installation

```bash
npm install pi-extension-settings-tui
```

### Peer Dependencies

`@earendil-works/pi-coding-agent` (`>=1.5.0`) and `@earendil-works/pi-tui` (`*`) are optional peer dependencies—extensions running inside Pi already have them available, while standalone consumers of `pi-extension-settings-tui/schema` or `pi-extension-settings-tui/store` do not need to install them.

```json
{
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": ">=1.5.0",
    "@earendil-works/pi-tui": "*"
  }
}
```

---

## Quickstart

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSettingsStore,
  defineSettings,
  field,
  openSettingsDialog,
} from "pi-extension-settings-tui";

export const mySchema = defineSettings({
  id: "my-extension",
  title: "My Extension Settings",
  description: "Configure behavior globally or per trusted project.",
  saveMode: "draft", // "draft" (Ctrl+S) | "immediate"
  tabs: [
    { id: "general", label: "General" },
    { id: "safety", label: "Safety" },
  ],
  fields: {
    enabled: field.boolean({
      tab: "general",
      label: "Enable extension",
      description: "Toggle automatic analysis on session start.",
      default: true,
    }),
    mode: field.enum({
      tab: "general",
      label: "Mode",
      description: "Choose how aggressively checks are applied.",
      default: "balanced",
      options: [
        { value: "off", label: "Off", tone: "muted" },
        { value: "balanced", label: "Balanced", tone: "accent" },
        { value: "strict", label: "Strict", tone: "warn" },
      ],
    }),
    maxRetries: field.integer({
      tab: "safety",
      label: "Max retries",
      default: 2,
      min: 0,
      max: 10,
      unit: "attempts",
    }),
    ignoredGlobs: field.multiSelect({
      tab: "safety",
      label: "Ignored paths",
      default: ["node_modules/**"],
      allowCustom: true,
      options: [
        { value: "node_modules/**", label: "node_modules/**" },
        { value: "dist/**", label: "dist/**" },
        { value: ".git/**", label: ".git/**" },
      ],
    }),
  },
});

// Exact inferred TypeScript type:
// { enabled: boolean; mode: "off" | "balanced" | "strict"; maxRetries: number; ignoredGlobs: string[] }
export type MySettings = typeof mySchema.Type;

export default function myExtension(pi: ExtensionAPI) {
  const store = createSettingsStore(mySchema);

  pi.registerCommand("my-settings", {
    description: "Open My Extension settings",
    handler: async (_args, ctx) => {
      const result = await openSettingsDialog(ctx, {
        schema: mySchema,
        store,
        onApply: (next, meta) => {
          ctx.ui.notify(
            `Applied ${meta.scope} settings (${meta.writtenKeys.length} overridden)`,
            "info",
          );
        },
      });

      if (result.saved) {
        // Use result.values (typed as MySettings)
      }
    },
  });
}
```

---

## Field Types Reference

All field builders are exported on `field` and share common base options: `tab?`, `label`, `description?`, `default`, `experimental?`, `disabled?` (boolean or `(values) => boolean`), `visibleWhen?` (`(values) => boolean`), `format?`, `tone?`, and `scopes?` (`("global" | "project")[]`).

| Builder | Inferred TS Type | Key Options | Dialog Interaction |
| :--- | :--- | :--- | :--- |
| `field.boolean` | `boolean` | `trueLabel?`, `falseLabel?` | Single-key/single-click toggle (`On` / `Off` by default) |
| `field.enum` | Literal union `T` | `options` (`{ value, label, description?, tone? }[]`), `display?` (`"auto" \| "cycle" \| "picker"`) | Cycles inline or opens searchable `SelectRoute` |
| `field.multiSelect` | `T[]` | `options` (array or `() => options`), `minItems?`, `maxItems?`, `maxItemLength?`, `allowCustom?`, `collapsibleGroups?`, `emptyLabel?` | Opens searchable `MultiSelectRoute` checklist with optional collapsible groups |
| `field.string` | `string` | `placeholder?`, `minLength?`, `maxLength?`, `pattern?`, `patternMessage?`, `multiline?`, `trim?`, `stripControlChars?` (default `true`) | Opens `TextInputRoute` (`Input`, or `Editor` with `Ctrl+S` when `multiline: true`) |
| `field.number` | `number` | `min?`, `max?`, `integer?`, `step?`, `placeholder?`, `unit?` | Opens `TextInputRoute` with finite numeric validation |
| `field.integer` | `number` | Same as `field.number` with `integer: true` enforced (`Number.isSafeInteger`) | Opens `TextInputRoute` with safe-integer validation |
| `field.custom<T>` | `T` | `validate?`, `normalize?`, `openSubroute?`, `rpcEdit?` | Pushes custom `Component & Focusable` sub-route (or uses `rpcEdit` in RPC mode) |

---

## Configurable Storage Paths & File Names

By default, `createJsonFileStorageAdapter` / `createSettingsStore` store overrides at:

- **Global**: `~/.pi/agent/<id>/<fileName>` (default `fileName`: `settings.json`; respects `$PI_CODING_AGENT_DIR`)
- **Project**: `<cwd>/.pi/agent/<id>/<fileName>`

Only values that differ from defaults (for `global`) or from the effective global value / default (for `project`) are written. When a scope has zero overrides, its file is deleted cleanly (`deleteWhenEmpty: true` by default).

### Customizing Paths or File Names

Configure `storage` on `defineSettings(...)` or pass overrides to `createSettingsStore(...)` / `openSettingsDialog(...)`:

```ts
const schema = defineSettings({
  id: "checklist",
  title: "Checklist Settings",
  storage: {
    fileName: "checklist.json",
    globalPath: ({ agentDir, fileName }) => `${agentDir}/extensions/${fileName}`,
    projectPath: ({ cwd, fileName }) => `${cwd}/.pi/${fileName}`,
  },
  fields: { /* ... */ },
});
```

`globalPath` and `projectPath` accept either a path string (absolute, or relative to `agentDir` / `cwd`) or a resolver function receiving `{ agentDir, id, fileName }` / `{ cwd, id, fileName }`.

### Session-Scoped & In-Memory Storage

For extensions that persist configuration inside Pi session entries rather than on disk, use `createSessionStorageAdapter`:

```ts
import { createSessionStorageAdapter, createSettingsStore } from "pi-extension-settings-tui/store";

const adapter = createSessionStorageAdapter({
  entryType: "my-extension-settings",
  appendEntry: (type, data) => pi.appendEntry(type, data),
  getEntries: () => ctx.sessionManager.getEntries(),
});

const store = createSettingsStore(schema, { adapter });
```

For unit tests, use `createMemoryStorageAdapter(initial?)` for zero-disk layered storage with full SHA-256 concurrency checks.

---

## Fullscreen Mouse Mode vs Regular Mode

`SettingsDialogComponent` opens as a single centered Pi overlay (`ctx.ui.custom(..., { overlay: true })`) with `capturesViewportInput = true`.

### Keyboard Controls

| Context | Keys | Action |
| :--- | :--- | :--- |
| Root list | `↑` / `↓`, `PgUp` / `PgDn` | Move selection / scroll list within terminal height budget |
| Root list | `Tab` / `Shift+Tab` | Switch tabs (when multiple tabs are defined) |
| Root list | `Enter` / `Space` | Toggle boolean, cycle/pick enum, open sub-route, toggle scope, or restore defaults |
| Draft mode | `Ctrl+S` | Save changes to the active scope (`global` or `project`) |
| Root / Sub-route | `Esc` | Cancel/discard (with confirmation if draft has unsaved changes) or pop sub-route (`[Esc Back]`) |
| `MultiSelectRoute` | `Space`, `Ctrl+A`, `Enter` | Toggle item/group, toggle all filtered items, apply selection |
| `TextInputRoute` | `Enter` (single-line) / `Ctrl+S` (multiline) | Validate & commit text/number value |
| `ConfirmRoute` | `y` / `n` / `←` / `→` / `Tab` / `Enter` | Confirm or cancel action |

### Fullscreen SGR Mouse Support

When running in Pi's fullscreen alt-screen mode (`tui.mode === "fullscreen"`), `handleMouse(event)` tracks exact 0-based overlay-local hit regions on every render pass:

- **Tabs**: single click switches active tab
- **List rows**: first click selects the row; clicking an already-selected row, double-clicking (`clickCount === 2`), clicking a `boolean` row, or clicking a management row (`Save scope`, `Restore defaults`) activates it immediately
- **Mouse wheel**: scrolls the active list or sub-route list without moving focus out of the dialog
- **Footer & route pills**: click `[Ctrl+S Save]`, `[Esc Discard]` / `[Esc Close]`, `[Esc Back]`, `[Confirm]`, `[Cancel]`, `[Enter Apply]`, or `[R Reload]` on conflict
- **Dead-space absorption**: left-presses inside the dialog return `{ handled: true }` so the alt-screen does not fall through to terminal text selection
- **Regular (inline) mode**: keyboard hints adapt automatically when not in fullscreen mouse mode

---

## Subpath Exports

Import everything from the root package or use targeted subpaths to keep non-TUI bundles minimal:

| Subpath | Contents | Pi / Node Requirements |
| :--- | :--- | :--- |
| `pi-extension-settings-tui` | Unified re-exports of all layers | Full package |
| `pi-extension-settings-tui/schema` | `defineSettings`, `field`, validators, `findSecretKeys`, `stripControlChars`, `deepEqual`, `cloneValue` | **Zero Pi imports, zero Node `fs` imports** |
| `pi-extension-settings-tui/store` | `SettingsStore`, `createSettingsStore`, `createJsonFileStorageAdapter`, `createSessionStorageAdapter`, `createMemoryStorageAdapter`, `fs-hardening`, error classes | Node built-ins only (**zero Pi imports**) |
| `pi-extension-settings-tui/dialog` | `SettingsDialogComponent`, `ConfirmRoute`, `TextInputRoute`, `SelectRoute`, `MultiSelectRoute`, `HitRegionTracker`, frame helpers | `@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent` (`Theme` type) |
| `pi-extension-settings-tui/adapter` | `openSettingsDialog`, `runRpcSettingsMenu`, result/option types | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` |

---

## Security & Hardening

`pi-extension-settings-tui` treats settings files—especially repository-local `.pi/` files—as untrusted input:

- **Symlink rejection**: `assertNoSymlinkSegments` resolves any `baseRoot` via `realpathSync` (preserving OS root symlinks on macOS such as `/var -> /private/var` and `/tmp -> /private/tmp`) and rejects symlinks in every directory/file segment beneath `baseRoot`, paired with `O_NOFOLLOW` on open.
- **Strict permissions & atomic writes**: directories are created with `0o700`; writes stream to a `0o600` (`O_CREAT | O_EXCL | O_NOFOLLOW`) temporary file, `fsync`, and atomically `rename` into place.
- **64 KiB read & write cap**: rejects oversized files or payloads with `SettingsSecurityError` (`SIZE_LIMIT_EXCEEDED`).
- **Secret-key defense**: keys matching `/api.?key|token|secret|password|authorization|credential/i` are recursively rejected on write (`SettingsSecurityError` with `SECRET_KEY_REJECTED`) and stripped with warnings on read.
- **Control character sanitization**: `stripControlChars` strips ANSI CSI/OSC/DCS/ESC sequences and C0/C1 control characters from string values by default.
- **Optimistic concurrency**: tracks SHA-256 digests (`expectedSnapshot` / `expectedHash`) and throws `ConcurrencyConflictError` if a layer changes on disk between load and save.
- **Project trust gating**: `trustedProject: false` (defaulting to `ctx.isProjectTrusted()` when available) prevents reading or writing project-scope overrides.

---

## License

[MIT](./LICENSE) © 2026 Arnav Gupta
