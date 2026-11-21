import type {
  AnyFieldDef,
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  PartialValidationResult,
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
import { cloneValue, deepEqual, validateFieldValue, validatePartialSettings } from "./validate.js";

const DEFAULT_TAB: TabDefinition = { id: "general", label: "General" };
const DEFAULT_SCOPES: readonly SettingsScope[] = ["global", "project"];
const MAX_FORMAT_STRING_LEN = 32;

function truncateDisplay(text: string, maxLen = MAX_FORMAT_STRING_LEN): string {
  if (text.length <= maxLen) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLen - 3))}...`;
}

function formatDefaultFieldValue(def: AnyFieldDef, value: unknown): string {
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

function getDefaultFieldTone(def: AnyFieldDef, value: unknown): ValueTone {
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

    case "number":
    case "custom":
      return "default";
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
  const settingsFile = config.settingsFile ?? config.storage?.settingsFile;
  const storage: StoragePathConfig =
    settingsFile !== undefined
      ? { ...(config.storage ?? {}), settingsFile }
      : (config.storage ?? {});
  const fieldKeys = Object.keys(config.fields) as (keyof TFields & string)[];

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
    defaultsRecord[key] = cloneValue(def.default);
  }

  const defaults = defaultsRecord as InferSettingsValues<TFields>;

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
    defaults,
    // Phantom type carrier for `typeof schema.Type`
    Type: defaults,

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

    validateField<K extends keyof TFields & string>(
      key: K,
      raw: unknown,
    ): ValidationResult<InferSettingsValues<TFields>[K]> {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return { ok: false, error: `Unknown field "${key}"` };
      }
      return validateFieldValue(config.fields[key]!, raw) as ValidationResult<
        InferSettingsValues<TFields>[K]
      >;
    },

    validatePartial(raw: unknown): PartialValidationResult<InferSettingsValues<TFields>> {
      return validatePartialSettings(config.fields, raw);
    },

    resolveEffective(
      layers: SettingsLayersData<InferSettingsValues<TFields>>,
      options?: { includeProject?: boolean },
    ): InferSettingsValues<TFields> {
      const includeProject = options?.includeProject ?? true;
      const result: Record<string, unknown> = {};

      for (const key of fieldKeys) {
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
        result[key] = cloneValue(value);
      }

      return result as InferSettingsValues<TFields>;
    },

    computeProvenance(
      layers: SettingsLayersData<InferSettingsValues<TFields>>,
      options?: { includeProject?: boolean },
    ): Record<keyof TFields & string, FieldProvenance> {
      const includeProject = options?.includeProject ?? true;
      const result: Record<string, FieldProvenance> = {};

      for (const key of fieldKeys) {
        const inGlobal =
          Object.prototype.hasOwnProperty.call(layers.global, key) &&
          layers.global[key] !== undefined;
        const inProject =
          includeProject &&
          Object.prototype.hasOwnProperty.call(layers.project, key) &&
          layers.project[key] !== undefined;

        if (inGlobal && inProject) {
          result[key] = "both";
        } else if (inGlobal) {
          result[key] = "global";
        } else if (inProject) {
          result[key] = "project";
        } else {
          result[key] = "default";
        }
      }

      return result as Record<keyof TFields & string, FieldProvenance>;
    },

    diffForScope(
      nextValues: InferSettingsValues<TFields>,
      scope: SettingsScope,
      existingLayers: SettingsLayersData<InferSettingsValues<TFields>>,
    ): Partial<InferSettingsValues<TFields>> {
      const diff: Record<string, unknown> = {};

      for (const key of fieldKeys) {
        const def = config.fields[key]!;
        if (def.scopes && !def.scopes.includes(scope)) {
          continue;
        }

        const nextVal = nextValues[key];
        if (scope === "global") {
          if (!deepEqual(nextVal, defaults[key])) {
            diff[key] = cloneValue(nextVal);
          }
        } else {
          const hasGlobal =
            Object.prototype.hasOwnProperty.call(existingLayers.global, key) &&
            existingLayers.global[key] !== undefined;
          const baseVal = hasGlobal ? existingLayers.global[key] : defaults[key];
          if (!deepEqual(nextVal, baseVal)) {
            diff[key] = cloneValue(nextVal);
          }
        }
      }

      return diff as Partial<InferSettingsValues<TFields>>;
    },

    formatFieldValue<K extends keyof TFields & string>(
      key: K,
      value: InferSettingsValues<TFields>[K],
    ): string {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return String(value ?? "");
      }
      const def = config.fields[key]!;
      if (def.format) {
        return (def.format as (v: unknown) => string)(value);
      }
      return formatDefaultFieldValue(def, value);
    },

    getFieldTone<K extends keyof TFields & string>(
      key: K,
      value: InferSettingsValues<TFields>[K],
    ): ValueTone {
      if (!Object.prototype.hasOwnProperty.call(config.fields, key)) {
        return "default";
      }
      const def = config.fields[key]!;
      if (def.tone !== undefined) {
        return typeof def.tone === "function"
          ? (def.tone as (v: unknown) => ValueTone)(value)
          : def.tone;
      }
      return getDefaultFieldTone(def, value);
    },
  };
}
