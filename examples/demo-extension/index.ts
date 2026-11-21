import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
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
  openSettingsDialog,
  type CustomSubrouteParams,
} from "../../dist/index.js";

class CustomNoteSubroute implements Component, Focusable {
  readonly title = "Custom Note";
  private readonly input: Input;
  private readonly theme: Theme;
  private readonly commit: (next: string) => void;
  private readonly cancel: () => void;
  private _focused = false;
  private error: string | undefined;

  constructor(params: CustomSubrouteParams<string, Record<string, unknown>>) {
    this.theme = params.theme as Theme;
    this.commit = params.commit;
    this.cancel = params.cancel;
    this.input = new Input({
      prompt: this.theme.fg("accent", "✎ "),
      placeholder: "Enter custom note (max 80 chars)…",
      placeholderStyle: (text) => this.theme.fg("dim", text),
    });
    this.input.setValue(params.value ?? "");
    (this.input as unknown as { cursor: number }).cursor = (params.value ?? "").length;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private tryCommit(): void {
    const next = this.input.getValue().trim();
    if (next.length > 80) {
      this.error = `Must be at most 80 characters (currently ${next.length}).`;
      return;
    }
    this.error = undefined;
    this.commit(next);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(12, width);
    const lines: string[] = [
      truncateToWidth(
        this.theme.fg("muted", "Custom sub-route editor (experimental)"),
        safeWidth,
        "…",
        true,
      ),
      "",
      ...this.input.render(safeWidth).map((l) => truncateToWidth(l, safeWidth, "…", true)),
    ];

    if (this.error) {
      lines.push(truncateToWidth(this.theme.fg("error", this.error), safeWidth, "…", true));
    }

    lines.push(
      "",
      truncateToWidth(
        this.theme.fg("dim", "Enter apply · Ctrl+R clear · Esc cancel"),
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
    if (matchesKey(data, Key.enter)) {
      this.tryCommit();
      return;
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      this.input.setValue("");
      this.error = undefined;
      return;
    }
    this.input.handleInput(data);
    this.error = undefined;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (event.type === "press" && event.button === "left") {
      return { handled: true, focus: true, render: true };
    }
    return { handled: false };
  }
}

export const demoSchema = defineSettings({
  id: "demo-settings",
  title: "Demo Settings",
  description: "Interactive settings showcase for pi-extension-settings-tui.",
  settingsFile: "demo-settings/settings.json",
  scopes: ["global", "project"],
  saveMode: "draft",
  tabs: [
    { id: "general", label: "General", description: "Core mode and region settings" },
    { id: "filters", label: "Filters", description: "Tags, labels, and notes" },
    { id: "advanced", label: "Advanced", description: "Thresholds, concurrency, and custom routes" },
  ],
  fields: {
    enabled: field.boolean({
      tab: "general",
      label: "Enable extension",
      description: "Toggle demo extension behavior on or off.",
      default: true,
    }),
    mode: field.enum({
      tab: "general",
      label: "Mode",
      description: "Cycle between off, opportunistic, and strict enforcement.",
      default: "opportunistic",
      options: [
        { value: "off", label: "Off", description: "Disabled", tone: "muted" },
        {
          value: "opportunistic",
          label: "Opportunistic",
          description: "Apply when low-risk",
          tone: "accent",
        },
        {
          value: "strict",
          label: "Strict",
          description: "Enforce all rules",
          tone: "warn",
        },
      ],
    }),
    region: field.enum({
      tab: "general",
      label: "Region",
      description: "Select a preferred deployment region (opens searchable picker).",
      default: "us-east",
      options: [
        { value: "us-east", label: "US East", description: "Virginia (iad)" },
        { value: "us-west", label: "US West", description: "Oregon (pdx)" },
        { value: "eu-west", label: "EU West", description: "Ireland (dub)" },
        { value: "eu-central", label: "EU Central", description: "Frankfurt (fra)" },
        { value: "ap-south", label: "AP South", description: "Mumbai (bom)" },
      ],
    }),
    summaryModel: field.model({
      tab: "general",
      label: "Summary model",
      description: "Pick a Pi model (Scoped/All + fuzzy search) and its thinking level.",
      default: null,
      emptyLabel: "Active model (default)",
      emptyDescription: "Use the currently active Pi session model",
    }),
    tags: field.multiSelect({
      tab: "filters",
      label: "Active tags",
      description: "Select feature tags grouped by stability tier.",
      default: ["audit", "cache"],
      collapsibleGroups: true,
      allowCustom: true,
      options: [
        { value: "audit", label: "Audit log", group: "Core" },
        { value: "cache", label: "Response cache", group: "Core" },
        { value: "metrics", label: "Latency metrics", group: "Core" },
        { value: "mouse-fx", label: "Mouse highlights", group: "Experimental" },
        { value: "trace-io", label: "Trace storage I/O", group: "Experimental" },
      ],
    }),
    labelPrefix: field.string({
      tab: "filters",
      label: "Label prefix",
      description: "Short prefix prepended to generated items (max 32 chars).",
      default: "demo",
      placeholder: "e.g. demo",
      maxLength: 32,
      trim: true,
    }),
    notes: field.string({
      tab: "filters",
      label: "Notes",
      description: "Multi-line operator notes edited with Pi's Editor.",
      default: "",
      multiline: true,
      maxLength: 500,
    }),
    threshold: field.number({
      tab: "advanced",
      label: (values) =>
        values.mode === "strict" ? "Strict threshold" : "Confidence threshold",
      description: "Floating-point score threshold between 0 and 1.",
      default: 0.75,
      min: 0,
      max: 1,
      step: 0.05,
      eligible: (values) =>
        values.enabled
          ? true
          : { eligible: false, reason: "Enable the extension on the General tab first." },
    }),
    maxConcurrent: field.integer({
      tab: "advanced",
      label: "Max concurrent",
      description: "Maximum parallel worker tasks (1–64).",
      default: 4,
      min: 1,
      max: 64,
      step: 1,
      unit: "workers",
    }),
    statusSummary: field.view({
      tab: "advanced",
      label: "Configuration summary",
      description: "Read-only Markdown preview of the current draft settings.",
      value: "View…",
      format: "markdown",
      content: ({ draft, scope }) =>
        [
          `# Demo Settings (${scope})`,
          "",
          `- **Enabled:** \`${String(draft.enabled)}\``,
          `- **Mode:** \`${String(draft.mode)}\` · **Region:** \`${String(draft.region)}\``,
          `- **Threshold:** \`${String(draft.threshold)}\` · **Max concurrent:** \`${String(draft.maxConcurrent)}\``,
        ].join("\n"),
    }),
    customNote: field.custom<string>({
      tab: "advanced",
      label: "Custom note",
      description: "Experimental custom sub-route field with dedicated RPC editor.",
      default: "default-note",
      experimental: true,
      normalize: (raw) => (typeof raw === "string" ? raw.trim() : String(raw ?? "")),
      validate: (raw) => {
        if (typeof raw !== "string") return "Custom note must be a string.";
        if (raw.trim().length > 80) return "Custom note must be at most 80 characters.";
        return true;
      },
      openSubroute: (params) => new CustomNoteSubroute(params),
      rpcEdit: async (ctx, currentValue) => {
        const extCtx = ctx as ExtensionContext;
        return extCtx.ui.input("Custom note (max 80 chars)", currentValue);
      },
    }),
  },
});

export type DemoSettings = typeof demoSchema.Type;

export default function demoSettingsExtension(pi: ExtensionAPI): void {
  const getCustomSettingsFile = (): string | undefined => {
    const value = process.env.DEMO_SETTINGS_FILE?.trim();
    return value && value.length > 0 ? value : undefined;
  };

  const getCustomFileName = (): string | undefined => {
    const value = process.env.DEMO_SETTINGS_FILENAME?.trim();
    return value && value.length > 0 ? value : undefined;
  };

  const resolveStorageOverrides = (): { settingsFile?: string; fileName?: string } => {
    const customSettingsFile = getCustomSettingsFile();
    const customFileName = getCustomFileName();
    return {
      settingsFile:
        customSettingsFile ??
        (customFileName ? `${demoSchema.id}/${customFileName}` : undefined),
      fileName: customFileName,
    };
  };

  pi.registerCommand("demo-settings", {
    description: "Open Demo Settings dialog (draft save mode)",
    handler: async (_args, ctx) => {
      const storageOverrides = resolveStorageOverrides();
      await openSettingsDialog(ctx, {
        schema: demoSchema,
        ...storageOverrides,
        onApply: (_next, meta) => {
          ctx.ui.notify(
            `Saved to ${meta.scope} (${meta.writtenKeys.length} override(s))`,
            "info",
          );
        },
      });
    },
  });

  pi.registerCommand("demo-settings-immediate", {
    description: "Open Demo Settings dialog (immediate save mode)",
    handler: async (_args, ctx) => {
      const storageOverrides = resolveStorageOverrides();
      await openSettingsDialog(ctx, {
        schema: demoSchema,
        ...storageOverrides,
        saveMode: "immediate",
        onApply: (_next, meta) => {
          ctx.ui.notify(
            `Saved to ${meta.scope} (${meta.writtenKeys.length} override(s))`,
            "info",
          );
        },
      });
    },
  });
}
