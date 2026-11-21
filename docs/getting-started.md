# Getting Started

This guide walks through installing `pi-extension-settings-tui`, declaring a typed settings schema, loading effective settings on startup, wiring a slash command to `openSettingsDialog`, reacting to changes with `onApply`, choosing a save mode, and running the bundled demo extension.

> **Related guides:** [Field Types](field-types.md) · [Storage & Security](storage-and-security.md) · [TUI, Mouse & RPC](tui-mouse-and-rpc.md) · [Overview](../README.md)

---

## 1. Installation

Install `pi-extension-settings-tui` in your Pi extension package:

```bash
npm install pi-extension-settings-tui
```

Key package details:

- **Zero runtime dependencies** — pure ESM targeting Node `>=22.0.0`.
- **Optional peer dependencies** — `@earendil-works/pi-coding-agent` (`>=1.5.0`) and `@earendil-works/pi-tui` are already provided when your extension runs inside Pi, and are not required if you only import the [`/schema` or `/store` subpaths](tui-mouse-and-rpc.md#5-subpath-exports).

---

## 2. Define a Schema & Infer Its Type

Declare your settings once with `defineSettings(...)` and the `field.*` builders. Because `field.enum` and `field.multiSelect` preserve string literal types, `typeof schema.Type` automatically infers exact union types for every setting.

Create `settings.ts` in your extension:

```ts
import { defineSettings, field } from "pi-extension-settings-tui";

export const mySettingsSchema = defineSettings({
  id: "my-extension",
  title: "My Extension Settings",
  description: "Configure behavior globally or per trusted project.",
  settingsFile: "my-extension.json",
  saveMode: "draft", // "draft" (Ctrl+S) | "immediate"
  scopes: ["global", "project"],
  tabs: [
    { id: "general", label: "General", description: "Core options" },
    { id: "safety", label: "Safety", description: "Limits and paths" },
  ],
  fields: {
    enabled: field.boolean({
      tab: "general",
      label: "Enable extension",
      description: "Toggle extension behavior without unloading.",
      default: true,
    }),
    mode: field.enum({
      tab: "general",
      label: "Mode",
      description: "Choose how strictly checks are applied.",
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
      step: 1,
      unit: "attempts",
    }),
    ignoredGlobs: field.multiSelect({
      tab: "safety",
      label: "Ignored paths",
      default: ["node_modules/**"],
      allowCustom: true,
      collapsibleGroups: true,
      options: [
        { value: "node_modules/**", label: "node_modules/**", group: "Dependencies" },
        { value: "dist/**", label: "dist/**", group: "Build" },
        { value: ".git/**", label: "VCS", group: "VCS" },
      ],
    }),
  },
});

// Inferred type:
// {
//   enabled: boolean;
//   mode: "off" | "balanced" | "strict";
//   maxRetries: number;
//   ignoredGlobs: string[];
// }
export type MySettings = typeof mySettingsSchema.Type;
```

> **Note:** `schema.Type` is a compile-time phantom property (`InferSettingsValues<TFields>`). Use `typeof mySettingsSchema.Type` in type positions, and `mySettingsSchema.getDefaults()` if you need a fresh runtime clone of the default values.

### Automatic Mirrored File Paths (`settingsFile`)

Setting `settingsFile` on `defineSettings(...)` (either a flat filename like `"my-extension.json"` or a relative subpath like `"my-extension/settings.json"`) keeps Global and Project locations mirrored automatically:

- **Global:** `~/.pi/agent/<settingsFile>` (or `$PI_CODING_AGENT_DIR/<settingsFile>`)
- **Project:** `<cwd>/.pi/<settingsFile>`

If `settingsFile` is omitted, the store falls back to `<agentDir>/<id>/settings.json` and `<cwd>/.pi/<id>/settings.json`. You can also override `settingsFile` per call in `createSettingsStore`, `createJsonFileStorageAdapter`, or `openSettingsDialog`. See [Storage & Security](storage-and-security.md#2-customizing-storage-paths--file-names) for validation rules and legacy overrides.

---

## 3. Read Effective Settings on Extension Startup

Use `createSettingsStore(schema)` and call `store.load({ trustedProject })` in `session_start` (or lazily when your tool/hook runs). Always pass `ctx.isProjectTrusted()` so project-level `.pi/` overrides are only read when the user trusts the current repository:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSettingsStore } from "pi-extension-settings-tui";
import { mySettingsSchema, type MySettings } from "./settings.js";

export default function myExtension(pi: ExtensionAPI) {
  let settings: MySettings = mySettingsSchema.getDefaults();

  pi.on("session_start", async (_event, ctx) => {
    const store = createSettingsStore(mySettingsSchema, { cwd: ctx.cwd });
    const loaded = await store.load({
      trustedProject: ctx.isProjectTrusted(),
    });

    settings = loaded.effective;

    for (const warning of loaded.warnings) {
      ctx.ui.notify(warning, "warning");
    }
  });
}
```

What `store.load(...)` returns (`LoadedSettings<MySettings>`):

| Property | Meaning |
| :--- | :--- |
| `effective` | Final resolved values (`defaults -> global -> project`). |
| `layers` | Raw validated overrides per scope (`{ global, project }`). |
| `provenance` | Per-key source: `"default" \| "global" \| "project" \| "both"`. |
| `warnings` | Non-fatal validation or stripped-secret warnings from disk. |
| `trustedProject` | Whether project overrides were loaded/writable. |
| `paths` | Resolved file or adapter paths (`{ global?, project? }`). |
| `snapshot` | SHA-256 hashes (`{ globalHash, projectHash }`) for concurrency checks. |

---

## 4. Register a Slash Command with `openSettingsDialog`

Call `openSettingsDialog(ctx, options)` inside `pi.registerCommand(...)`. It automatically handles:

- **TUI mode** (`ctx.mode === "tui" && ctx.hasUI`): opens a single centered overlay with keyboard and fullscreen mouse support.
- **RPC mode** (`ctx.mode === "rpc" && ctx.hasUI`): runs an interactive `ctx.ui.select` / `ctx.ui.input` / `ctx.ui.editor` menu from the same schema.
- **Headless mode** (`print`, `json`, or `!ctx.hasUI`): loads effective settings without opening any UI and returns `closedBy: "headless"`.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSettingsStore, openSettingsDialog } from "pi-extension-settings-tui";
import { mySettingsSchema, type MySettings } from "./settings.js";

export default function myExtension(pi: ExtensionAPI) {
  let settings: MySettings = mySettingsSchema.getDefaults();

  pi.on("session_start", async (_event, ctx) => {
    const store = createSettingsStore(mySettingsSchema, { cwd: ctx.cwd });
    const loaded = await store.load({ trustedProject: ctx.isProjectTrusted() });
    settings = loaded.effective;
  });

  pi.registerCommand("my-settings", {
    description: "Open My Extension settings",
    handler: async (_args, ctx) => {
      const store = createSettingsStore(mySettingsSchema, { cwd: ctx.cwd });

      const result = await openSettingsDialog(ctx, {
        schema: mySettingsSchema,
        store,
        onApply: (next, meta) => {
          // Keep in-memory extension state in sync immediately on every save
          settings = next;
          ctx.ui.notify(
            `Saved ${meta.scope} settings (${meta.writtenKeys.length} override(s))`,
            "info",
          );
        },
      });

      if (result.saved) {
        settings = result.values;
      }
    },
  });
}
```

### Reacting to `onApply`

`onApply(next, meta)` fires whenever changes are persisted (on `Ctrl+S` in `draft` mode, on every edit in `immediate` mode, and after `Restore defaults`):

- `next` — the full resolved effective settings (`MySettings`).
- `meta.scope` — `"global"` or `"project"`.
- `meta.provenance` — updated per-field provenance map.
- `meta.writtenKeys` — keys written to that scope's override file (empty `[]` if all values match the parent layer or after `Restore defaults`).

Using `onApply` is especially helpful in `immediate` mode, where the user can make several edits and then close the dialog without a final "Save" action.

---

## 5. Choosing Between `saveMode: "draft"` and `"immediate"`

You can set `saveMode` on `defineSettings({ saveMode: ... })` as the schema default, and optionally override it per call to `openSettingsDialog(ctx, { saveMode: ... })`:

| Mode | When writes happen | Dirty indicator & close behavior | Best for |
| :--- | :--- | :--- | :--- |
| `"draft"` *(default)* | Only when the user presses `Ctrl+S` or clicks `[Ctrl+S Save]`. | Shows `● Unsaved` in the header when edits differ from baseline; `Esc` / `[Esc Discard]` discards unsaved edits. | Multi-field forms, related thresholds, or settings with `visibleWhen` / `disabled` dependencies where partial edits shouldn't take effect immediately. |
| `"immediate"` | Immediately on every committed edit (inline toggle/step or sub-route submit). | No `● Unsaved` state; footer shows `[Esc Close]`; `onApply` fires on each edit. | Live preferences (e.g., UI toggles, log verbosity) where users expect changes to take effect right away. |

> **Tip:** `Restore defaults` always prompts with a confirmation screen (`ConfirmRoute`) before deleting the active scope's overrides and firing `onApply`.

---

## 6. Running the Bundled Demo Extension

The repository includes a complete showcase extension at [`examples/demo-extension/index.ts`](../examples/demo-extension/index.ts) that exercises all 7 field types across 3 tabs (`General`, `Filters`, `Advanced`), plus a custom `Component & Focusable` sub-route (`CustomNoteSubroute`) with an `rpcEdit` fallback.

Clone, build, and launch it inside Pi:

```bash
git clone https://github.com/championswimmer/pi-extension-settings-tui.git
cd pi-extension-settings-tui
npm install
npm run build
pi --offline --no-session --approve -ne -e ./examples/demo-extension/index.ts
```

Inside Pi, run either slash command:

- `/demo-settings` — opens the dialog in `draft` mode (`Ctrl+S` to save).
- `/demo-settings-immediate` — opens the dialog in `immediate` mode (saves on every change).

You can also override the settings filename used by the demo via `DEMO_SETTINGS_FILENAME`:

```bash
DEMO_SETTINGS_FILENAME=my-demo.json pi --offline --no-session --approve -ne -e ./examples/demo-extension/index.ts
```

---

## Next Steps

- [Field Types](field-types.md) — Complete reference for all 7 `field.*` builders and common field options.
- [Storage & Security](storage-and-security.md) — Layered resolution, custom paths, session/memory adapters, migrations, and security hardening.
- [TUI, Mouse & RPC](tui-mouse-and-rpc.md) — Overlay stack, keyboard shortcuts, fullscreen SGR mouse mode, RPC fallback, and subpath exports.
