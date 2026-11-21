# pi-extension-settings-tui

A declarative settings dialog and layered JSON persistence library for [Pi](https://github.com/earendil-works/pi-coding-agent) extensions, built on `@earendil-works/pi-tui`.

Define your extension's settings schema once and get:

- **A single-overlay TUI dialog** with tabs, searchable pickers, collapsible multi-select checklists, inline text/number editors, and custom sub-routes — styled with the user's active Pi theme.
- **Native mouse support in fullscreen TUI mode** — click tabs, toggle booleans, click rows, scroll with the wheel, and click footer action pills (`[Ctrl+S Save]`, `[Esc Discard]`, `[Esc Back]`), with full keyboard support everywhere.
- **Global & Project layered overrides** — persists only keys that differ from defaults (or from global overrides), shows provenance dots (`●`) at a glance, and respects Pi's project trust model.
- **Configurable settings file names & paths** — customize the filename or path resolvers to fit existing extensions without breaking user configs, or plug in Pi session-entry storage.
- **Hardened file I/O out of the box** — atomic writes (`0o600`), symlink refusal, 64 KiB cap, secret-key rejection, control-character sanitization, and optimistic concurrency checks.
- **Automatic RPC & non-TUI fallback** — generates a working `ctx.ui.select` / `ctx.ui.input` menu in RPC mode and returns structured diagnostics in headless (`print`/`json`) mode.
- **Zero runtime dependencies** — pure ESM, strict TypeScript (`typeof schema.Type` infers exact literal unions), Node `>=22`.

---

## Preview

Rendered inside Pi (`--tui-mode fullscreen`):

```text
╭────────────────────────────────────────────────────────────────────────────────────╮
│ Demo Settings                                                   ● Unsaved [Global] │
│  General   Filters   Advanced                                                      │
├────────────────────────────────────────────────────────────────────────────────────┤
│ ❯ Enable extension                         ●                                   Off │
│   Mode                                       ●                              Strict │
│   Region                                   ●                              AP South │
│ ────────────────────────────────────────────────────────────────────────────────── │
│   Save scope                                                                Global │
│   Restore defaults                                                   Reset global… │
│ Toggle demo extension behavior on or off.                                          │
│ Saved: ● Global · ● Project · ● ● Both                                             │
│ Click/Enter edit · Tab tabs · Wheel scroll             [Ctrl+S Save] [Esc Discard] │
╰────────────────────────────────────────────────────────────────────────────────────╯
```

Multi-select checklist with search and collapsible groups:

```text
╭────────────────────────────────────────────────────────────────────────────────────╮
│ Demo Settings › Filters › Active tags                           ● Unsaved [Global] │
├────────────────────────────────────────────────────────────────────────────────────┤
│ Select feature tags grouped by stability tier.                                     │
│ / Filter items...                                                                  │
│ ❯ [-] Core (2/3)                                                                   │
│     [x] Audit log                                                                  │
│     [x] Response cache                                                             │
│     [ ] Latency metrics                                                            │
│   [-] Experimental (0/2)                                                           │
│     [ ] Mouse highlights                                                           │
│     [ ] Trace storage I/O                                                          │
│ [Enter Apply]  [Esc Cancel] 2 selected                                             │
│ Space toggle · Ctrl+A all · Enter apply/fold · Esc cancel                          │
│ Click or use keys inside view                                           [Esc Back] │
╰────────────────────────────────────────────────────────────────────────────────────╯
```

---

## Installation

```bash
npm install pi-extension-settings-tui
```

`@earendil-works/pi-coding-agent` (`>=1.5.0`) and `@earendil-works/pi-tui` are optional peer dependencies — they are already provided when your extension runs inside Pi, and aren't needed if you only import the standalone `/schema` or `/store` subpaths.

---

## Quickstart

Declare your schema once, infer its TypeScript type, and wire `openSettingsDialog` into a Pi slash command:

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
      options: [
        { value: "node_modules/**", label: "node_modules/**", group: "Dependencies" },
        { value: "dist/**", label: "dist/**", group: "Build" },
        { value: ".git/**", label: ".git/**", group: "VCS" },
      ],
      collapsibleGroups: true,
    }),
  },
});

// Inferred type:
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
            `Saved ${meta.scope} settings (${meta.writtenKeys.length} override(s))`,
            "info",
          );
        },
      });

      if (result.saved) {
        // result.values is typed as MySettings
      }
    },
  });
}
```

---

## Declarative Field Types

Every builder on `field` supports common options: `tab?`, `label`, `description?`, `default`, `experimental?` (renders `[lab]`), `disabled?` (boolean or `(values) => boolean`), `visibleWhen?` (`(values) => boolean`), `format?`, `tone?`, and `scopes?`.

| Builder | TypeScript Type | Dialog Experience |
| :--- | :--- | :--- |
| `field.boolean` | `boolean` | Instant inline toggle on `Enter`, `Space`, or single click (`trueLabel?`, `falseLabel?`) |
| `field.enum` | Literal union `T` | Inline cycle for ≤3 options or searchable picker with per-option help (`display?: "auto" \| "cycle" \| "picker"`) |
| `field.multiSelect` | `T[]` | Searchable `[x]`/`[ ]` checklist with optional collapsible groups (`collapsibleGroups`, `minItems`, `maxItems`, `allowCustom`) |
| `field.string` | `string` | Single-line input or multiline editor (`multiline: true`, `minLength`, `maxLength`, `pattern`, `trim`) |
| `field.number` | `number` | Numeric input with `[min, max]` bounds, optional `unit`, and `←`/`→` inline stepping (`step`) |
| `field.integer` | `number` | Safe-integer variant of `field.number` |
| `field.custom<T>` | `T` | Escape hatch for extension-owned pickers (e.g. model/agent pickers) via `openSubroute` and optional `rpcEdit` |

---

## Saving, Scopes & Custom File Paths

Settings resolve in layers: **defaults → global → project** (with project automatically skipped unless the current project is trusted via `ctx.isProjectTrusted()`).

- **Override-only files**: Saving to Global stores only keys that differ from defaults; saving to Project stores only keys that differ from the effective Global value. Changing a global setting automatically flows through to projects that haven't overridden it.
- **Provenance dots**: A 3-cell column shows whether each setting comes from Global (`●  `), Project (`  ●`), or Both (`● ●`).
- **Restore defaults**: Built-in row cleanly deletes the active scope's overrides after confirmation.

### Customizing File Names and Paths

By default, settings live at:

- **Global**: `~/.pi/agent/<id>/<fileName>` (default `fileName`: `settings.json`; respects `$PI_CODING_AGENT_DIR`)
- **Project**: `<cwd>/.pi/agent/<id>/<fileName>`

You can match any existing extension's config layout using `storage` on `defineSettings(...)` (or overrides on `createSettingsStore` / `openSettingsDialog`):

```ts
const schema = defineSettings({
  id: "my-extension",
  title: "My Extension",
  storage: {
    fileName: "my-extension.json",
    globalPath: ({ agentDir, fileName }) => `${agentDir}/${fileName}`,
    projectPath: ({ cwd, fileName }) => `${cwd}/.pi/${fileName}`,
  },
  fields: { /* ... */ },
});
```

### Session-Scoped Storage (No Disk Files)

For extensions that store settings inside Pi session entries (`pi.appendEntry`) instead of JSON files:

```ts
import { createSessionStorageAdapter, createSettingsStore } from "pi-extension-settings-tui/store";

const adapter = createSessionStorageAdapter({
  entryType: "my-extension:settings:v1",
  appendEntry: (type, data) => pi.appendEntry(type, data),
  getEntries: () => ctx.sessionManager.getEntries(),
});

const store = createSettingsStore(schema, { adapter });
```

---

## Keyboard & Fullscreen Mouse Controls

### Keyboard

| Where | Keys | Action |
| :--- | :--- | :--- |
| Settings list | `↑` / `↓`, `PgUp` / `PgDn` | Move selection / scroll list |
| Settings list | `Tab` / `Shift+Tab` | Switch tabs |
| Settings list | `Enter` / `Space` | Toggle boolean, cycle/open picker, edit value, switch scope, or restore defaults |
| Number / Integer row | `←` / `→` | Step value inline when `step` (or integer default `1`) applies |
| Draft mode | `Ctrl+S` | Save changes to the active scope |
| Anywhere | `Esc` | Go back from sub-route, discard/confirm unsaved draft, or close dialog |
| Multi-select | `Space`, `Ctrl+A`, `Enter` | Toggle item or fold group, toggle all visible items, apply selection |
| Multiline text | `Ctrl+S` | Commit multiline editor value |

### Fullscreen Mouse Mode (`--tui-mode fullscreen`)

When Pi runs in fullscreen alt-screen mode (`tui.mode === "fullscreen"`), mouse interactions work out of the box:

- Click **tab chips** to switch tabs.
- Click a **boolean** or management row (`Save scope`, `Restore defaults`) to toggle/activate immediately; click any other row once to select and a second time (or double-click) to edit.
- Scroll with the **mouse wheel** on the main list, searchable pickers, and multi-select checklists.
- Click **footer pills** (`[Ctrl+S Save]`, `[Esc Discard]`, `[Esc Close]`, `[Esc Back]`, `[Enter Apply]`, `[Confirm]`, `[Cancel]`, `[R Reload]`).
- In **regular** (inline) mode, footer hints automatically switch to keyboard-only guidance.

### RPC & Headless Mode

- **`ctx.mode === "rpc"`**: Automatically opens an interactive menu built with `ctx.ui.select`, `ctx.ui.input`, `ctx.ui.editor`, and `ctx.ui.confirm` from the same schema.
- **`print` / `json` / `!ctx.hasUI`**: Loads effective settings without opening a UI and returns `{ opened: false, values, paths, warnings }`.

---

## Subpath Exports

Import everything from the root package or pull in individual layers:

| Import Path | What It Contains | Runtime Requirements |
| :--- | :--- | :--- |
| `pi-extension-settings-tui` | Complete library | Pi extension runtime |
| `pi-extension-settings-tui/schema` | `defineSettings`, `field`, validation, provenance & diff helpers | Pure JS/TS (no Pi or Node `fs` imports) |
| `pi-extension-settings-tui/store` | `SettingsStore`, hardened JSON / session / memory adapters | Node.js built-ins only (no Pi imports) |
| `pi-extension-settings-tui/dialog` | `SettingsDialogComponent`, `SelectRoute`, `MultiSelectRoute`, `TextInputRoute`, `ConfirmRoute` | `@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent` |
| `pi-extension-settings-tui/adapter` | `openSettingsDialog`, `runRpcSettingsMenu` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` |

---

## Security & Reliability

Because `.pi/` settings can live inside untrusted repositories, persistence is hardened by default:

- **Project trust gating**: Project overrides are neither read nor written unless `ctx.isProjectTrusted()` (or explicit `trustedProject: true`) is true.
- **Symlink refusal & atomic writes**: Rejects symlink segments beneath the base directory (`lstat` + `O_NOFOLLOW`), creates `0o700` directories, writes `0o600` temp files with `fsync`, and atomically renames into place.
- **Size & secret guards**: Enforces a 64 KiB cap on read/write and rejects secret-like keys (`apiKey`, `token`, `secret`, `password`, `authorization`, `credential`) recursively on write.
- **Optimistic concurrency**: Detects external edits on disk between opening and saving the dialog, prompting you to reload rather than silently overwriting.

---

## Try the Demo Extension

Clone the repo, build, and launch the included example extension inside Pi:

```bash
git clone https://github.com/championswimmer/pi-extension-settings-tui.git
cd pi-extension-settings-tui
npm install
npm run build
pi --offline --no-session --approve -ne -e ./examples/demo-extension/index.ts
```

Then run `/demo-settings` (draft mode) or `/demo-settings-immediate` inside Pi.

---

## License

[MIT](./LICENSE) © 2026 Arnav Gupta
