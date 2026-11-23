import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FieldMap, InferSettingsValues, SettingsSchema } from "../schema/index.js";
import type { LoadedSettings, SettingsStore } from "../store/index.js";
import type { OpenSettingsDialogOptions, OpenSettingsDialogResult } from "./types.js";

export type { OpenSettingsDialogOptions, OpenSettingsDialogResult } from "./types.js";
export { openSettingsDialog } from "./open-settings-dialog.js";

export async function runRpcSettingsMenu<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  store: SettingsStore<TFields>,
  loaded: LoadedSettings<InferSettingsValues<TFields>>,
  options?: Pick<
    OpenSettingsDialogOptions<TFields>,
    "saveMode" | "onApply" | "initialTab" | "initialField" | "availableModels" | "scopedModels"
  >,
): Promise<OpenSettingsDialogResult<InferSettingsValues<TFields>>> {
  const { runRpcSettingsMenu: run } = await import("./rpc-fallback.js");
  return run(ctx, schema, store, loaded, options);
}
