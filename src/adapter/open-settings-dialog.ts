import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, OverlayOptions } from "@earendil-works/pi-tui";
import { SettingsDialogComponent, type SettingsDialogResult } from "../dialog/index.js";
import type {
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  SettingsSchema,
  SettingsScope,
} from "../schema/index.js";
import { createSettingsStore } from "../store/index.js";
import { runRpcSettingsMenu } from "./rpc-fallback.js";
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

function resolveInitialScope<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  trustedProject: boolean,
): SettingsScope {
  if (!trustedProject && schema.defaultScope === "project" && schema.scopes.includes("global")) {
    return "global";
  }
  if (schema.scopes.includes(schema.defaultScope)) {
    return schema.defaultScope;
  }
  return schema.scopes[0] ?? "global";
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
      agentDir: options.agentDir,
      cwd: options.cwd ?? ctx.cwd,
      fileName: options.fileName,
      globalPath: options.globalPath,
      projectPath: options.projectPath,
    });

  const trustedProject =
    options.trustedProject ??
    (typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false);

  const loaded = await store.load({ trustedProject });
  const initialScope = resolveInitialScope(schema, loaded.trustedProject);

  if (ctx.mode === "tui" && ctx.hasUI) {
    if (ctx.signal?.aborted) {
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
        provenance: Record<keyof TFields & string, FieldProvenance>;
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

    if (ctx.signal) {
      ctx.signal.addEventListener("abort", onAbort, { once: true });
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

          if (ctx.signal?.aborted) {
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
      ctx.signal?.removeEventListener("abort", onAbort);
      if (componentRef && activeDialogs.get(schema.id)?.component === componentRef) {
        activeDialogs.delete(schema.id);
      }
    }
  }

  if (ctx.mode === "rpc" && ctx.hasUI) {
    return runRpcSettingsMenu(ctx, schema, store, loaded, {
      saveMode: options.saveMode,
      onApply: options.onApply,
      initialTab: options.initialTab,
      initialField: options.initialField,
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
}
