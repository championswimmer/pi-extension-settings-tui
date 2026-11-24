import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
// Keep a runtime @earendil-works/pi-tui import so Pi's jiti loader applies its
// @earendil-works/pi-tui alias instead of falling back to native Node ESM,
// which would fail on the lazy import("../dialog/settings-dialog.js") below
// when installed without a local peer copy of @earendil-works/pi-tui.
import "@earendil-works/pi-tui";
import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import type { SettingsDialogComponent, SettingsDialogResult } from "../dialog/index.js";
import type {
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  ModelPickerEntry,
  PersistedFieldKeys,
  SaveMode,
  ScopedModelEntry,
  SettingsSchema,
  SettingsScope,
} from "../schema/index.js";
import { createSettingsStore } from "../store/index.js";
import type { OpenSettingsDialogOptions, OpenSettingsDialogResult } from "./types.js";

interface ActiveDialogEntry<TFields extends FieldMap = FieldMap> {
  readonly component: SettingsDialogComponent<TFields>;
  readonly handleRef: { current: OverlayHandle | undefined };
  readonly getSnapshot: () => {
    readonly values: InferSettingsValues<TFields>;
    readonly scope: SettingsScope;
    readonly paths: Partial<Record<SettingsScope, string>>;
  };
}

const activeDialogs = new Map<string, ActiveDialogEntry<any>>();

function combineAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): { readonly signal: AbortSignal | undefined; readonly cleanup: () => void } {
  if (!a) return { signal: b, cleanup: () => {} };
  if (!b) return { signal: a, cleanup: () => {} };
  if (typeof AbortSignal.any === "function") {
    return { signal: AbortSignal.any([a, b]), cleanup: () => {} };
  }
  const combined = new AbortController();
  const onAbort = () => combined.abort();
  if (a.aborted || b.aborted) {
    combined.abort();
    return { signal: combined.signal, cleanup: () => {} };
  }
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return {
    signal: combined.signal,
    cleanup: () => {
      a.removeEventListener("abort", onAbort);
      b.removeEventListener("abort", onAbort);
    },
  };
}

function resolveInitialScope<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  trustedProject: boolean,
  saveMode?: SaveMode,
): SettingsScope {
  const effectiveSaveMode = saveMode ?? schema.saveMode;
  const selectable =
    effectiveSaveMode === "session-draft"
      ? schema.scopes.filter((s) => s !== "session")
      : schema.scopes;
  if (!trustedProject && schema.defaultScope === "project" && selectable.includes("global")) {
    return "global";
  }
  if (selectable.includes(schema.defaultScope)) {
    return schema.defaultScope;
  }
  return selectable[0] ?? "global";
}

export async function openSettingsDialog<TFields extends FieldMap>(
  ctx: ExtensionContext,
  options: OpenSettingsDialogOptions<TFields>,
): Promise<OpenSettingsDialogResult<InferSettingsValues<TFields>>> {
  const { schema } = options;

  if (ctx.mode === "tui" && ctx.hasUI) {
    const existing = activeDialogs.get(schema.id) as ActiveDialogEntry<TFields> | undefined;
    if (existing) {
      existing.handleRef.current?.focus();
      existing.component.navigateTo({
        tab: options.initialTab,
        field: options.initialField,
      });
      const snapshot = existing.getSnapshot();
      return {
        mode: "tui",
        opened: false,
        reusedExisting: true,
        saved: false,
        values: snapshot.values,
        scope: snapshot.scope,
        paths: snapshot.paths,
        warnings: [],
        closedBy: "reused",
      };
    }
  }

  const store =
    options.store ??
    createSettingsStore(schema, {
      adapter: options.adapter,
      sessionAdapter: options.sessionAdapter,
      session: options.session,
      agentDir: options.agentDir,
      cwd: options.cwd ?? ctx.cwd,
      settingsFile: options.settingsFile,
      fileName: options.fileName,
      globalPath: options.globalPath,
      projectPath: options.projectPath,
    });

  const trustedProject =
    options.trustedProject ??
    (typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false);

  const loaded = await store.load({ trustedProject });
  const initialScope = resolveInitialScope(schema, loaded.trustedProject, options.saveMode);
  const { signal: combinedSignal, cleanup: cleanupSignals } = combineAbortSignals(
    ctx.signal,
    options.signal,
  );

  const availableModels: readonly ModelPickerEntry[] | (() => readonly ModelPickerEntry[]) =
    options.availableModels ??
    (() => (typeof ctx.modelRegistry?.getAvailable === "function" ? ctx.modelRegistry.getAvailable() : []));
  const scopedModels: readonly ScopedModelEntry[] | (() => readonly ScopedModelEntry[]) =
    options.scopedModels ?? (() => (Array.isArray(ctx.scopedModels) ? ctx.scopedModels : []));

  try {
    if (ctx.mode === "tui" && ctx.hasUI) {
      if (combinedSignal?.aborted) {
        return {
          mode: "tui",
          opened: false,
          saved: false,
          values: loaded.effective,
          scope: initialScope,
          paths: loaded.paths,
          warnings: loaded.warnings,
          closedBy: "abort",
        };
      }

      const { SettingsDialogComponent } = await import("../dialog/settings-dialog.js");

      if (combinedSignal?.aborted) {
        return {
          mode: "tui",
          opened: false,
          saved: false,
          values: loaded.effective,
          scope: initialScope,
          paths: loaded.paths,
          warnings: loaded.warnings,
          closedBy: "abort",
        };
      }

      const overlayOptions: OverlayOptions = {
        anchor: "center",
        width: options.preferredWidth ?? 86,
        minWidth: 44,
        maxHeight: "90%",
        margin: 1,
        ...options.overlayOptions,
      };

      const handleRef: { current: OverlayHandle | undefined } = { current: undefined };
      let componentRef: SettingsDialogComponent<TFields> | undefined;
      let latestValues = loaded.effective;
      let latestScope = initialScope;

      const wrappedOnApply = async (
        next: InferSettingsValues<TFields>,
        meta: {
          scope: SettingsScope;
          provenance: Record<PersistedFieldKeys<TFields>, FieldProvenance>;
          writtenKeys: string[];
        },
      ): Promise<void> => {
        latestValues = next;
        latestScope = meta.scope;
        await options.onApply?.(next, meta);
      };

      const onAbort = (): void => {
        componentRef?.abort();
      };

      if (combinedSignal) {
        combinedSignal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        const dialogResult = await ctx.ui.custom<
          SettingsDialogResult<InferSettingsValues<TFields>>
        >(
          (tui, theme, keybindings, done) => {
            const component = new SettingsDialogComponent({
              schema,
              store,
              initialState: loaded,
              tui,
              theme,
              keybindings,
              done,
              initialTab: options.initialTab,
              initialField: options.initialField,
              saveMode: options.saveMode,
              preferredWidth: options.preferredWidth,
              maxHeight: overlayOptions.maxHeight,
              renderPreview: options.renderPreview,
              availableModels,
              scopedModels,
              onApply: wrappedOnApply,
            });
            componentRef = component;
            activeDialogs.set(schema.id, {
              component,
              handleRef,
              getSnapshot: () => ({
                values: latestValues,
                scope: latestScope,
                paths: loaded.paths,
              }),
            });

            if (combinedSignal?.aborted) {
              queueMicrotask(() => {
                component.abort();
              });
            }

            return component;
          },
          {
            overlay: true,
            overlayOptions,
            onHandle: (handle) => {
              handleRef.current = handle;
            },
          },
        );

        return {
          mode: "tui",
          opened: true,
          saved: dialogResult.saved,
          values: dialogResult.values,
          scope: dialogResult.scope,
          paths: loaded.paths,
          warnings: loaded.warnings,
          closedBy: dialogResult.closedBy,
        };
      } finally {
        combinedSignal?.removeEventListener("abort", onAbort);
        if (componentRef && activeDialogs.get(schema.id)?.component === componentRef) {
          activeDialogs.delete(schema.id);
        }
      }
    }

    if (ctx.mode === "rpc" && ctx.hasUI) {
      const { runRpcSettingsMenu } = await import("./rpc-fallback.js");
      return runRpcSettingsMenu(ctx, schema, store, loaded, {
        saveMode: options.saveMode,
        onApply: options.onApply,
        initialTab: options.initialTab,
        initialField: options.initialField,
        availableModels,
        scopedModels,
        signal: combinedSignal,
      });
    }

    return {
      mode: ctx.mode,
      opened: false,
      saved: false,
      values: loaded.effective,
      scope: initialScope,
      paths: loaded.paths,
      warnings: loaded.warnings,
      closedBy: "headless",
    };
  } finally {
    cleanupSignals();
  }
}
