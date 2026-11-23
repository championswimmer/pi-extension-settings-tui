import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import {
  cloneValue,
  deepEqual,
  formatModelIdentity,
  getSupportedThinkingLevelsForModel,
  isPersistedFieldDef,
  MODEL_THINKING_LEVEL_DESCRIPTIONS,
  parseModelIdentity,
  stripControlChars,
  type AnyFieldDef,
  type BooleanFieldDef,
  type CustomFieldDef,
  type DynamicPickerOption,
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
  type PersistedFieldKeys,
  type PickerFieldDef,
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

const WORD_BOUNDARY_RE = /[\s\-_./:]/;

interface FuzzyMatchResult {
  readonly matches: boolean;
  readonly score: number;
}

function scorePositions(textLower: string, positions: readonly number[]): number {
  let score = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;

  for (const i of positions) {
    if (lastMatchIndex === i - 1) {
      consecutiveMatches++;
      score -= consecutiveMatches * 5;
    } else {
      consecutiveMatches = 0;
      if (lastMatchIndex >= 0) {
        score += (i - lastMatchIndex - 1) * 2;
      }
    }

    if (i === 0 || WORD_BOUNDARY_RE.test(textLower[i - 1]!)) {
      score -= 10;
    }

    score += i * 0.1;
    lastMatchIndex = i;
  }

  return score;
}

function matchFuzzyToken(normalizedQuery: string, textLower: string): FuzzyMatchResult {
  if (normalizedQuery.length === 0) {
    return { matches: true, score: 0 };
  }
  if (normalizedQuery.length > textLower.length) {
    return { matches: false, score: 0 };
  }

  const positions: number[] = [];
  let lastMatchIndex = -1;
  for (let queryIndex = 0; queryIndex < normalizedQuery.length; queryIndex++) {
    const i = textLower.indexOf(normalizedQuery[queryIndex]!, lastMatchIndex + 1);
    if (i === -1) {
      return { matches: false, score: 0 };
    }
    positions.push(i);
    lastMatchIndex = i;
  }

  let score = scorePositions(textLower, positions);

  for (
    let start = textLower.indexOf(normalizedQuery);
    start !== -1;
    start = textLower.indexOf(normalizedQuery, start + 1)
  ) {
    for (let k = 0; k < positions.length; k++) {
      positions[k] = start + k;
    }
    score = Math.min(score, scorePositions(textLower, positions));
  }

  if (normalizedQuery === textLower) {
    score -= 100;
  }

  return { matches: true, score };
}

function fuzzyMatch(query: string, text: string): FuzzyMatchResult {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  const primary = matchFuzzyToken(queryLower, textLower);
  if (primary.matches) {
    return primary;
  }

  const alphaNumeric = queryLower.match(/^(?<letters>[a-z]+)(?<digits>[0-9]+)$/);
  const numericAlpha = queryLower.match(/^(?<digits>[0-9]+)(?<letters>[a-z]+)$/);
  const swappedQuery = alphaNumeric
    ? `${alphaNumeric.groups?.digits ?? ""}${alphaNumeric.groups?.letters ?? ""}`
    : numericAlpha
      ? `${numericAlpha.groups?.letters ?? ""}${numericAlpha.groups?.digits ?? ""}`
      : "";

  if (!swappedQuery) {
    return primary;
  }

  const swapped = matchFuzzyToken(swappedQuery, textLower);
  return swapped.matches ? { matches: true, score: swapped.score + 5 } : primary;
}

function fuzzyFilter<T>(items: readonly T[], query: string, getText: (item: T) => string): T[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [...items];
  }

  const tokens = trimmed.split(/[\s/]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return [...items];
  }

  const results: Array<{ readonly item: T; readonly totalScore: number }> = [];
  for (const item of items) {
    const text = getText(item);
    let totalScore = 0;
    let allMatch = true;

    for (const token of tokens) {
      const match = fuzzyMatch(token, text);
      if (match.matches) {
        totalScore += match.score;
      } else {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      results.push({ item, totalScore });
    }
  }

  results.sort((a, b) => a.totalScore - b.totalScore);
  return results.map((r) => r.item);
}

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

function getScopeRestrictionInfo<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  key: keyof TFields & string,
  def: AnyFieldDef,
  scope: SettingsScope,
  trustedProject: boolean,
  label: string,
): { readonly tag: string; readonly reason: string } | undefined {
  if (schema.isFieldAllowedInScope(key, scope)) {
    return undefined;
  }
  const allowedScopes = (def.scopes ?? schema.scopes).filter((s) => schema.scopes.includes(s));
  if (allowedScopes.length === 1 && allowedScopes[0] === "global") {
    return {
      tag: "[Global only]",
      reason: "Global-only setting. Switch Save scope to Global to edit.",
    };
  }
  if (allowedScopes.length === 1 && allowedScopes[0] === "project") {
    return {
      tag: "[Project only]",
      reason: trustedProject
        ? "Project-only setting. Switch Save scope to Project to edit."
        : "Project-only setting. This project is not trusted, so Project scope is locked.",
    };
  }
  return {
    tag: "[Unavailable]",
    reason: `"${label}" cannot be configured in ${scope} scope.`,
  };
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
  label: string,
  def: BooleanFieldDef<any>,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<boolean | undefined> {
  const trueLabel = def.trueLabel ?? "Enabled";
  const falseLabel = def.falseLabel ?? "Disabled";
  const choice = await ctx.ui.select(label, [trueLabel, falseLabel], dialogOpts);
  if (choice === undefined) {
    return undefined;
  }
  return choice === trueLabel;
}

async function editEnumField(
  ctx: ExtensionContext,
  label: string,
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

  const choice = await ctx.ui.select(label, labels, dialogOpts);
  if (choice === undefined) {
    return undefined;
  }
  return labelToValue.get(choice);
}

async function editMultiSelectField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: PersistedFieldKeys<TFields>,
  label: string,
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
      `${label} (${selected.size} selected)`,
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
        `${label}: enter custom value`,
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
  key: PersistedFieldKeys<TFields>,
  label: string,
  def: StringFieldDef<any>,
  currentValue: string,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<string | undefined> {
  while (!ctx.signal?.aborted) {
    const raw = def.multiline
      ? await ctx.ui.editor(label, currentValue)
      : await ctx.ui.input(
          label,
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
  key: PersistedFieldKeys<TFields>,
  label: string,
  def: NumberFieldDef<any>,
  currentValue: number,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<number | undefined> {
  const unitSuffix = def.unit ? ` (${def.unit})` : "";
  while (!ctx.signal?.aborted) {
    const raw = await ctx.ui.input(
      `${label}${unitSuffix} [current: ${currentValue}]`,
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
  key: PersistedFieldKeys<TFields>,
  label: string,
  def: ModelFieldDef<boolean, any, boolean>,
  currentValue: ModelSelection | string | null,
  dialogOpts: ExtensionUIDialogOptions | undefined,
  catalogOptions?: Pick<OpenSettingsDialogOptions<TFields>, "availableModels" | "scopedModels">,
): Promise<ModelSelection | string | null | undefined> {
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

  const currentIdentity = typeof currentValue === "string" ? currentValue : currentValue?.model;
  if (currentIdentity && !byIdentity.has(currentIdentity)) {
    const parsed = parseModelIdentity(currentIdentity);
    if (parsed) {
      allList.unshift({
        identity: currentIdentity,
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
      const currentBadge = currentIdentity === model.identity ? " (current)" : "";
      const nameSuffix = model.name && model.name !== model.id ? ` — ${model.name}` : "";
      let itemLabel = `${model.identity}${nameSuffix}${currentBadge}`;
      if (labelToAction.has(itemLabel)) {
        itemLabel = `${itemLabel} [${model.provider}]`;
      }
      labelToAction.set(itemLabel, { kind: "model", model });
      options.push(itemLabel);
    }

    const stepPrefix = def.includeThinking === false ? "" : "Step 1/2: ";
    const choice = await ctx.ui.select(
      `${label} — ${stepPrefix}Select model (${scope === "scoped" ? "Scoped" : "All"})`,
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

    if (def.includeThinking === false) {
      const validation = schema.validateField(key, picked.model.identity);
      if (!validation.ok) {
        ctx.ui.notify(validation.error, "warning");
        continue;
      }
      return validation.value as string;
    }

    // Step 2: Pick thinking level for the chosen model
    const levels = getSupportedThinkingLevelsForModel(picked.model, def.thinkingLevels);
    const levelLabelToValue = new Map<string, ModelThinkingLevel>();
    const levelOptions: string[] = [];
    for (const level of levels) {
      const currentLevelMark =
        typeof currentValue === "object" &&
        currentValue !== null &&
        currentValue.model === picked.model.identity &&
        currentValue.thinkingLevel === level
          ? " (current)"
          : "";
      const scopedMark = picked.model.scopedThinkingLevel === level ? " · scoped" : "";
      const levelLabel = `${level} — ${MODEL_THINKING_LEVEL_DESCRIPTIONS[level]}${scopedMark}${currentLevelMark}`;
      levelLabelToValue.set(levelLabel, level);
      levelOptions.push(levelLabel);
    }
    const backLabel = "← Back to models";
    levelOptions.push(backLabel);

    const levelChoice = await ctx.ui.select(
      `${label} — Step 2/2: Thinking level for ${picked.model.identity}`,
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

async function editPickerField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: PersistedFieldKeys<TFields>,
  label: string,
  def: PickerFieldDef<unknown, any>,
  currentValue: unknown,
  draft: Readonly<InferSettingsValues<TFields>>,
  scope: SettingsScope,
  dialogOpts: ExtensionUIDialogOptions | undefined,
): Promise<{ readonly selected: true; readonly value: unknown } | undefined> {
  const isEqual = def.equals ?? deepEqual;
  const clearVal = def.clearValue !== undefined ? def.clearValue : null;
  const searchable = def.searchable !== false;
  const refreshable = def.refreshable !== false;

  const loadAll = async (): Promise<readonly DynamicPickerOption<unknown>[]> => {
    const signal = ctx.signal ?? new AbortController().signal;
    try {
      return await def.loadOptions({ draft: cloneValue(draft), scope, signal });
    } catch (err) {
      if (!ctx.signal?.aborted) {
        ctx.ui.notify(
          `Failed to load options for "${label}": ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
      return [];
    }
  };

  let allOptions = await loadAll();
  let query = "";

  while (!ctx.signal?.aborted) {
    const filtered = query
      ? fuzzyFilter(
          [...allOptions],
          query,
          (opt) => `${opt.label} ${opt.group ?? ""} ${opt.badge ?? ""} ${opt.description ?? ""} ${opt.id}`,
        )
      : [...allOptions];

    const labelToAction = new Map<
      string,
      | { readonly kind: "filter" }
      | { readonly kind: "clearFilter" }
      | { readonly kind: "refresh" }
      | { readonly kind: "clearValue" }
      | { readonly kind: "option"; readonly option: DynamicPickerOption<unknown> }
    >();
    const options: string[] = [];

    if (searchable) {
      const filterLabel = query
        ? `Filter: "${query}" — Change search`
        : "Filter options by text...";
      labelToAction.set(filterLabel, { kind: "filter" });
      options.push(filterLabel);

      if (query) {
        const clearFilterLabel = "Clear search filter";
        labelToAction.set(clearFilterLabel, { kind: "clearFilter" });
        options.push(clearFilterLabel);
      }
    }

    if (refreshable) {
      const refreshLabel = "Refresh options";
      labelToAction.set(refreshLabel, { kind: "refresh" });
      options.push(refreshLabel);
    }

    if (def.allowClear) {
      const clearValLabel = `${def.emptyLabel ?? "None"} — ${def.emptyDescription ?? "Clear selection"}`;
      labelToAction.set(clearValLabel, { kind: "clearValue" });
      options.push(clearValLabel);
    }

    for (const opt of filtered) {
      const groupPrefix = opt.group ? `[${opt.group}] ` : "";
      const badgeSuffix = opt.badge ? ` [${opt.badge}]` : "";
      const descSuffix = opt.description ? ` — ${opt.description}` : "";
      const currentBadge = isEqual(opt.value, currentValue) ? " (current)" : "";
      const disabledBadge = opt.disabled || opt.disabledReason ? " [disabled]" : "";
      let itemLabel = `${groupPrefix}${opt.label}${badgeSuffix}${descSuffix}${currentBadge}${disabledBadge}`;
      if (labelToAction.has(itemLabel)) {
        itemLabel = `${itemLabel} (${opt.id})`;
      }
      labelToAction.set(itemLabel, { kind: "option", option: opt });
      options.push(itemLabel);
    }

    const choice = await ctx.ui.select(label, options, dialogOpts);
    if (choice === undefined || ctx.signal?.aborted) {
      return undefined;
    }

    const picked = labelToAction.get(choice);
    if (!picked) continue;

    if (picked.kind === "filter") {
      const nextQuery = await ctx.ui.input("Filter options", query, dialogOpts);
      if (nextQuery !== undefined) {
        query = nextQuery.trim();
      }
      continue;
    }

    if (picked.kind === "clearFilter") {
      query = "";
      continue;
    }

    if (picked.kind === "refresh") {
      allOptions = await loadAll();
      continue;
    }

    if (picked.kind === "clearValue") {
      const validation = schema.validateField(key, clearVal);
      if (!validation.ok) {
        ctx.ui.notify(validation.error, "warning");
        continue;
      }
      return { selected: true, value: validation.value };
    }

    const opt = picked.option;
    if (opt.disabled || opt.disabledReason) {
      ctx.ui.notify(opt.disabledReason || "Option unavailable", "warning");
      continue;
    }

    if (def.validateSelection) {
      const signal = ctx.signal ?? new AbortController().signal;
      try {
        const outcome = await def.validateSelection(opt, {
          draft: cloneValue(draft),
          scope,
          signal,
        });
        if (ctx.signal?.aborted) {
          return undefined;
        }
        if (outcome !== true && outcome !== "") {
          ctx.ui.notify(
            typeof outcome === "string" ? outcome : "Selection is invalid.",
            "warning",
          );
          continue;
        }
      } catch (err) {
        if (ctx.signal?.aborted) {
          return undefined;
        }
        ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
        continue;
      }
    }

    const validation = schema.validateField(key, opt.value);
    if (!validation.ok) {
      ctx.ui.notify(validation.error, "warning");
      continue;
    }
    return { selected: true, value: validation.value };
  }

  return undefined;
}

async function editCustomField<TFields extends FieldMap>(
  ctx: ExtensionContext,
  schema: SettingsSchema<TFields>,
  key: PersistedFieldKeys<TFields>,
  label: string,
  def: CustomFieldDef<unknown, any>,
  currentValue: unknown,
  draft: Readonly<InferSettingsValues<TFields>>,
): Promise<unknown | undefined> {
  if (typeof def.rpcEdit !== "function") {
    ctx.ui.notify(`"${label}" requires interactive TUI mode to edit.`, "info");
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
      const fieldLabel = schema.getFieldLabel(key, draft);
      const hardDisabled = schema.isFieldHardDisabled(key, draft);
      const eligibility = schema.getFieldEligibility(key, draft);
      const scopeInfo = getScopeRestrictionInfo(
        schema,
        key,
        def,
        scope,
        currentLoaded.trustedProject,
        fieldLabel,
      );
      const statusMark = hardDisabled
        ? " [disabled]"
        : scopeInfo
          ? ` ${scopeInfo.tag}`
          : !eligibility.eligible
            ? " [unavailable]"
            : "";

      let itemText: string;
      if (isPersistedFieldDef(def)) {
        const persistedKey = key as PersistedFieldKeys<TFields>;
        const formatted = schema.formatFieldValue(
          persistedKey,
          draft[persistedKey] as never,
          draft,
        );
        const provenance = formatProvenanceBadge(
          currentLoaded.provenance[persistedKey] ?? "default",
        );
        const isEqual = def.kind === "picker" && def.equals ? def.equals : deepEqual;
        const modifiedMark =
          saveMode === "draft" && !isEqual(draft[persistedKey], currentLoaded.effective[persistedKey])
            ? " *"
            : "";
        itemText = `${prefix}${fieldLabel}: ${formatted} ${provenance}${modifiedMark}${statusMark}`;
      } else if (def.kind === "view") {
        const rawFormatted = schema.formatFieldValue(key, undefined as never, draft);
        const formatted = def.value !== undefined ? rawFormatted : "View";
        itemText = `${prefix}${fieldLabel}: ${formatted}${statusMark}`;
      } else {
        let formatted: string;
        if (typeof def.summary === "function") {
          try {
            const summaryRes = await def.summary({
              draft: cloneValue(draft),
              scope,
              signal: ctx.signal ?? new AbortController().signal,
            });
            formatted = typeof summaryRes === "string" ? summaryRes : summaryRes.text;
          } catch {
            formatted = "Open";
          }
        } else {
          formatted = def.summary ?? "Open";
        }
        itemText = `${prefix}${fieldLabel}: ${formatted}${statusMark}`;
      }

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
      const fieldLabel = schema.getFieldLabel(key, draft);
      if (schema.isFieldHardDisabled(key, draft)) {
        ctx.ui.notify(`"${fieldLabel}" is currently disabled.`, "info");
        continue;
      }
      const scopeInfo = getScopeRestrictionInfo(
        schema,
        key,
        def,
        scope,
        currentLoaded.trustedProject,
        fieldLabel,
      );
      if (scopeInfo) {
        ctx.ui.notify(scopeInfo.reason, "warning");
        continue;
      }
      const eligibility = schema.getFieldEligibility(key, draft);
      if (!eligibility.eligible) {
        ctx.ui.notify(
          eligibility.reason ?? `"${fieldLabel}" is currently unavailable.`,
          "warning",
        );
        continue;
      }

      if (def.kind === "view") {
        const signal = ctx.signal ?? new AbortController().signal;
        try {
          const rawText =
            typeof def.content === "function"
              ? await def.content({ draft: cloneValue(draft), scope, signal })
              : def.content;
          if (!ctx.signal?.aborted) {
            const clean = stripControlChars(String(rawText ?? ""), true);
            ctx.ui.notify(clean.length > 0 ? clean : `${fieldLabel}: (empty)`, "info");
          }
        } catch (err) {
          if (!ctx.signal?.aborted) {
            ctx.ui.notify(
              `Failed to load "${fieldLabel}": ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        }
        continue;
      }

      if (def.kind === "external") {
        if (typeof def.rpcRun === "function") {
          try {
            await def.rpcRun(ctx, cloneValue(draft), scope);
          } catch (err) {
            if (!ctx.signal?.aborted) {
              ctx.ui.notify(
                `Failed to run "${fieldLabel}": ${err instanceof Error ? err.message : String(err)}`,
                "error",
              );
            }
          }
        } else {
          ctx.ui.notify(`${fieldLabel} requires interactive TUI mode.`, "info");
        }
        continue;
      }

      const persistedKey = key as PersistedFieldKeys<TFields>;
      const currentValue = draft[persistedKey];
      let hasNextValue = false;
      let nextValue: unknown = undefined;

      switch (def.kind) {
        case "boolean": {
          const edited = await editBooleanField(ctx, fieldLabel, def, dialogOpts);
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "enum": {
          const edited = await editEnumField(ctx, fieldLabel, def, dialogOpts);
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "multiSelect": {
          const edited = await editMultiSelectField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            Array.isArray(currentValue) ? (currentValue as string[]) : [],
            dialogOpts,
          );
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "string": {
          const edited = await editStringField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            typeof currentValue === "string" ? currentValue : String(currentValue ?? ""),
            dialogOpts,
          );
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "number": {
          const edited = await editNumberField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            typeof currentValue === "number" ? currentValue : Number(currentValue ?? 0),
            dialogOpts,
          );
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "model": {
          const edited = await editModelField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            (currentValue as ModelSelection | string | null) ?? null,
            dialogOpts,
            options,
          );
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
        case "picker": {
          const edited = await editPickerField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            currentValue,
            draft,
            scope,
            dialogOpts,
          );
          if (edited?.selected) {
            hasNextValue = true;
            nextValue = edited.value;
          }
          break;
        }
        case "custom": {
          const edited = await editCustomField(
            ctx,
            schema,
            persistedKey,
            fieldLabel,
            def,
            currentValue,
            draft,
          );
          if (edited !== undefined) {
            hasNextValue = true;
            nextValue = edited;
          }
          break;
        }
      }

      const isEqual = def.kind === "picker" && def.equals ? def.equals : deepEqual;
      if (!hasNextValue || isEqual(nextValue, currentValue)) {
        continue;
      }

      const prevDraft = draft;
      let nextDraft = {
        ...prevDraft,
        [persistedKey]: nextValue,
      } as InferSettingsValues<TFields>;

      if (schema.normalizeDraft) {
        try {
          const normalized = schema.normalizeDraft(
            cloneValue(nextDraft),
            persistedKey,
            cloneValue(prevDraft),
          );
          let validationError: string | undefined;
          for (const k of schema.persistedFieldKeys) {
            if (!deepEqual(normalized[k], nextDraft[k])) {
              const recheck = schema.validateField(k, normalized[k]);
              if (!recheck.ok) {
                validationError = `${schema.getFieldLabel(k, normalized)}: ${recheck.error}`;
                break;
              }
              normalized[k] = recheck.value;
            }
          }
          if (validationError) {
            ctx.ui.notify(validationError, "warning");
            continue;
          }
          nextDraft = normalized;
        } catch (err) {
          ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
          continue;
        }
      }

      if (saveMode === "immediate") {
        await persistValues(nextDraft);
      } else {
        draft = nextDraft;
      }
    }
  }
}
