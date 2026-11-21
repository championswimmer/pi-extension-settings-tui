# TUI Architecture, Mouse Support, RPC & Subpaths

This guide covers the single-overlay TUI architecture, built-in sub-routes, complete keyboard and fullscreen SGR mouse interactions, singleton overlay reuse, `AbortSignal` cleanup, automatic RPC/headless fallbacks, and package subpath exports.

> **Related guides:** [Getting Started](getting-started.md) · [Field Types](field-types.md) · [Storage & Security](storage-and-security.md) · [Overview](../README.md)

---

## 1. Single-Overlay Architecture & Route Stack

`openSettingsDialog` opens a **single** Pi overlay via `ctx.ui.custom(..., { overlay: true, overlayOptions, onHandle })`. Default `overlayOptions` are:

```ts
{
  anchor: "center",
  width: options.preferredWidth ?? 86,
  minWidth: 44,
  maxHeight: "90%",
  margin: 1,
}
```

Inside that single overlay, `SettingsDialogComponent` maintains an internal navigation stack (`DialogFrame[]` — `routeStack`) instead of opening stacked overlays:

- **Root frame:** Tab bar (when `schema.tabs.length > 1`), scrollable field rows with provenance dots, divider, `Save scope` (when multi-scope) and `Restore defaults` management rows, contextual help/banner area, provenance legend, and clickable footer action pills.
- **Pushed sub-routes:** Rendered inside the same rounded box frame with a breadcrumb header (e.g. `Demo Settings › Filters › Active tags`) and a `[Esc Back]` footer pill:
  - `SelectRoute` — Searchable single-select picker (`Input` + `fuzzyFilter`) for `field.enum` with `> 3` options or `display: "picker"`.
  - `MultiSelectRoute` — Searchable `[x]`/`[ ]` checklist with collapsible `[-]`/`[+]` groups, `Ctrl+A` toggle all visible, count bounds (`minItems`/`maxItems`), and inline `+ Add custom "<query>"` when `allowCustom: true`.
  - `ModelPickerRoute` — Two-step Pi model + thinking level picker for `field.model`: Step 1 fuzzy-searchable list with clickable/Tab-toggleable `Scoped` vs `All` model views (and optional clear row); Step 2 thinking level selector tailored to the chosen model's reasoning capabilities.
  - `TextInputRoute` — Single-line `Input` (`field.string`, `field.number`, `field.integer`) or multiline `Editor` (`field.string` with `multiline: true`), with live validation banners.
  - `ConfirmRoute` — Confirmation dialog used by `Restore defaults` (with destructive styling and `Cancel` focused by default).
  - Custom sub-routes — Any `Component & Focusable` (with optional `title`, `handleMouse`, and `dispose()`) returned by `field.custom({ openSubroute })`.

`SettingsDialogComponent` also bounds its total rendered height to `Math.max(8, (tui.terminal?.rows ?? 24) - 4)` and clamps every rendered line to `width` via `truncateToWidth` / `fitToWidth`.

---

## 2. Save Modes (`draft` vs `immediate`)

Extensions configure `saveMode` either on the schema via `defineSettings({ saveMode: "draft" | "immediate", ... })` (defaults to `"draft"`) or per invocation via `openSettingsDialog(ctx, { schema, saveMode: "immediate" })` (and `SettingsDialogOptions.saveMode` when instantiating `SettingsDialogComponent` directly).

### `saveMode: "draft"` (Default)
- **In-memory draft holding:** Editing fields updates an in-memory draft only — **zero** writes hit the storage adapter and `onApply` is not invoked until the user explicitly saves.
- **Warning-colored unsaved indicators:**
  - The dialog header displays `● Unsaved` (or `● Unsaved (N)` when multiple fields differ from baseline) in warning color.
  - Every modified field row appends a warning-colored `*` directly after its label (and after `[lab]` if `experimental: true`).
  - Reverting a modified field back to its baseline value automatically clears both its row `*` and updates/clears the header `● Unsaved` badge.
- **Commit or discard:**
  - Pressing `Ctrl+S` (or clicking `[Ctrl+S Save]`) persists all held in-memory edits in a single atomic `store.save(...)` call, triggers `onApply`, clears dirty state, and closes with `closedBy: "save"`.
  - Pressing `Esc` (or clicking `[Esc Discard]`) discards all in-memory edits without writing to disk and closes with `closedBy: "escape"` / `"cancel"` (`saved: false`, `dirty` reflecting whether edits were discarded).

### `saveMode: "immediate"`
- **Serialized immediate auto-saving:** Every committed field edit triggers `store.save(...)` and `onApply` immediately without waiting for `Ctrl+S`.
- **Rapid-edit race protection:** `SettingsDialogComponent` tracks a monotonic `draftVersion` on every field commit and serializes in-flight writes with `pendingImmediateSave`. If new edits arrive while an async `store.save(...)` is still in flight, the completing save updates `loadedState` and `baselineValues` without clobbering newer `draftValues`, and immediately flushes the latest draft in `finally` — preventing dropped edits or false `ConcurrencyConflictError` collisions.
- **Auto-save UI cues:** The footer hint is prefixed with `Auto-save · ` (e.g. `Auto-save · Click/Enter edit · Tab tabs · Wheel scroll`), the `[Ctrl+S Save]` pill and `● Unsaved` badge are omitted, and closing via `Esc` / `[Esc Close]` returns `closedBy: "immediate"` with `saved: true` if any save succeeded.

---

## 3. Keyboard Shortcut Reference

| Context | Key(s) | Action |
| :--- | :--- | :--- |
| **Root list** | `↑` / `↓` (or `tui.select.up` / `tui.select.down`) | Move selection (wraps around; skips dividers and disabled rows) |
| **Root list** | `PgUp` / `PgDn` (via `getSelectPageIndex`) | Page up / down through rows |
| **Root list** | `Tab` / `Shift+Tab` | Next / previous tab (when `tabs.length > 1`) |
| **Root list** | `Enter` / `Space` (or `tui.select.confirm`) | Toggle boolean, cycle/open enum picker, open sub-route, cycle scope, or open `Restore defaults` confirmation |
| **Root list** | `←` / `→` | Step inline on selected row: toggle boolean, step enum option, step `number`/`integer` by `step ?? 1`, or cycle `Save scope` |
| **Root list (draft mode)** | `Ctrl+S` | Save changes to the active scope and close |
| **Root list (conflict)** | `R` / `r` | Reload latest settings from disk after `ConcurrencyConflictError` |
| **Root list** | `Esc` (or `tui.select.cancel`) | Close dialog (`closedBy: "escape"` in draft mode, or `"immediate"` in immediate mode) |
| **SelectRoute** | Typing / Backspace | Filter options with `fuzzyFilter` |
| **SelectRoute** | `↑` / `↓`, `PgUp` / `PgDn` | Move / page through filtered options |
| **SelectRoute** | `Enter` | Commit highlighted option and pop back to root |
| **SelectRoute** | `Esc` | Cancel and pop back to root |
| **MultiSelectRoute** | Typing / Backspace | Filter items (expands matching groups; shows `+ Add custom "<query>"` when `allowCustom: true`) |
| **MultiSelectRoute** | `Space` | Toggle item `[x]`/`[ ]`, toggle group `[+]`/`[-]`, or add custom item |
| **MultiSelectRoute** | `Ctrl+A` | Toggle all currently filtered options on/off |
| **MultiSelectRoute** | `Enter` | Toggle group fold if on a group header, add custom item if on custom row, otherwise validate & commit selection |
| **MultiSelectRoute** | `Esc` | Cancel and pop back to root |
| **ModelPickerRoute (Step 1)** | `Tab` / `Shift+Tab` | Toggle between `Scoped` models and `All` available models |
| **ModelPickerRoute (Step 1)** | Typing / Backspace | Fuzzy-filter models by provider, model ID, and name |
| **ModelPickerRoute (Step 1)** | `↑` / `↓`, `PgUp` / `PgDn`, `Enter` | Navigate models and advance to Step 2 (or clear to `null` on clear row) |
| **ModelPickerRoute (Step 2)** | `↑` / `↓`, `Enter` / `Space` | Select thinking level and commit `{ model, thinkingLevel }` |
| **ModelPickerRoute (Step 2)** | `Esc` / `Backspace` / `←` | Return to Step 1 (preserving search query & scope) |
| **TextInputRoute (single-line)** | `Enter` (or `tui.input.submit`) | Validate and commit value |
| **TextInputRoute (multiline)** | `Enter` | Insert newline at cursor |
| **TextInputRoute (multiline)** | `Ctrl+S` | Validate and commit multiline value |
| **TextInputRoute (both)** | `Esc` | Cancel and pop back to root |
| **ConfirmRoute** | `←` / `→`, `Tab` / `Shift+Tab`, `h` / `l` | Switch focus between Confirm and Cancel pills |
| **ConfirmRoute** | `y` / `Y` | Confirm immediately |
| **ConfirmRoute** | `n` / `N` / `Esc` | Cancel immediately |
| **ConfirmRoute** | `Enter` | Activate the highlighted button |

---

## 4. Fullscreen SGR Mouse Mode vs. Regular Mode

`SettingsDialogComponent` inspects `tui.mode`:

### Regular Mode (`tui.mode === "regular"`)
- Pi renders inline in the normal terminal buffer without alt-screen mouse capture.
- Footer hints automatically switch to keyboard-only guidance (`↑/↓ move · Enter edit · Tab tabs`).

### Fullscreen Mode (`tui.mode === "fullscreen"`)
- Pi runs in `TuiAltScreen` with SGR mouse reporting enabled.
- During every `render()`, `SettingsDialogComponent` and its built-in sub-routes populate exact 0-based overlay-local bounding boxes in `HitRegionTracker` (`kind`: `"tab" | "row" | "action" | "button" | "option" | "group" | "input"`).

#### What Is Clickable
- **Tab chips:** Single left click switches tabs immediately.
- **Root rows:**
  - **Boolean fields**, **Save scope**, and **Restore defaults** activate immediately on a single click.
  - **All other fields** (`enum`, `multiSelect`, `string`, `number`, `integer`, `model`, `custom`) select on the first click and open/activate on a second click (either a double-click `clickCount === 2`, or clicking a row that was already selected on `press`).
- **Footer action pills:** `[Ctrl+S Save]`, `[Esc Discard]`, `[Esc Close]`, `[R Reload]`, `[Esc Back]`.
- **Sub-route controls:**
  - `SelectRoute`: clicking the `/` search bar forwards mouse events to `Input`; clicking an option commits it.
  - `MultiSelectRoute`: clicking `/` focuses search; clicking a `[+]`/`[-]` group header folds/unfolds it; clicking an option or `+ Add custom` row toggles/adds it; clicking `[Enter Apply]` or `[Esc Cancel]` commits or cancels.
  - `ModelPickerRoute`: clicking `[Scoped (N)]` / `[All (M)]` toggles model scope; clicking `/` focuses search; clicking a model advances to Step 2; in Step 2, clicking `[← Models]` returns to Step 1 and clicking a thinking level commits `{ model, thinkingLevel }`.
  - `TextInputRoute`: clicking inside the `Input`/`Editor` widget bounds forwards local coordinates; clicking `[Enter Apply]` / `[Ctrl+S Apply]` or `[Esc Cancel]` commits or cancels.
  - `ConfirmRoute`: clicking `[Confirm]` / `[Restore]` or `[Cancel]` confirms or cancels.

#### Wheel Scrolling
- Mouse `wheel` events (`wheelDelta`) scroll the root field list, `SelectRoute` option list, and `MultiSelectRoute` checklist, and are forwarded to the inner `Input`/`Editor` when inside `TextInputRoute` widget bounds.

#### Dead-Space Absorption & `click` Synthesis
- `SettingsDialogComponent` sets `readonly capturesViewportInput = true`.
- In `TuiAltScreen`, a left `press` only synthesizes a subsequent `click` (and suppresses terminal text selection) if the target returns `{ handled: true, ... }`.
- Therefore, clicking non-interactive dead space inside the dialog frame (borders, padding, help text, legend) returns `{ handled: true, render: false }` on `press`, preventing accidental text selection dragging behind or inside the overlay.
- Similarly, when forwarding `press` to child widgets (like Pi's `Editor` in `TextInputRoute`), the sub-route ensures `handled: true` and `focus: true` are returned so clicks inside the editor stay captured inside the overlay.
- For custom sub-routes, `SettingsDialogComponent.handleSubrouteMouse` translates overlay-local `(x, y)` coordinates into child-local `(x - bounds.x, y - bounds.y)` coordinates automatically.

#### `tmux` / Multiplexer Hover Behavior
- When Pi detects a terminal multiplexer (`TMUX`, `ZELLIJ`, `STY`, or `TERM` starting with `tmux` or `screen`), `TuiAltScreen` enables **button-motion tracking** (`1002` + SGR `1006`) rather than **all-motion tracking** (`1003` + SGR `1006`) so multiplexers don't lag forwarding continuous pointer `move` (hover) events.
- Because `SettingsDialogComponent` and all built-in sub-routes rely exclusively on `press`, `click`, and `wheel` (and never depend on `move` hover events), every mouse interaction works reliably inside `tmux`, `zellij`, and `screen`.

---

## 5. Singleton Reuse, `AbortSignal`, RPC & Headless Behavior

### Singleton Overlay Reuse
`openSettingsDialog` tracks active TUI overlays in a module registry keyed by `schema.id`:

- If the user invokes the command again while a dialog for the same `schema.id` is already open:
  1. It focuses the existing `OverlayHandle` (`handle.focus()`).
  2. It calls `component.navigateTo({ tab: options.initialTab, field: options.initialField })`, popping any open sub-route and jumping directly to the requested tab/field.
  3. It returns immediately with `{ mode: "tui", opened: false, reusedExisting: true, saved: false, closedBy: "reused", ... }` carrying the latest applied values and scope.

### `AbortSignal` Cleanup
- If `ctx.signal` is already aborted before opening in TUI mode, `openSettingsDialog` skips opening the overlay and returns `{ opened: false, saved: false, closedBy: "abort", ... }`.
- While the overlay is open, an `"abort"` listener on `ctx.signal` calls `component.abort()`, which disposes open sub-routes and closes the overlay cleanly with `closedBy: "abort"`.
- A `finally` block always removes the signal listener and deletes the `schema.id` entry from the active-overlay registry.

### Automatic RPC Fallback (`ctx.mode === "rpc"`)
When `ctx.mode === "rpc" && ctx.hasUI`, `openSettingsDialog` delegates to `runRpcSettingsMenu`:
- Renders a `ctx.ui.select(schema.title, ...)` loop listing visible fields (prefixed with `[TabLabel]` when multi-tab), formatted values, provenance badges (`[G]`, `[P]`, `[P>G]`, `[default]`), dirty `*` markers, and `[disabled]` markers.
- Maps each field kind to Pi's RPC UI primitives:
  - `boolean` → `ctx.ui.select`
  - `enum` → `ctx.ui.select`
  - `multiSelect` → iterative `ctx.ui.select` toggle loop (`[x]` / `[ ]`, `+ Add custom item`, `Done`)
  - `string` → `ctx.ui.input` or `ctx.ui.editor` (when `multiline: true`)
  - `number` / `integer` → `ctx.ui.input` with numeric parsing and retry loop
  - `model` → two-step `ctx.ui.select` flow (Step 1: Scoped/All toggle, text filter via `ctx.ui.input`, optional clear, model selection; Step 2: thinking level selection with `← Back to models`)
  - `custom` → calls `field.rpcEdit(ctx, currentValue, draft)` if provided, or notifies that TUI mode is required
- Includes `Save scope`, `Restore defaults` (with `ctx.ui.confirm`), and `Save changes` / `Discard & close` (draft mode) or `Done` (immediate mode).

### Headless Mode (`print` / `json` / `!ctx.hasUI`)
When running non-interactively (e.g. `pi -p` or `--mode json` or `!ctx.hasUI`), `openSettingsDialog` loads effective settings via `store.load({ trustedProject })` without opening any UI and returns:

```ts
{
  mode: ctx.mode, // e.g. "print" | "json" | "tui" | "rpc"
  opened: false,
  saved: false,
  values: loaded.effective,
  scope: initialScope,
  paths: loaded.paths,
  warnings: loaded.warnings,
  closedBy: "headless",
}
```

---

## 6. Subpath Exports

`package.json` exposes 5 clean ESM + TypeScript declaration entry points so you only pull in the runtime dependencies you need:

| Import Path | Primary Exports | Runtime Dependencies |
| :--- | :--- | :--- |
| `pi-extension-settings-tui` | Everything from `/schema`, `/store`, `/dialog`, and `/adapter` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` |
| `pi-extension-settings-tui/schema` | `defineSettings`, `field`, `validateFieldValue`, `validatePartialSettings`, `stripControlChars`, `findSecretKeys`, `SECRET_KEY_PATTERN`, `deepEqual`, `cloneValue`, schema types | Pure JS/TS (zero Pi or Node `fs` imports) |
| `pi-extension-settings-tui/store` | `SettingsStore`, `createSettingsStore`, `createJsonFileStorageAdapter`, `createSessionStorageAdapter`, `createMemoryStorageAdapter`, `resolveDefaultAgentDir`, `resolveScopeFilePath`, `ConcurrencyConflictError`, `SettingsSecurityError`, `fs-hardening` helpers | Node.js built-ins only (zero Pi imports) |
| `pi-extension-settings-tui/dialog` | `SettingsDialogComponent`, `SelectRoute`, `MultiSelectRoute`, `ModelPickerRoute`, `TextInputRoute`, `ConfirmRoute`, `HitRegionTracker`, `renderPillRow`, `frame` helpers | `@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent` |
| `pi-extension-settings-tui/adapter` | `openSettingsDialog`, `runRpcSettingsMenu`, `OpenSettingsDialogOptions`, `OpenSettingsDialogResult` | `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` |
