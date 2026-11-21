import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  cloneValue,
  deepEqual,
  formatModelIdentity,
  getSupportedThinkingLevelsForModel,
  MODEL_THINKING_LEVEL_DESCRIPTIONS,
  parseModelIdentity,
  stripControlChars,
  type AnyFieldDef,
  type BooleanFieldDef,
  type CustomFieldDef,
  type EnumFieldDef,
  type FieldMap,
  type FieldProvenance,
  type InferSettingsValues,
  type ModelFieldDef,
  type ModelPickerEntry,
  type ModelPickerScope,
  type ModelSelection,
  type ModelThinkingLevel,
  type MultiSelectFieldDef,
  type NumberFieldDef,
  type SettingsSchema,
  type SettingsScope,
  type StringFieldDef,
} from "../schema/index.js";
import {
  ConcurrencyConflictError,
  type LoadedSettings,
  type SettingsStore,
} from "../store/index.js";
import type { OpenSettingsDialogOptions, OpenSettingsDialogResult } from "./types.js";

type RpcMenuAction<TFields extends FieldMap> =
  | { readonly kind: "field"; readonly key: keyof TFields & string; readonly def: AnyFieldDef }
  | { readonly kind: "scope" }
  | { readonly kind: "restore" }
  | { readonly kind: "save" }
  | { readonly kind: "discard" }
  | { readonly kind: "done" };

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

function getAvailableScopes<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  trustedProject: boolean,
): readonly SettingsScope[] {
  if (trustedProject) {
    return schema.scopes;
  }
  const filtered = schema.scopes.filter((scope) => scope !== "project");
  return filtered.length > 0 ? filtered : schema.scopes;
}

function formatProvenanceBadge(provenance: FieldProvenance): string {
  switch (provenance) {
    case "global":
      return "[G]";
    case "project":
      return "[P]";
    case "both":
      return "[P>G]";
    case "default":
      return "[default]";
  }
}

function isFieldDisabled<TValues extends Record<string, unknown>>(
  def: AnyFieldDef,
  values: Readonly<TValues>,
): boolean {
  if (typeof def.disabled === "function") {
    return def.disabled(values);
  }
  return Boolean(def.disabled);
}

function isFieldVisible<TValues extends Record<string, unknown>>(
  def: AnyFieldDef,
  values: Readonly<TValues>,
): boolean {
  if (typeof def.visibleWhen === "function") {
    return def.visibleWhen(values);
  }
  return true;
}

function getDialogOpts(signal: AbortSignal | undefined): ExtensionUIDialogOptions | undefined {
  return signal ? { signal } : undefined;
}

function collectVisibleFields<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  values: Readonly<InferSettingsValues<TFields>>,
): Array<{ key: keyof TFields & string; def: AnyFieldDef; tabLabel?: string }> {
  const result: Array<{ key: keyof TFields & string; def: AnyFieldDef; tabLabel?: string }> = [];
  const multipleTabs = schema.tabs.length > 1;

  if (multipleTabs) {
    const seen = new Set<string>();
    for (const tab of schema.tabs) {
      for (const entry of schema.getFieldsForTab(tab.id)) {
        seen.add(entry.key);
        if (isFieldVisible(entry.def, values)) {
          result.push({ key: entry.key, def: entry.def, tabLabel: tab.label });
        }
      }
    }
    for (const key of schema.fieldKeys) {
      if (seen.has(key)) continue;
      const def = schema.fields[key];
      if (def && isFieldVisible(def, values)) {
        result.push({ key, def });
      }
    }
    return result;
  }

  for (const key of schema.fieldKeys) {
    const def = schema.fields[key];
    if (def && isFieldVisible(def, values)) {
      result.push({ key, def });
    }
  }
  return result;
}

async function editBooleanField(
  ctx: ExtensionContext,
  def: BooleanFieldDef<any>,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<boolean | undefined> {
  const trueLabel = def.trueLabel ?? "Enabled";
  const falseLabel = def.falseLabel ?? "Disabled";
  const choice = await ctx.ui.select(def.label, [trueLabel, falseLabel], dialogOpts);
  if (choice === undefined) {
    return undefined;
  }
  return choice === trueLabel;
}

async function editEnumField(
  ctx: ExtensionContext,
  def: EnumFieldDef<string, any>,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<string | undefined> {
  const labelToValue = new Map<string, string>();
  const labels: string[] = [];

  for (const opt of def.options) {
    let display = opt.description ? `${opt.label} — ${opt.description}` : opt.label;
    if (labelToValue.has(display)) {
      display = `${display} (${opt.value})`;
    }
    labelToValue.set(display, opt.value);
    labels.push(display);
  }

  const choice = await ctx.ui.select(def.label, labels, dialogOpts);
  if (choice === undefined) {
    return undefined;
  }
  return labelToValue.get(choice);
}

async function editMultiSelectField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: MultiSelectFieldDef<string, any>,
  currentValue: readonly string[],
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<string[] | undefined> {
  const opts = typeof def.options === "function" ? def.options() : def.options;
  const selected = new Set<string>(currentValue);
  const customAddLabel = "+ Add custom item";
  const doneLabel = "Done";

  while (!ctx.signal?.aborted) {
    const labelToValue = new Map<string, string>();
    const items: string[] = [];

    for (const opt of opts) {
      const checked = selected.has(opt.value) ? "[x]" : "[ ]";
      let itemLabel = `${checked} ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`;
      if (labelToValue.has(itemLabel)) {
        itemLabel = `${itemLabel} (${opt.value})`;
      }
      labelToValue.set(itemLabel, opt.value);
      items.push(itemLabel);
    }

    // Preserve display for any custom values not in static options
    const knownValues = new Set(opts.map((o) => o.value));
    for (const val of selected) {
      if (!knownValues.has(val)) {
        const itemLabel = `[x] ${val}`;
        labelToValue.set(itemLabel, val);
        items.push(itemLabel);
      }
    }

    if (def.allowCustom) {
      items.push(customAddLabel);
    }
    items.push(doneLabel);

    const choice = await ctx.ui.select(
      `${def.label} (${selected.size} selected)`,
      items,
      dialogOpts,
    );
    if (choice === undefined) {
      return undefined;
    }

    if (choice === doneLabel) {
      const ordered: string[] = [];
      for (const opt of opts) {
        if (selected.has(opt.value)) {
          ordered.push(opt.value);
        }
      }
      for (const val of selected) {
        if (!knownValues.has(val)) {
          ordered.push(val);
        }
      }

      const validation = schema.validateField(key, ordered);
      if (!validation.ok) {
        ctx.ui.notify(validation.error, "warning");
        continue;
      }
      return validation.value as string[];
    }

    if (def.allowCustom && choice === customAddLabel) {
      const customInput = await ctx.ui.input(
        `${def.label}: enter custom value`,
        undefined,
        dialogOpts,
      );
      if (customInput !== undefined) {
        const trimmed = customInput.trim();
        if (trimmed.length === 0) {
          ctx.ui.notify("Custom value cannot be empty.", "warning");
        } else if (def.maxItemLength !== undefined && trimmed.length > def.maxItemLength) {
          ctx.ui.notify(
            `Value exceeds maximum length of ${def.maxItemLength} characters.`,
            "warning",
          );
        } else {
          selected.add(trimmed);
        }
      }
      continue;
    }

    const toggledValue = labelToValue.get(choice);
    if (toggledValue !== undefined) {
      if (selected.has(toggledValue)) {
        selected.delete(toggledValue);
      } else {
        selected.add(toggledValue);
      }
    }
  }

  return undefined;
}

async function editStringField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: StringFieldDef<any>,
  currentValue: string,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<string | undefined> {
  while (!ctx.signal?.aborted) {
    const raw = def.multiline
      ? await ctx.ui.editor(def.label, currentValue)
      : await ctx.ui.input(
          def.label,
          def.placeholder ?? (currentValue.length > 0 ? currentValue : undefined),
          dialogOpts,
        );

    if (raw === undefined) {
      return undefined;
    }

    const validation = schema.validateField(key, raw);
    if (!validation.ok) {
      ctx.ui.notify(validation.error, "warning");
      continue;
    }
    return validation.value as string;
  }

  return undefined;
}

async function editNumberField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: NumberFieldDef<any>,
  currentValue: number,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<number | undefined> {
  const unitSuffix = def.unit ? ` (${def.unit})` : "";
  while (!ctx.signal?.aborted) {
    const raw = await ctx.ui.input(
      `${def.label}${unitSuffix} [current: ${currentValue}]`,
      def.placeholder ?? String(currentValue),
      dialogOpts,
    );

    if (raw === undefined) {
      return undefined;
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      ctx.ui.notify("Please enter a valid number.", "warning");
      continue;
    }

    const parsed = Number(trimmed);
    const validation = schema.validateField(key, parsed);
    if (!validation.ok) {
      ctx.ui.notify(validation.error, "warning");
      continue;
    }
    return validation.value as number;
  }

  return undefined;
}

async function editModelField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: ModelFieldDef<boolean, any>,
  currentValue: ModelSelection | null,
  dialogOpts: ExtensionUIDialogOptions | undefined,
  catalogOptions?: Pick<OpenSettingsDialogOptions<TFields>, "availableModels" | "scopedModels">,
): Promise<ModelSelection | null | undefined> {
  const rawAvailable =
    def.models !== undefined
      ? typeof def.models === "function"
        ? def.models()
        : def.models
      : catalogOptions?.availableModels !== undefined
        ? typeof catalogOptions.availableModels === "function"
          ? catalogOptions.availableModels()
          : catalogOptions.availableModels
        : typeof ctx.modelRegistry?.getAvailable === "function"
          ? ctx.modelRegistry.getAvailable()
          : [];

  const rawScoped =
    def.scopedModels !== undefined
      ? typeof def.scopedModels === "function"
        ? def.scopedModels()
        : def.scopedModels
      : catalogOptions?.scopedModels !== undefined
        ? typeof catalogOptions.scopedModels === "function"
          ? catalogOptions.scopedModels()
          : catalogOptions.scopedModels
        : Array.isArray(ctx.scopedModels)
          ? ctx.scopedModels
          : [];

  interface RpcModelEntry {
    readonly identity: string;
    readonly provider: string;
    readonly id: string;
    readonly name: string;
    readonly reasoning?: boolean;
    readonly thinkingLevelMap?: Partial<Record<ModelThinkingLevel, unknown | null>>;
    readonly scopedThinkingLevel?: ModelThinkingLevel;
    readonly unavailable?: boolean;
  }

  const scopedSet = new Set<string>();
  const scopedThinking = new Map<string, ModelThinkingLevel>();
  const scopedRawMap = new Map<string, ModelPickerEntry>();

  for (const entry of rawScoped) {
    const provider = stripControlChars(entry.model.provider, false).trim();
    const id = stripControlChars(entry.model.id, false).trim();
    const identity = provider && id ? formatModelIdentity({ provider, id }) : "";
    if (!parseModelIdentity(identity)) continue;
    if (!scopedSet.has(identity)) {
      scopedSet.add(identity);
      scopedRawMap.set(identity, entry.model);
    }
    if (entry.thinkingLevel !== undefined && !scopedThinking.has(identity)) {
      scopedThinking.set(identity, entry.thinkingLevel);
    }
  }

  const byIdentity = new Map<string, RpcModelEntry>();
  for (const entry of rawAvailable) {
    const provider = stripControlChars(entry.provider, false).trim();
    const id = stripControlChars(entry.id, false).trim();
    const identity = provider && id ? formatModelIdentity({ provider, id }) : "";
    if (!parseModelIdentity(identity) || byIdentity.has(identity)) continue;
    byIdentity.set(identity, {
      identity,
      provider,
      id,
      name: stripControlChars(entry.name ?? "", false).trim(),
      reasoning: entry.reasoning,
      thinkingLevelMap: entry.thinkingLevelMap,
      scopedThinkingLevel: scopedThinking.get(identity),
    });
  }

  const scopedList: RpcModelEntry[] = [];
  for (const identity of scopedSet) {
    const existing = byIdentity.get(identity);
    if (existing) {
      scopedList.push(existing);
    } else {
      const raw = scopedRawMap.get(identity);
      if (raw) {
        const parsed = parseModelIdentity(identity);
        if (parsed) {
          const fallback: RpcModelEntry = {
            identity,
            provider: parsed.provider,
            id: parsed.id,
            name: stripControlChars(raw.name ?? "", false).trim(),
            reasoning: raw.reasoning,
            thinkingLevelMap: raw.thinkingLevelMap,
            scopedThinkingLevel: scopedThinking.get(identity),
          };
          scopedList.push(fallback);
          byIdentity.set(identity, fallback);
        }
      }
    }
  }

  const allList = [...byIdentity.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id),
  );

  if (currentValue && !byIdentity.has(currentValue.model)) {
    const parsed = parseModelIdentity(currentValue.model);
    if (parsed) {
      allList.unshift({
        identity: currentValue.model,
        provider: parsed.provider,
        id: parsed.id,
        name: "unavailable",
        unavailable: true,
      });
    }
  }

  let scope: ModelPickerScope =
    def.defaultModelScope === "scoped" || def.defaultModelScope === "all"
      ? def.defaultModelScope
      : scopedList.length > 0
        ? "scoped"
        : "all";
  let query = "";

  while (!ctx.signal?.aborted) {
    const source = scope === "scoped" ? scopedList : allList;
    const filtered = query
      ? fuzzyFilter(
          source,
          query,
          (m) => `${m.provider} ${m.identity} ${m.provider} ${m.id}${m.name ? ` ${m.name}` : ""}`,
        )
      : source;

    const labelToAction = new Map<
      string,
      | { readonly kind: "toggleScope" }
      | { readonly kind: "filter" }
      | { readonly kind: "clearFilter" }
      | { readonly kind: "clearValue" }
      | { readonly kind: "model"; readonly model: RpcModelEntry }
    >();
    const options: string[] = [];

    const scopeToggleLabel =
      scope === "scoped"
        ? `Scope: Scoped (${scopedList.length}) — Switch to All (${allList.length})`
        : `Scope: All (${allList.length}) — Switch to Scoped (${scopedList.length})`;
    labelToAction.set(scopeToggleLabel, { kind: "toggleScope" });
    options.push(scopeToggleLabel);

    const filterLabel = query ? `Filter: "${query}" — Change search` : "Filter models by text...";
    labelToAction.set(filterLabel, { kind: "filter" });
    options.push(filterLabel);

    if (query) {
      const clearFilterLabel = "Clear search filter";
      labelToAction.set(clearFilterLabel, { kind: "clearFilter" });
      options.push(clearFilterLabel);
    }

    if (def.allowClear) {
      const clearValLabel = `${def.emptyLabel ?? "None"} — ${def.emptyDescription ?? "Clear model selection"}`;
      labelToAction.set(clearValLabel, { kind: "clearValue" });
      options.push(clearValLabel);
    }

    for (const model of filtered) {
      const currentBadge = currentValue?.model === model.identity ? " (current)" : "";
      const nameSuffix = model.name && model.name !== model.id ? ` — ${model.name}` : "";
      let itemLabel = `${model.identity}${nameSuffix}${currentBadge}`;
      if (labelToAction.has(itemLabel)) {
        itemLabel = `${itemLabel} [${model.provider}]`;
      }
      labelToAction.set(itemLabel, { kind: "model", model });
      options.push(itemLabel);
    }

    const choice = await ctx.ui.select(
      `${def.label} — Step 1/2: Select model (${scope === "scoped" ? "Scoped" : "All"})`,
      options,
      dialogOpts,
    );
    if (choice === undefined || ctx.signal?.aborted) {
      return undefined;
    }

    const picked = labelToAction.get(choice);
    if (!picked) continue;

    if (picked.kind === "toggleScope") {
      scope = scope === "scoped" ? "all" : "scoped";
      continue;
    }
    if (picked.kind === "filter") {
      const nextQuery = await ctx.ui.input("Filter models (provider, id, or name)", query, dialogOpts);
      if (nextQuery !== undefined) {
        query = nextQuery.trim();
      }
      continue;
    }
    if (picked.kind === "clearFilter") {
      query = "";
      continue;
    }
    if (picked.kind === "clearValue") {
      const validation = schema.validateField(key, null);
      if (!validation.ok) {
        ctx.ui.notify(validation.error, "warning");
        continue;
      }
      return null;
    }

    // Step 2: Pick thinking level for the chosen model
    const levels = getSupportedThinkingLevelsForModel(picked.model, def.thinkingLevels);
    const levelLabelToValue = new Map<string, ModelThinkingLevel>();
    const levelOptions: string[] = [];
    for (const level of levels) {
      const currentLevelMark =
        currentValue?.model === picked.model.identity && currentValue.thinkingLevel === level
          ? " (current)"
          : "";
      const scopedMark = picked.model.scopedThinkingLevel === level ? " · scoped" : "";
      const label = `${level} — ${MODEL_THINKING_LEVEL_DESCRIPTIONS[level]}${scopedMark}${currentLevelMark}`;
      levelLabelToValue.set(label, level);
      levelOptions.push(label);
    }
    const backLabel = "← Back to models";
    levelOptions.push(backLabel);

    const levelChoice = await ctx.ui.select(
      `${def.label} — Step 2/2: Thinking level for ${picked.model.identity}`,
      levelOptions,
      dialogOpts,
    );
    if (ctx.signal?.aborted) {
      return undefined;
    }
    if (levelChoice === undefined || levelChoice === backLabel) {
      continue;
    }

    const chosenLevel = levelLabelToValue.get(levelChoice);
    if (!chosenLevel) continue;

    const candidate: ModelSelection = {
      model: picked.model.identity,
      thinkingLevel: chosenLevel,
    };
    const validation = schema.validateField(key, candidate);
    if (!validation.ok) {
      ctx.ui.notify(validation.error, "warning");
      continue;
    }
    return validation.value as ModelSelection;
  }

  return undefined;
}

async function editCustomField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: CustomFieldDef<unknown, any>,
  currentValue: unknown,
  draft: Readonly<InferSettingsValues<TFields>>,
): Promise<unknown | undefined> {
  if (typeof def.rpcEdit !== "function") {
    ctx.ui.notify(`"${def.label}" requires interactive TUI mode to edit.`, "info");
    return undefined;
  }

  const nextValue = await def.rpcEdit(ctx, currentValue, draft);
  if (nextValue === undefined) {
    return undefined;
  }

  const validation = schema.validateField(key, nextValue);
  if (!validation.ok) {
    ctx.ui.notify(validation.error, "warning");
    return undefined;
  }

  return validation.value;
}

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
  const saveMode = options?.saveMode ?? schema.saveMode;
  const availableScopes = getAvailableScopes(schema, loaded.trustedProject);
  let scope = resolveInitialScope(schema, loaded.trustedProject);
  let currentLoaded = loaded;
  let draft = cloneValue(loaded.effective);
  let saved = false;

  const persistValues = async (
    nextValues: InferSettingsValues<TFields>,
  ): Promise<boolean> => {
    try {
      const saveResult = await store.save(nextValues, {
        scope,
        trustedProject: currentLoaded.trustedProject,
        expectedSnapshot: currentLoaded.snapshot,
      });
      currentLoaded = saveResult.loaded;
      draft = cloneValue(currentLoaded.effective);
      saved = true;
      await options?.onApply?.(currentLoaded.effective, {
        scope: saveResult.savedScope,
        provenance: currentLoaded.provenance,
        writtenKeys: saveResult.writtenKeys,
      });
      return true;
    } catch (err) {
      if (err instanceof ConcurrencyConflictError) {
        ctx.ui.notify(
          `Settings were modified externally in ${err.scope} scope. Reloaded latest values.`,
          "error",
        );
        currentLoaded = await store.load({ trustedProject: currentLoaded.trustedProject });
        draft = cloneValue(currentLoaded.effective);
        return false;
      }
      const message = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Failed to save settings: ${message}`, "error");
      return false;
    }
  };

  while (true) {
    if (ctx.signal?.aborted) {
      return {
        mode: "rpc",
        opened: true,
        saved,
        values: currentLoaded.effective,
        scope,
        paths: currentLoaded.paths,
        warnings: currentLoaded.warnings,
        closedBy: "abort",
      };
    }

    const dialogOpts = getDialogOpts(ctx.signal);
    const dirty = !deepEqual(draft, currentLoaded.effective);
    const visibleFields = collectVisibleFields(schema, draft);
    const menuItems: string[] = [];
    const itemToAction = new Map<string, RpcMenuAction<TFields>>();

    for (const entry of visibleFields) {
      const { key, def, tabLabel } = entry;
      const prefix = tabLabel ? `[${tabLabel}] ` : "";
      const formatted = schema.formatFieldValue(
        key,
        draft[key] as InferSettingsValues<TFields>[typeof key],
      );
      const provenance = formatProvenanceBadge(currentLoaded.provenance[key] ?? "default");
      const modifiedMark = saveMode === "draft" && !deepEqual(draft[key], currentLoaded.effective[key])
        ? " *"
        : "";
      const disabledMark = isFieldDisabled(def, draft) ? " [disabled]" : "";
      let itemText = `${prefix}${def.label}: ${formatted} ${provenance}${modifiedMark}${disabledMark}`;
      if (itemToAction.has(itemText)) {
        itemText = `${itemText} (${key})`;
      }
      itemToAction.set(itemText, { kind: "field", key, def });
      menuItems.push(itemText);
    }

    if (availableScopes.length > 1) {
      const scopeLabel = `Save scope: ${scope === "global" ? "Global" : "Project"}`;
      itemToAction.set(scopeLabel, { kind: "scope" });
      menuItems.push(scopeLabel);
    }

    const restoreLabel = "Restore defaults";
    itemToAction.set(restoreLabel, { kind: "restore" });
    menuItems.push(restoreLabel);

    if (saveMode === "draft") {
      const saveLabel = dirty ? "Save changes*" : "Save changes";
      const discardLabel = "Discard & close";
      itemToAction.set(saveLabel, { kind: "save" });
      itemToAction.set(discardLabel, { kind: "discard" });
      menuItems.push(saveLabel, discardLabel);
    } else {
      const doneLabel = "Done";
      itemToAction.set(doneLabel, { kind: "done" });
      menuItems.push(doneLabel);
    }

    const selected = await ctx.ui.select(schema.title, menuItems, dialogOpts);

    if (ctx.signal?.aborted) {
      return {
        mode: "rpc",
        opened: true,
        saved,
        values: currentLoaded.effective,
        scope,
        paths: currentLoaded.paths,
        warnings: currentLoaded.warnings,
        closedBy: "abort",
      };
    }

    if (selected === undefined) {
      if (saveMode === "draft" && dirty) {
        const confirmDiscard = await ctx.ui.confirm(
          "Discard unsaved changes?",
          "You have unsaved changes. Discard them and close?",
          dialogOpts,
        );
        if (ctx.signal?.aborted) {
          return {
            mode: "rpc",
            opened: true,
            saved,
            values: currentLoaded.effective,
            scope,
            paths: currentLoaded.paths,
            warnings: currentLoaded.warnings,
            closedBy: "abort",
          };
        }
        if (!confirmDiscard) {
          continue;
        }
      }
      return {
        mode: "rpc",
        opened: true,
        saved,
        values: currentLoaded.effective,
        scope,
        paths: currentLoaded.paths,
        warnings: currentLoaded.warnings,
        closedBy: "cancel",
      };
    }

    const action = itemToAction.get(selected);
    if (!action) {
      continue;
    }

    if (action.kind === "done") {
      return {
        mode: "rpc",
        opened: true,
        saved,
        values: currentLoaded.effective,
        scope,
        paths: currentLoaded.paths,
        warnings: currentLoaded.warnings,
        closedBy: "immediate",
      };
    }

    if (action.kind === "discard") {
      if (dirty) {
        const confirmDiscard = await ctx.ui.confirm(
          "Discard unsaved changes?",
          "You have unsaved changes. Discard them and close?",
          dialogOpts,
        );
        if (ctx.signal?.aborted) {
          return {
            mode: "rpc",
            opened: true,
            saved,
            values: currentLoaded.effective,
            scope,
            paths: currentLoaded.paths,
            warnings: currentLoaded.warnings,
            closedBy: "abort",
          };
        }
        if (!confirmDiscard) {
          continue;
        }
      }
      return {
        mode: "rpc",
        opened: true,
        saved,
        values: currentLoaded.effective,
        scope,
        paths: currentLoaded.paths,
        warnings: currentLoaded.warnings,
        closedBy: "cancel",
      };
    }

    if (action.kind === "save") {
      const ok = await persistValues(draft);
      if (ok) {
        return {
          mode: "rpc",
          opened: true,
          saved: true,
          values: currentLoaded.effective,
          scope,
          paths: currentLoaded.paths,
          warnings: currentLoaded.warnings,
          closedBy: "save",
        };
      }
      continue;
    }

    if (action.kind === "scope") {
      const currentIdx = availableScopes.indexOf(scope);
      const nextIdx = (currentIdx + 1) % availableScopes.length;
      scope = availableScopes[nextIdx] ?? scope;
      continue;
    }

    if (action.kind === "restore") {
      const confirmed = await ctx.ui.confirm(
        "Restore defaults",
        `Restore all settings in ${scope} scope to defaults?`,
        dialogOpts,
      );
      if (!confirmed) {
        continue;
      }

      if (saveMode === "immediate") {
        try {
          const restoreResult = await store.restoreDefaults({
            scope,
            trustedProject: currentLoaded.trustedProject,
            expectedSnapshot: currentLoaded.snapshot,
          });
          currentLoaded = restoreResult.loaded;
          draft = cloneValue(currentLoaded.effective);
          saved = true;
          await options?.onApply?.(currentLoaded.effective, {
            scope: restoreResult.savedScope,
            provenance: currentLoaded.provenance,
            writtenKeys: restoreResult.writtenKeys,
          });
          ctx.ui.notify(`Restored ${scope} settings to defaults.`, "info");
        } catch (err) {
          if (err instanceof ConcurrencyConflictError) {
            ctx.ui.notify(
              `Settings were modified externally in ${err.scope} scope. Reloaded latest values.`,
              "error",
            );
            currentLoaded = await store.load({ trustedProject: currentLoaded.trustedProject });
            draft = cloneValue(currentLoaded.effective);
          } else {
            const message = err instanceof Error ? err.message : String(err);
            ctx.ui.notify(`Failed to restore defaults: ${message}`, "error");
          }
        }
      } else {
        draft = schema.resolveEffective(
          {
            global: scope === "global" ? {} : currentLoaded.layers.global,
            project: scope === "project" ? {} : currentLoaded.layers.project,
          },
          { includeProject: currentLoaded.trustedProject },
        );
      }
      continue;
    }

    if (action.kind === "field") {
      const { key, def } = action;
      if (isFieldDisabled(def, draft)) {
        ctx.ui.notify(`"${def.label}" is currently disabled.`, "info");
        continue;
      }
      if (def.scopes && !def.scopes.includes(scope)) {
        ctx.ui.notify(
          `"${def.label}" cannot be configured in ${scope} scope.`,
          "warning",
        );
        continue;
      }

      const currentValue = draft[key];
      let nextValue: unknown = undefined;

      switch (def.kind) {
        case "boolean":
          nextValue = await editBooleanField(ctx, def, dialogOpts);
          break;
        case "enum":
          nextValue = await editEnumField(ctx, def, dialogOpts);
          break;
        case "multiSelect":
          nextValue = await editMultiSelectField(
            ctx,
            schema,
            key,
            def,
            Array.isArray(currentValue) ? (currentValue as string[]) : [],
            dialogOpts,
          );
          break;
        case "string":
          nextValue = await editStringField(
            ctx,
            schema,
            key,
            def,
            typeof currentValue === "string" ? currentValue : String(currentValue ?? ""),
            dialogOpts,
          );
          break;
        case "number":
          nextValue = await editNumberField(
            ctx,
            schema,
            key,
            def,
            typeof currentValue === "number" ? currentValue : Number(currentValue ?? 0),
            dialogOpts,
          );
          break;
        case "model":
          nextValue = await editModelField(
            ctx,
            schema,
            key,
            def,
            (currentValue as ModelSelection | null) ?? null,
            dialogOpts,
            options,
          );
          break;
        case "custom":
          nextValue = await editCustomField(ctx, schema, key, def, currentValue, draft);
          break;
      }

      if (nextValue === undefined || deepEqual(nextValue, currentValue)) {
        continue;
      }

      const nextDraft = {
        ...draft,
        [key]: nextValue,
      } as InferSettingsValues<TFields>;

      if (saveMode === "immediate") {
        await persistValues(nextDraft);
      } else {
        draft = nextDraft;
      }
    }
  }
}
