import type {
  AnyFieldDef,
  FieldEligibility,
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  PartialValidationResult,
  PersistedFieldDef,
  PersistedFieldKeys,
  ResolvedFieldEligibility,
  SaveMode,
  SettingsLayersData,
  SettingsSchema,
  SettingsSchemaConfig,
  SettingsScope,
  StoragePathConfig,
  TabDefinition,
  ValidationResult,
  ValueTone,
} from "./types.js";
import {
  cloneValue,
  deepEqual,
  isPersistedFieldDef,
  validateFieldValue,
  validatePartialSettings,
} from "./validate.js";

const DEFAULT_TAB: TabDefinition = { id: "general", label: "General" };
const DEFAULT_SCOPES: readonly SettingsScope[] = ["global", "project"];
const MAX_FORMAT_STRING_LEN = 32;

function truncateDisplay(text: string, maxLen = MAX_FORMAT_STRING_LEN): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDefaultFieldValue(def: PersistedFieldDef, value: unknown): string {
  switch (def.kind) {
    case "boolean": {
      return value ? (def.trueLabel ?? "On") : (def.falseLabel ?? "Off");
    }

    case "enum": {
      const opt = def.options.find((o) => o.value === value);
      return opt ? opt.label : String(value ?? "");
    }

    case "multiSelect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      if (arr.length === 0) {
        return def.emptyLabel ?? "None";
      }
      const optionLabels =
        typeof def.options !== "function"
          ? new Map(def.options.map((opt) => [opt.value, opt.label]))
          : null;
      const labels = arr.map((item) => optionLabels?.get(item) ?? item);
      if (labels.length <= 3) {
        const joined = labels.join(", ");
        if (joined.length <= MAX_FORMAT_STRING_LEN) {
          return joined;
        }
      }
      return `${arr.length} selected`;
    }

    case "number": {
      const numStr = typeof value === "number" ? String(value) : String(value ?? "");
      return def.unit ? `${numStr} ${def.unit}` : numStr;
    }

    case "string": {
      const str = typeof value === "string" ? value : String(value ?? "");
      if (str.length === 0) {
        return "(empty)";
      }
      const singleLine = str.replace(/[\r\n\t]+/g, " ");
      return `"${truncateDisplay(singleLine, MAX_FORMAT_STRING_LEN - 2)}"`;
    }

    case "model": {
      if (value === null || value === undefined) {
        return def.emptyLabel ?? "None";
      }
      if (typeof value === "string") {
        return value.length === 0 ? (def.emptyLabel ?? "None") : value;
      }
      if (
        typeof value === "object" &&
        "model" in value &&
        typeof (value as { model: unknown }).model === "string" &&
        "thinkingLevel" in value &&
        typeof (value as { thinkingLevel: unknown }).thinkingLevel === "string"
      ) {
        const sel = value as { model: string; thinkingLevel: string };
        return `${sel.model} (${sel.thinkingLevel})`;
      }
      return String(value);
    }

    case "picker": {
      const isEqual = def.equals ?? deepEqual;
      const clearVal = def.clearValue !== undefined ? def.clearValue : null;
      if (
        value === null ||
        value === undefined ||
        (def.allowClear && isEqual(value, clearVal))
      ) {
        return def.emptyLabel ?? "None";
      }
      if (typeof value === "string") {
        return value.length === 0 ? (def.emptyLabel ?? "None") : truncateDisplay(value);
      }
      if (Array.isArray(value)) {
        return value.length === 0 ? (def.emptyLabel ?? "None") : `${value.length} items`;
      }
      if (typeof value === "object") {
        try {
          return truncateDisplay(JSON.stringify(value));
        } catch {
          return "[object]";
        }
      }
      return String(value);
    }

    case "custom": {
      if (value === null || value === undefined) {
        return "(empty)";
      }
      if (typeof value === "string") {
        return value.length === 0 ? "(empty)" : `"${truncateDisplay(value, MAX_FORMAT_STRING_LEN - 2)}"`;
      }
      if (Array.isArray(value)) {
        return value.length === 0 ? "None" : `${value.length} items`;
      }
      if (typeof value === "object") {
        try {
          return truncateDisplay(JSON.stringify(value));
        } catch {
          return "[object]";
        }
      }
      return String(value);
    }
  }
}

function getDefaultFieldTone(def: PersistedFieldDef, value: unknown): ValueTone {
  switch (def.kind) {
    case "boolean":
      return value ? "success" : "muted";

    case "enum": {
      const opt = def.options.find((o) => o.value === value);
      return opt?.tone ?? "default";
    }

    case "multiSelect":
      return Array.isArray(value) && value.length > 0 ? "accent" : "muted";

    case "string":
      return typeof value === "string" && value.length === 0 ? "muted" : "default";

    case "model":
      return value === null || value === undefined ? "muted" : "accent";

    case "picker": {
      const isEqual = def.equals ?? deepEqual;
      const clearVal = def.clearValue !== undefined ? def.clearValue : null;
      if (
        value === null ||
        value === undefined ||
        value === "" ||
        (def.allowClear && isEqual(value, clearVal))
      ) {
        return "muted";
      }
      return "accent";
    }

    case "number":
    case "custom":
      return "default";
  }
}

export function parseFieldProvenance(provenance: FieldProvenance): {
  readonly global: boolean;
  readonly project: boolean;
  readonly session: boolean;
} {
  switch (provenance) {
    case "global":
      return { global: true, project: false, session: false };
    case "project":
      return { global: false, project: true, session: false };
    case "both":
      return { global: true, project: true, session: false };
    case "session":
      return { global: false, project: false, session: true };
    case "global+session":
      return { global: true, project: false, session: true };
    case "project+session":
      return { global: false, project: true, session: true };
    case "all":
      return { global: true, project: true, session: true };
    case "default":
    default:
      return { global: false, project: false, session: false };
  }
}

export function defineSettings<TFields extends FieldMap>(
  config: SettingsSchemaConfig<TFields>,
): SettingsSchema<TFields> {
  const hasExplicitTabs = Boolean(config.tabs && config.tabs.length > 0);
  const tabs: readonly TabDefinition[] = hasExplicitTabs ? [...config.tabs!] : [DEFAULT_TAB];

  const tabIds = new Set<string>();
  for (const tab of tabs) {
    if (tabIds.has(tab.id)) {
      throw new Error(`Duplicate tab id "${tab.id}" in settings schema "${config.id}"`);
    }
    tabIds.add(tab.id);
  }

  const scopes: readonly SettingsScope[] =
    config.scopes && config.scopes.length > 0 ? [...config.scopes] : DEFAULT_SCOPES;
  const defaultScope: SettingsScope = config.defaultScope ?? scopes[0]!;
  if (!scopes.includes(defaultScope)) {
    throw new Error(
      `defaultScope "${defaultScope}" is not included in scopes [${scopes.join(", ")}] for schema "${config.id}"`,
    );
  }

  const saveMode: SaveMode = config.saveMode ?? "draft";
  if (saveMode === "session-draft") {
    if (!scopes.includes("session")) {
      throw new Error(
        `saveMode "session-draft" requires "session" to be included in scopes for schema "${config.id}"`,
      );
    }
    if (!scopes.some((s) => s !== "session")) {
      throw new Error(
        `saveMode "session-draft" requires at least one persistent scope ("global" or "project") for schema "${config.id}"`,
      );
    }
  }
  const settingsFile = config.settingsFile ?? config.storage?.settingsFile;
  const storage: StoragePathConfig =
    settingsFile !== undefined
      ? { ...(config.storage ?? {}), settingsFile }
      : (config.storage ?? {});
  const fieldKeys = Object.keys(config.fields) as (keyof TFields & string)[];
  const persistedFieldKeys: PersistedFieldKeys<TFields>[] = [];

  const fieldTabMap = new Map<string, string>();
  const defaultTabId = tabs[0]!.id;
  const defaultsRecord: Record<string, unknown> = {};

  for (const key of fieldKeys) {
    const def = config.fields[key]!;
    const resolvedTab = def.tab ?? defaultTabId;
    if (!tabIds.has(resolvedTab)) {
      throw new Error(
        `Field "${key}" references unknown tab "${resolvedTab}" in schema "${config.id}". Valid tabs: ${tabs.map((t) => t.id).join(", ")}`,
      );
    }
    fieldTabMap.set(key, resolvedTab);
    if (isPersistedFieldDef(def)) {
      persistedFieldKeys.push(key as PersistedFieldKeys<TFields>);
      defaultsRecord[key] = cloneValue(def.default);
    }
  }

  const defaults = defaultsRecord as InferSettingsValues<TFields>;

  const isFieldAllowedInScope = <K extends keyof TFields & string>(
    key: K,
    scope: SettingsScope,
  ): boolean => {
    if (!scopes.includes(scope)) {
      return false;
    }
    if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
      return false;
    }
    const def = config.fields[key]!;
    return def.scopes ? def.scopes.includes(scope) : true;
  };

  return {
    config,
    id: config.id,
    title: config.title,
    description: config.description,
    version: config.version,
    tabs,
    hasExplicitTabs,
    scopes,
    defaultScope,
    saveMode,
    settingsFile,
    storage,
    fields: config.fields,
    fieldKeys,
    persistedFieldKeys,
    defaults,
    // Phantom type carrier for `typeof schema.Type`
    Type: defaults,
    ...(config.normalizeDraft ? { normalizeDraft: config.normalizeDraft } : {}),

    getDefaults(): InferSettingsValues<TFields> {
      return cloneValue(defaults);
    },

    getFieldsForTab(tabId: string): readonly { key: keyof TFields & string; def: AnyFieldDef }[] {
      const list: { key: keyof TFields & string; def: AnyFieldDef }[] = [];
      for (const key of fieldKeys) {
        if (fieldTabMap.get(key) === tabId) {
          list.push({ key, def: config.fields[key]! });
        }
      }
      return list;
    },

    isFieldAllowedInScope,

    validateField<K extends PersistedFieldKeys<TFields>>(
      key: K,
      raw: unknown,
    ): ValidationResult<InferSettingsValues<TFields>[K]> {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return { ok: false, error: `Unknown field "${key}"` };
      }
      const def = config.fields[key]!;
      if (!isPersistedFieldDef(def)) {
        return {
          ok: false,
          error: `Field "${key}" (kind "${def.kind}") is not persisted and cannot be validated`,
        };
      }
      return validateFieldValue(def, raw) as ValidationResult<
        InferSettingsValues<TFields>[K]
      >;
    },

    validatePartial(raw: unknown): PartialValidationResult<InferSettingsValues<TFields>> {
      return validatePartialSettings(config.fields, raw);
    },

    resolveEffective(
      layers: SettingsLayersData<InferSettingsValues<TFields>>,
      options?: { includeProject?: boolean; includeSession?: boolean },
    ): InferSettingsValues<TFields> {
      const includeProject = options?.includeProject ?? true;
      const includeSession = options?.includeSession ?? true;
      const sessionLayer = layers.session;
      const result: Record<string, unknown> = {};

      for (const key of persistedFieldKeys) {
        let value = defaults[key];
        if (
          Object.prototype.hasOwnProperty.call(layers.global, key) &&
          layers.global[key] !== undefined
        ) {
          value = layers.global[key] as InferSettingsValues<TFields>[typeof key];
        }
        if (
          includeProject &&
          Object.prototype.hasOwnProperty.call(layers.project, key) &&
          layers.project[key] !== undefined
        ) {
          value = layers.project[key] as InferSettingsValues<TFields>[typeof key];
        }
        if (
          includeSession &&
          sessionLayer &&
          Object.prototype.hasOwnProperty.call(sessionLayer, key) &&
          sessionLayer[key] !== undefined
        ) {
          value = sessionLayer[key] as InferSettingsValues<TFields>[typeof key];
        }
        result[key] = cloneValue(value);
      }

      return result as InferSettingsValues<TFields>;
    },

    computeProvenance(
      layers: SettingsLayersData<InferSettingsValues<TFields>>,
      options?: { includeProject?: boolean; includeSession?: boolean },
    ): Record<PersistedFieldKeys<TFields>, FieldProvenance> {
      const includeProject = options?.includeProject ?? true;
      const includeSession = options?.includeSession ?? true;
      const sessionLayer = layers.session;
      const result: Record<string, FieldProvenance> = {};

      for (const key of persistedFieldKeys) {
        const inGlobal =
          Object.prototype.hasOwnProperty.call(layers.global, key) &&
          layers.global[key] !== undefined;
        const inProject =
          includeProject &&
          Object.prototype.hasOwnProperty.call(layers.project, key) &&
          layers.project[key] !== undefined;
        const inSession =
          includeSession &&
          Boolean(
            sessionLayer &&
              Object.prototype.hasOwnProperty.call(sessionLayer, key) &&
              sessionLayer[key] !== undefined,
          );

        if (inGlobal && inProject && inSession) {
          result[key] = "all";
        } else if (inProject && inSession) {
          result[key] = "project+session";
        } else if (inGlobal && inSession) {
          result[key] = "global+session";
        } else if (inSession) {
          result[key] = "session";
        } else if (inGlobal && inProject) {
          result[key] = "both";
        } else if (inGlobal) {
          result[key] = "global";
        } else if (inProject) {
          result[key] = "project";
        } else {
          result[key] = "default";
        }
      }

      return result as Record<PersistedFieldKeys<TFields>, FieldProvenance>;
    },

    diffForScope(
      nextValues: InferSettingsValues<TFields>,
      scope: SettingsScope,
      existingLayers: SettingsLayersData<InferSettingsValues<TFields>>,
    ): Partial<InferSettingsValues<TFields>> {
      const diff: Record<string, unknown> = {};

      for (const key of persistedFieldKeys) {
        if (!isFieldAllowedInScope(key, scope)) {
          continue;
        }
        const def = config.fields[key]!;
        const isEqual = def.kind === "picker" && def.equals ? def.equals : deepEqual;

        const nextVal = nextValues[key];
        if (scope === "global") {
          if (!isEqual(nextVal, defaults[key])) {
            diff[key] = cloneValue(nextVal);
          }
        } else if (scope === "project") {
          const hasGlobal =
            Object.prototype.hasOwnProperty.call(existingLayers.global, key) &&
            existingLayers.global[key] !== undefined;
          const baseVal = hasGlobal ? existingLayers.global[key] : defaults[key];
          if (!isEqual(nextVal, baseVal)) {
            diff[key] = cloneValue(nextVal);
          }
        } else {
          const hasProject =
            Object.prototype.hasOwnProperty.call(existingLayers.project, key) &&
            existingLayers.project[key] !== undefined;
          const hasGlobal =
            Object.prototype.hasOwnProperty.call(existingLayers.global, key) &&
            existingLayers.global[key] !== undefined;
          const baseVal = hasProject
            ? existingLayers.project[key]
            : hasGlobal
              ? existingLayers.global[key]
              : defaults[key];
          if (!isEqual(nextVal, baseVal)) {
            diff[key] = cloneValue(nextVal);
          }
        }
      }

      return diff as Partial<InferSettingsValues<TFields>>;
    },

    getFieldLabel<K extends keyof TFields & string>(
      key: K,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): string {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return key;
      }
      const def = config.fields[key]!;
      const resolvedValues = values ?? defaults;
      return typeof def.label === "function"
        ? (def.label as (vals: Readonly<Record<string, unknown>>) => string)(resolvedValues)
        : def.label;
    },

    getFieldDescription<K extends keyof TFields & string>(
      key: K,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): string | undefined {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return undefined;
      }
      const def = config.fields[key]!;
      const resolvedValues = values ?? defaults;
      if (typeof def.description === "function") {
        return (def.description as (vals: Readonly<Record<string, unknown>>) => string)(
          resolvedValues,
        );
      }
      if (typeof def.description === "string") {
        return def.description;
      }
      if (def.kind === "enum") {
        const currentValue = (resolvedValues as Record<string, unknown>)[key];
        const opt = def.options.find((o) => o.value === currentValue);
        return opt?.description;
      }
      return undefined;
    },

    getFieldEligibility<K extends keyof TFields & string>(
      key: K,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): ResolvedFieldEligibility {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return { eligible: false };
      }
      const def = config.fields[key]!;
      const resolvedValues = values ?? defaults;

      if (def.eligible !== undefined) {
        const rawEligible =
          typeof def.eligible === "function"
            ? (def.eligible as (vals: Readonly<Record<string, unknown>>) => FieldEligibility)(
                resolvedValues,
              )
            : def.eligible;
        if (typeof rawEligible === "boolean") {
          if (!rawEligible) {
            return { eligible: false };
          }
        } else if (!rawEligible.eligible) {
          return rawEligible.reason !== undefined && rawEligible.reason.length > 0
            ? { eligible: false, reason: rawEligible.reason }
            : { eligible: false };
        }
      }

      if (def.disabled !== undefined) {
        const rawDisabled =
          typeof def.disabled === "function"
            ? (def.disabled as (vals: Readonly<Record<string, unknown>>) => boolean | string)(
                resolvedValues,
              )
            : def.disabled;
        if (typeof rawDisabled === "string" && rawDisabled.length > 0) {
          return { eligible: false, reason: rawDisabled };
        }
      }

      return { eligible: true };
    },

    isFieldHardDisabled<K extends keyof TFields & string>(
      key: K,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): boolean {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return false;
      }
      const def = config.fields[key]!;
      if (def.disabled === undefined) {
        return false;
      }
      const resolvedValues = values ?? defaults;
      const rawDisabled =
        typeof def.disabled === "function"
          ? (def.disabled as (vals: Readonly<Record<string, unknown>>) => boolean | string)(
              resolvedValues,
            )
          : def.disabled;
      return rawDisabled === true;
    },

    formatFieldValue<K extends keyof TFields & string>(
      key: K,
      value: K extends PersistedFieldKeys<TFields> ? InferSettingsValues<TFields>[K] : unknown,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): string {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return String(value ?? "");
      }
      const def = config.fields[key]!;
      const resolvedValues = values ?? defaults;
      if (def.kind === "view") {
        if (def.value !== undefined) {
          return typeof def.value === "function"
            ? (def.value as (vals: Readonly<Record<string, unknown>>) => string)(resolvedValues)
            : def.value;
        }
        return "";
      }
      if (def.kind === "external") {
        return typeof def.summary === "string" ? def.summary : "";
      }
      if (def.format) {
        return (def.format as (v: unknown, vals?: unknown) => string)(value, values);
      }
      return formatDefaultFieldValue(def, value);
    },

    getFieldTone<K extends keyof TFields & string>(
      key: K,
      value: K extends PersistedFieldKeys<TFields> ? InferSettingsValues<TFields>[K] : unknown,
      values?: Readonly<InferSettingsValues<TFields>>,
    ): ValueTone {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return "default";
      }
      const def = config.fields[key]!;
      const resolvedValues = values ?? defaults;
      if (!isPersistedFieldDef(def)) {
        if (def.tone !== undefined) {
          return typeof def.tone === "function"
            ? (def.tone as (vals: Readonly<Record<string, unknown>>) => ValueTone)(resolvedValues)
            : def.tone;
        }
        return def.kind === "view" ? "muted" : "default";
      }
      if (def.tone !== undefined) {
        return typeof def.tone === "function"
          ? (def.tone as (v: unknown, vals?: unknown) => ValueTone)(value, values)
          : def.tone;
      }
      return getDefaultFieldTone(def, value);
    },
  };
}
