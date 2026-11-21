# Field Types & Common Options

`pi-extension-settings-tui` provides 8 declarative field builders on `field` (`field.boolean`, `field.enum`, `field.multiSelect`, `field.string`, `field.number`, `field.integer`, `field.model`, and `field.custom<T>`). Each builder returns a strongly typed definition consumed by schema validation, storage diffing, the TUI dialog, and the RPC menu.

> **Related guides:** [Getting Started](getting-started.md) · [Storage & Security](storage-and-security.md) · [TUI, Mouse & RPC](tui-mouse-and-rpc.md) · [Overview](../README.md)

---

## Common Field Options

Every field builder accepts these base options (`FieldBase<T, TValues>`):

| Option | Type | Description |
| :--- | :--- | :--- |
| `tab` | `string` | Tab ID from `defineSettings({ tabs })`. Defaults to the first tab (or `"general"` if `tabs` is omitted). Unknown tab IDs throw at schema definition time. |
| `label` | `string` | Human-readable label shown in the row list and RPC menu. |
| `description` | `string` | Help text shown in the bottom help area when the row is selected, and in sub-route headers. |
| `default` | `T` | Default value used when neither Global nor Project overrides the key. |
| `experimental` | `boolean` | When `true`, renders a warning-colored `[lab]` badge next to the field label. |
| `disabled` | `boolean \| ((values: Readonly<TValues>) => boolean)` | Dims and skips the row in navigation; blocks editing in both TUI and RPC. |
| `visibleWhen` | `(values: Readonly<TValues>) => boolean` | Dynamically hides or shows the field based on current draft values. |
| `format` | `(value: T) => string` | Custom display formatter for the row's right-hand value column and RPC menu. |
| `tone` | `ValueTone \| ((value: T) => ValueTone)` | Theme color hint for the rendered value: `"default"`, `"accent"`, `"warn"`, `"error"`, `"success"`, or `"muted"`. |
| `scopes` | `readonly ("global" \| "project")[]` | Restricts which scopes may persist or edit this field. Disallowed keys in a scope file are ignored with a warning on load and skipped during diff/save. |

Example using common options:

```ts
import { defineSettings, field } from "pi-extension-settings-tui";

interface MyValues extends Record<string, unknown> {
  mode: "off" | "standard" | "strict";
  strictThreshold: number;
  globalEndpoint: string;
}

const schema = defineSettings({
  id: "common-options-demo",
  title: "Common Options Demo",
  fields: {
    mode: field.enum({
      label: "Mode",
      default: "standard",
      options: [
        { value: "off", label: "Off", tone: "muted" },
        { value: "standard", label: "Standard", tone: "accent" },
        { value: "strict", label: "Strict", tone: "warn" },
      ],
    }),
    strictThreshold: field.integer<MyValues>({
      label: "Strict threshold",
      description: "Only visible when Mode is not Off; disabled unless Mode is Strict.",
      default: 80,
      min: 0,
      max: 100,
      unit: "%",
      experimental: true,
      visibleWhen: (values) => values.mode !== "off",
      disabled: (values) => values.mode !== "strict",
      tone: (val) => (val >= 90 ? "warn" : "accent"),
    }),
    globalEndpoint: field.string({
      label: "Telemetry endpoint",
      description: "Locked to Global scope so repositories cannot redirect traffic.",
      default: "https://example.invalid/events",
      scopes: ["global"],
      format: (url) => url.replace(/^https?:\/\//, ""),
    }),
  },
});
```

---

## 1. `field.boolean`

- **TypeScript type:** `boolean`
- **TUI interaction:** Instant inline toggle on `Enter`, `Space`, `←`/`→`, or a single left click.
- **Default formatting & tone:** Displays `"On"` (`"success"`) or `"Off"` (`"muted"`), customizable with `trueLabel` / `falseLabel`.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `trueLabel` | `string` | `"On"` *(TUI)* / `"Enabled"` *(RPC)* | Label shown when `true`. |
| `falseLabel` | `string` | `"Off"` *(TUI)* / `"Disabled"` *(RPC)* | Label shown when `false`. |

```ts
const enabled = field.boolean({
  tab: "general",
  label: "Auto-format on save",
  description: "Format modified files automatically after tool edits.",
  default: true,
  trueLabel: "Enabled",
  falseLabel: "Disabled",
});
```

---

## 2. `field.enum`

- **TypeScript type:** Exact literal union `T` (e.g. `"off" | "balanced" | "strict"`).
- **TUI interaction:** Depends on `display`:
  - `"auto"` *(default)*: Cycles inline on `Enter`/`Space` when `options.length <= 3`; opens a searchable `SelectRoute` picker when `options.length > 3`.
  - `"cycle"`: Always cycles inline on `Enter`/`Space`.
  - `"picker"`: Always opens `SelectRoute` (with `/` fuzzy filter and option descriptions).
  - Note: Pressing `←` / `→` on a selected enum row always steps through options inline regardless of `display`.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `options` | `readonly EnumOption<T>[]` | *(required)* | Array of `{ value: T, label: string, description?: string, tone?: ValueTone }`. |
| `display` | `"auto" \| "cycle" \| "picker"` | `"auto"` | Controls whether activating the row cycles inline or pushes `SelectRoute`. |

```ts
const logLevel = field.enum({
  tab: "general",
  label: "Log level",
  description: "Minimum severity written to extension diagnostics.",
  default: "info",
  display: "picker", // force searchable picker even with <= 3 or 4 options
  options: [
    { value: "debug", label: "Debug", description: "Verbose trace logs", tone: "muted" },
    { value: "info", label: "Info", description: "Standard operational events", tone: "accent" },
    { value: "warn", label: "Warn", description: "Recoverable issues only", tone: "warn" },
    { value: "error", label: "Error", description: "Failures only", tone: "error" },
  ],
});
```

---

## 3. `field.multiSelect`

- **TypeScript type:** `T[]` (deduplicated array of strings).
- **TUI interaction:** Opens `MultiSelectRoute`, a searchable `[x]`/`[ ]` checklist with optional collapsible groups (`[-]`/`[+]`), `Space` toggle, `Ctrl+A` toggle all visible items, and inline custom-value creation when `allowCustom: true`.
- **Default formatting:** Displays `emptyLabel` (default `"None"`) when empty, joins up to 3 labels if `<= 32` characters, otherwise shows `"N selected"`.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `options` | `readonly MultiSelectOption<T>[] \| ((context?: unknown) => readonly MultiSelectOption<T>[])` | *(required)* | Static array or lazy resolver returning `{ value, label, description?, group? }`. |
| `minItems` | `number` | — | Minimum number of selected items enforced on submit & validation. |
| `maxItems` | `number` | — | Maximum number of selected items enforced on submit & validation. |
| `maxItemLength` | `number` | — | Maximum character length per item (especially useful with `allowCustom`). |
| `allowCustom` | `boolean` | `false` | Allows typing a custom value in the filter box (`+ Add custom "<query>"`) or via `+ Add custom item` in RPC mode. Control characters are stripped on validation. |
| `collapsibleGroups` | `boolean` | `true` *(in `MultiSelectRoute` when groups exist)* | Enables `[+]` / `[-]` folding of grouped options when not actively filtering. |
| `emptyLabel` | `string` | `"None"` | Display text when `[]` is selected. |

```ts
const plugins = field.multiSelect({
  tab: "filters",
  label: "Active capabilities",
  description: "Select capabilities grouped by tier, or type a custom tag.",
  default: ["audit", "cache"],
  minItems: 1,
  maxItems: 6,
  maxItemLength: 40,
  allowCustom: true,
  collapsibleGroups: true,
  emptyLabel: "Disabled",
  options: () => [
    { value: "audit", label: "Audit log", description: "Record tool calls", group: "Core" },
    { value: "cache", label: "Response cache", group: "Core" },
    { value: "metrics", label: "Latency metrics", group: "Core" },
    { value: "trace-io", label: "Trace storage I/O", group: "Experimental" },
  ],
});
```

> **Note:** When `options` is a function `() => [...]`, `MultiSelectRoute` resolves it each time the sub-route opens, and validation allows persisted custom strings because static membership checks are skipped for dynamic option lists.

---

## 4. `field.string`

- **TypeScript type:** `string`
- **TUI interaction:** Opens `TextInputRoute`:
  - Single-line (`multiline: false`, default): renders `@earendil-works/pi-tui`'s `Input` (`Enter` commits, `Esc` cancels).
  - Multiline (`multiline: true`): renders `@earendil-works/pi-tui`'s `Editor` (`Enter` inserts a newline, `Ctrl+S` or clicking `[Ctrl+S Apply]` commits, `Esc` cancels).
- **Live validation:** Errors are displayed inline (`⚠ ...`) and prevent committing invalid values.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `placeholder` | `string` | `""` | Placeholder shown in single-line `Input` and RPC `input`. |
| `minLength` | `number` | — | Minimum string length (checked after trimming/sanitization). |
| `maxLength` | `number` | — | Maximum string length (checked after trimming/sanitization). |
| `pattern` | `RegExp` | — | Regular expression tested against the normalized string (automatically resets `lastIndex` for `/g` or `/y` flags). |
| `patternMessage` | `string` | `"Value does not match required pattern"` | Custom error message when `pattern` fails. |
| `multiline` | `boolean` | `false` | Switches to Pi's multiline `Editor` in TUI and `ctx.ui.editor` in RPC. |
| `trim` | `boolean` | `false` | Trims leading/trailing whitespace before length and pattern validation. |
| `stripControlChars` | `boolean` | `true` | Strips ANSI escape sequences (CSI/OSC/DCS/ESC) and C0/C1 control characters. Preserves `\n` and `\t` when `multiline: true`. Set `false` to opt out. |

```ts
const branchPrefix = field.string({
  tab: "filters",
  label: "Branch prefix",
  description: "Prefix applied to automated worktree branches.",
  default: "pi/",
  placeholder: "e.g. pi/",
  trim: true,
  minLength: 2,
  maxLength: 24,
  pattern: /^[a-z0-9._/-]+$/i,
  patternMessage: "Use only letters, digits, '.', '_', '-', or '/'.",
  stripControlChars: true,
});

const systemNotes = field.string({
  tab: "filters",
  label: "Operator notes",
  description: "Multiline instructions appended to reports.",
  default: "",
  multiline: true,
  maxLength: 500,
});
```

---

## 5. `field.number` & `field.integer`

- **TypeScript type:** `number`
- **TUI interaction:**
  - Press `←` / `→` directly on the row to step inline by `step` (defaults to `1`).
  - Press `Enter` / `Space` (or double-click) to open `TextInputRoute` for typing an exact value.
- **Validation:**
  - `field.number` requires `typeof raw === "number" && Number.isFinite(raw)` and normalizes `-0` to `0`.
  - `field.integer` sets `integer: true`, additionally requiring `Number.isSafeInteger(raw)`.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `min` | `number` | — | Inclusive lower bound. |
| `max` | `number` | — | Inclusive upper bound. |
| `integer` | `boolean` | `false` (`true` on `field.integer`) | Enforces `Number.isSafeInteger`. |
| `step` | `number` | `1` *(used for `←`/`→` inline stepping)* | Increment/decrement amount for inline arrow stepping. |
| `placeholder` | `string` | `"Enter a number"` | Placeholder in `TextInputRoute`. |
| `unit` | `string` | — | Optional unit suffix shown in formatted values and input title (e.g. `"ms"`, `"workers"`). |

```ts
const confidence = field.number({
  tab: "advanced",
  label: "Confidence threshold",
  description: "Score threshold between 0 and 1.",
  default: 0.75,
  min: 0,
  max: 1,
  step: 0.05,
});

const workers = field.integer({
  tab: "advanced",
  label: "Max concurrent",
  description: "Maximum parallel worker tasks.",
  default: 4,
  min: 1,
  max: 64,
  step: 1,
  unit: "workers",
});
```

---

## 6. `field.model`

First-class two-step Pi model + thinking level picker.

- **TypeScript type:**
  - `ModelSelection` (`{ readonly model: string; readonly thinkingLevel: ModelThinkingLevel }`) when `default` is a `ModelSelection` and `allowClear` is not `true`.
  - `ModelSelection | null` when `default: null` (automatically enables `allowClear: true`) or `allowClear: true`.
- **Saved value:** Stores both `model` (canonical `"provider/model-id"` string, preserving nested slashes/colons such as `"openrouter/qwen/qwen3-coder:exacto"`) and `thinkingLevel` (`"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`).
- **Automatic Pi integration:** `openSettingsDialog(ctx, { schema })` automatically feeds `ctx.modelRegistry.getAvailable()` and `ctx.scopedModels` into the picker — no extra wiring needed.
- **Two-step TUI interaction (`ModelPickerRoute`):**
  1. **Step 1 (Select model):** Fuzzy search over provider, model ID, and model name; toggle between **Scoped** models and **All** available models via `Tab` or clicking `[Scoped (N)]` / `[All (M)]`. When `allowClear: true`, includes a clear row at the top to reset to `null`.
  2. **Step 2 (Thinking level):** Lists the thinking levels supported by the chosen model (`off` only for non-reasoning models; respects `thinkingLevelMap` for `xhigh`/`max`/disabled levels), highlights the current/scoped thinking level, and supports `Esc` / clicking `[← Models]` to return to Step 1.
- **Default formatting & tone:** Displays `"provider/model-id (thinkingLevel)"` (`"accent"`), or `emptyLabel ?? "None"` (`"muted"`) when `null`.

| Specific Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `allowClear` | `boolean` | `true` when `default: null`, else `false` | Allows clearing the selection to `null` (skips Step 2). |
| `emptyLabel` | `string` | `"None"` | Display text when `null` and label for the clear row. |
| `emptyDescription` | `string` | `"Clear model selection"` | Description shown on the clear row in the picker. |
| `defaultModelScope` | `"auto" \| "scoped" \| "all"` | `"auto"` | Initial scope tab (`"auto"` starts on `"scoped"` when scoped models exist, else `"all"`). |
| `thinkingLevels` | `readonly ModelThinkingLevel[]` | *(model-supported levels)* | Optional allowlist restricting selectable thinking levels. |
| `defaultThinkingLevel` | `ModelThinkingLevel` | *(model/scoped default or `"medium"`)* | Preferred thinking level preselected in Step 2 for newly chosen models. |
| `models` | `readonly ModelPickerEntry[] \| ((ctx?: unknown) => readonly ModelPickerEntry[])` | `ctx.modelRegistry.getAvailable()` | Optional override/source for available models. |
| `scopedModels` | `readonly ScopedModelEntry[] \| ((ctx?: unknown) => readonly ScopedModelEntry[])` | `ctx.scopedModels` | Optional override/source for scoped models. |

```ts
import { defineSettings, field, parseModelIdentity } from "pi-extension-settings-tui";

const schema = defineSettings({
  id: "pruner",
  title: "Pruner Settings",
  fields: {
    summaryModel: field.model({
      label: "Summary model",
      description: "Model and thinking level used to summarize pruned tool calls.",
      default: null,
      emptyLabel: "Active model (default)",
      emptyDescription: "Use the currently active Pi session model",
    }),
    fallbackModel: field.model({
      label: "Fallback model",
      description: "Explicit fallback model when the primary model fails.",
      default: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" },
      defaultModelScope: "all",
    }),
  },
});

// Resolving a saved ModelSelection back to a Pi model:
// const parsed = selection ? parseModelIdentity(selection.model) : null;
// const piModel = parsed ? ctx.modelRegistry.find(parsed.provider, parsed.id) : ctx.model;
// const thinking = selection?.thinkingLevel;
```

---

## 7. `field.custom<T>`

`field.custom<T>` is an escape hatch for domain-specific values and pickers (for example, choosing a model, agent profile, or structured rule) that don't fit the built-in routes.

| Specific Option | Type | Description |
| :--- | :--- | :--- |
| `validate` | `(raw: unknown) => boolean \| string` | Validates values on load, save, and commit. Return `true` for valid, `false` for generic error, or a non-empty error string. |
| `normalize` | `(raw: unknown) => T` | Optional normalizer called after `validate` succeeds. |
| `openSubroute` | `(params: CustomSubrouteParams<T, TValues>) => unknown` | Factory returning a `Component & Focusable` (optionally with `title?: string`, `handleMouse`, and `dispose?(): void`) pushed onto the dialog route stack. |
| `rpcEdit` | `(ctx: unknown, currentValue: T, draft: Readonly<TValues>) => Promise<T \| undefined>` | Interactive fallback invoked in RPC mode (`ctx.mode === "rpc"`). If omitted, RPC mode displays `"<label> requires interactive TUI mode to edit."`. |

### `CustomSubrouteParams<T, TValues>`

When the user activates a `field.custom` row in TUI mode, `openSubroute` receives:

- `fieldKey`: `string`
- `field`: `CustomFieldDef<T, TValues>`
- `value`: `T` (deep-cloned current value)
- `draft`: `Readonly<TValues>` (deep-cloned current draft values across all fields)
- `tui`, `theme`, `keybindings`
- `commit(next: T)`: validates, pops the sub-route, and updates the draft (or persists immediately in `immediate` mode)
- `cancel()`: pops the sub-route without changing the value

### Full Example: Custom `Component & Focusable` Sub-Route + `rpcEdit`

The example below implements a custom TUI sub-route with keyboard navigation, validation, mouse click support (`press` returning `{ handled: true, focus: true, ... }` and `click` selecting an item), and an `rpcEdit` fallback:

```ts
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  defineSettings,
  field,
  type CustomSubrouteParams,
} from "pi-extension-settings-tui";

interface RouteTarget {
  readonly provider: string;
  readonly model: string;
}

class ModelTargetSubroute implements Component, Focusable {
  readonly title = "Model Target";
  private readonly providerInput: Input;
  private readonly modelInput: Input;
  private readonly theme: Theme;
  private readonly commit: (next: RouteTarget) => void;
  private readonly cancel: () => void;
  private activeInput: "provider" | "model" = "provider";
  private _focused = false;
  private error: string | undefined;

  constructor(params: CustomSubrouteParams<RouteTarget, Record<string, unknown>>) {
    this.theme = params.theme as Theme;
    this.commit = params.commit;
    this.cancel = params.cancel;

    this.providerInput = new Input({ prompt: this.theme.fg("accent", "Provider: ") });
    this.providerInput.setValue(params.value.provider);

    this.modelInput = new Input({ prompt: this.theme.fg("accent", "Model:    ") });
    this.modelInput.setValue(params.value.model);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncChildFocus();
  }

  private syncChildFocus(): void {
    this.providerInput.focused = this._focused && this.activeInput === "provider";
    this.modelInput.focused = this._focused && this.activeInput === "model";
  }

  invalidate(): void {
    this.providerInput.invalidate();
    this.modelInput.invalidate();
  }

  private tryCommit(): void {
    const provider = this.providerInput.getValue().trim();
    const model = this.modelInput.getValue().trim();
    if (!provider || !model) {
      this.error = "Both provider and model are required.";
      return;
    }
    this.error = undefined;
    this.commit({ provider, model });
  }

  render(width: number): string[] {
    const safeWidth = Math.max(16, width);
    const lines: string[] = [
      truncateToWidth(this.theme.fg("muted", "Enter provider and model ID:"), safeWidth, "…", true),
      "",
      ...this.providerInput.render(safeWidth).map((l) => truncateToWidth(l, safeWidth, "…", true)),
      ...this.modelInput.render(safeWidth).map((l) => truncateToWidth(l, safeWidth, "…", true)),
    ];

    if (this.error) {
      lines.push(truncateToWidth(this.theme.fg("error", `⚠ ${this.error}`), safeWidth, "…", true));
    }

    lines.push(
      "",
      truncateToWidth(
        this.theme.fg("dim", "Tab switch input · Enter apply · Esc cancel"),
        safeWidth,
        "…",
        true,
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
      this.activeInput = this.activeInput === "provider" ? "model" : "provider";
      this.syncChildFocus();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.tryCommit();
      return;
    }
    if (this.activeInput === "provider") {
      this.providerInput.handleInput(data);
    } else {
      this.modelInput.handleInput(data);
    }
    this.error = undefined;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    // Sub-route receives coordinates local to the dialog body (y=2 is provider, y=3 is model).
    if (event.type === "press" && event.button === "left") {
      if (event.y === 2) {
        this.activeInput = "provider";
        this.syncChildFocus();
        return { handled: true, focus: true, render: true };
      }
      if (event.y === 3) {
        this.activeInput = "model";
        this.syncChildFocus();
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, focus: true, render: false };
    }
    return { handled: false };
  }
}

export const customFieldExample = defineSettings({
  id: "custom-route-example",
  title: "Custom Route Example",
  fields: {
    target: field.custom<RouteTarget>({
      label: "Fallback model",
      description: "Model used when primary endpoint is unavailable.",
      default: { provider: "anthropic", model: "claude-sonnet-4" },
      experimental: true,
      format: (v) => `${v.provider}/${v.model}`,
      validate: (raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return "Expected an object with provider and model.";
        }
        const rec = raw as Record<string, unknown>;
        if (typeof rec.provider !== "string" || !rec.provider.trim()) {
          return "Provider must be a non-empty string.";
        }
        if (typeof rec.model !== "string" || !rec.model.trim()) {
          return "Model must be a non-empty string.";
        }
        return true;
      },
      normalize: (raw) => {
        const rec = raw as RouteTarget;
        return { provider: rec.provider.trim(), model: rec.model.trim() };
      },
      openSubroute: (params) => new ModelTargetSubroute(params),
      rpcEdit: async (ctx, current) => {
        const extCtx = ctx as ExtensionContext;
        const provider = await extCtx.ui.input("Provider", current.provider);
        if (provider === undefined) return undefined;
        const model = await extCtx.ui.input("Model", current.model);
        if (model === undefined) return undefined;
        return { provider, model };
      },
    }),
  },
});
```

> **Note:** Remember the [security secret-key guard](storage-and-security.md#secret-key-rejection): never name object properties inside a `field.custom` value with secret-like names (`apiKey`, `token`, `secret`, `password`, `authorization`, `credential`), or `SettingsStore` will reject saving them with `SettingsSecurityError("SECRET_KEY_REJECTED")`.
