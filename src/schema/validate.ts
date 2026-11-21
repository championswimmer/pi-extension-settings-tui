import {
  MODEL_THINKING_LEVELS,
  type AnyFieldDef,
  type FieldMap,
  type InferSettingsValues,
  type ModelPickerEntry,
  type ModelThinkingLevel,
  type PartialValidationResult,
  type ValidationResult,
  type ValidationWarning,
} from "./types.js";

export const SECRET_KEY_PATTERN = /api.?key|token|secret|password|authorization|credential/i;

const MODEL_IDENTITY_RE = /^[^\s/]+\/[^\s]+$/;

const MODEL_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(MODEL_THINKING_LEVELS);

/** Human-readable descriptions for each Pi thinking level. */
export const MODEL_THINKING_LEVEL_DESCRIPTIONS: Readonly<Record<ModelThinkingLevel, string>> = {
  off: "No reasoning",
  minimal: "Very brief reasoning (~1k tokens)",
  low: "Light reasoning (~2k tokens)",
  medium: "Moderate reasoning (~8k tokens)",
  high: "Deep reasoning (~16k tokens)",
  xhigh: "Extra-high reasoning (~32k tokens)",
  max: "Maximum reasoning",
};

/** Checks whether a value is a valid Pi thinking level string. */
export function isValidModelThinkingLevel(value: unknown): value is ModelThinkingLevel {
  return typeof value === "string" && MODEL_THINKING_LEVEL_SET.has(value);
}

/** Formats `{ provider, id }` into a canonical `provider/model-id` identity string. */
export function formatModelIdentity(model: Pick<ModelPickerEntry, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Parses a `provider/model-id` identity string into `{ provider, id }`.
 * Splits on the first `/` so model IDs containing slashes (e.g. OpenRouter) stay intact.
 * Returns `null` when the string is not a valid `provider/model-id`.
 */
export function parseModelIdentity(identity: string): { readonly provider: string; readonly id: string } | null {
  if (typeof identity !== "string" || !MODEL_IDENTITY_RE.test(identity)) {
    return null;
  }
  const slashIndex = identity.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= identity.length - 1) {
    return null;
  }
  return {
    provider: identity.slice(0, slashIndex),
    id: identity.slice(slashIndex + 1),
  };
}

/**
 * Computes the supported thinking levels for a model using Pi's capability rules:
 * - `model.reasoning === false` -> `["off"]`
 * - `model.reasoning === true` -> standard levels filtered by `thinkingLevelMap`
 *   (`null` excludes a level; `"xhigh"` and `"max"` require an explicit non-null map entry)
 * - `model` omitted or `model.reasoning === undefined` -> all levels (filtered by `thinkingLevelMap` if set)
 *
 * When `allowedLevels` is provided, intersects with the model's supported levels
 * (falling back to the model's supported levels if the intersection is empty).
 */
export function getSupportedThinkingLevelsForModel(
  model?: Pick<ModelPickerEntry, "reasoning" | "thinkingLevelMap">,
  allowedLevels?: readonly ModelThinkingLevel[],
): ModelThinkingLevel[] {
  let supported: ModelThinkingLevel[];

  if (model?.reasoning === false) {
    supported = ["off"];
  } else if (model?.reasoning === true) {
    supported = MODEL_THINKING_LEVELS.filter((level) => {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) {
        return false;
      }
      if (level === "xhigh" || level === "max") {
        return mapped !== undefined;
      }
      return true;
    });
  } else {
    supported = MODEL_THINKING_LEVELS.filter((level) => {
      const mapped = model?.thinkingLevelMap?.[level];
      return mapped !== null;
    });
  }

  if (supported.length === 0) {
    supported = ["off"];
  }

  if (allowedLevels && allowedLevels.length > 0) {
    const supportedSet = new Set<ModelThinkingLevel>(supported);
    const filtered = allowedLevels.filter((level) => supportedSet.has(level));
    if (filtered.length > 0) {
      return [...new Set(filtered)];
    }
  }

  return supported;
}

// Matches OSC, DCS/SOS/PM/APC, CSI (7-bit & 8-bit), and 2-byte ESC sequences.
const ANSI_ESCAPE_SEQUENCE_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|\x07|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[@-~]/g;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_ALL_RE = /[\x00-\x1f\x7f-\x9f]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_EXCEPT_NL_TAB_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively traverses plain objects and arrays and returns all key paths
 * whose key name matches `SECRET_KEY_PATTERN`.
 */
export function findSecretKeys(obj: unknown, prefix = ""): string[] {
  const results: string[] = [];
  const seen = new WeakSet<object>();

  function walk(node: unknown, currentPrefix: string): void {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const itemPath = currentPrefix ? `${currentPrefix}[${i}]` : `[${i}]`;
        walk(node[i], itemPath);
      }
      return;
    }

    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        const keyPath = currentPrefix ? `${currentPrefix}.${key}` : key;
        if (SECRET_KEY_PATTERN.test(key)) {
          results.push(keyPath);
        }
        walk(node[key], keyPath);
      }
    }
  }

  walk(obj, prefix);
  return results;
}

/**
 * Strips ANSI escape sequences (CSI/OSC/DCS/ESC) and C0/C1 control characters.
 * Preserves `\n` and `\t` when `preserveNewlines` is true.
 */
export function stripControlChars(value: string, preserveNewlines = false): string {
  const withoutAnsi = value.replace(ANSI_ESCAPE_SEQUENCE_RE, "");
  const controlRe = preserveNewlines ? CONTROL_CHARS_EXCEPT_NL_TAB_RE : CONTROL_CHARS_ALL_RE;
  return withoutAnsi.replace(controlRe, "");
}

/**
 * Deep structural equality for primitives (including NaN), arrays, plain objects,
 * Date, and RegExp values.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  }

  if (a instanceof RegExp || b instanceof RegExp) {
    return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  }

  if (!isPlainObject(a) || !isPlainObject(b)) {
    return false;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) {
      return false;
    }
    if (!deepEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Deep-clones primitives, arrays, plain objects, Date, and RegExp values.
 */
export function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (value instanceof Date) {
    return new Date(value.getTime()) as unknown as T;
  }
  if (value instanceof RegExp) {
    return new RegExp(value.source, value.flags) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const cloned = cloneValue(value[key]);
      if (key === "__proto__") {
        Object.defineProperty(out, key, {
          value: cloned,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else {
        out[key] = cloned;
      }
    }
    return out as T;
  }
  return value;
}

/**
 * Strictly validates and normalizes a single field value against its definition.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function validateFieldValue(fieldDef: AnyFieldDef, raw: unknown): ValidationResult<any> {
  switch (fieldDef.kind) {
    case "boolean": {
      if (typeof raw !== "boolean") {
        return { ok: false, error: "Expected a boolean value" };
      }
      return { ok: true, value: raw };
    }

    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return { ok: false, error: "Expected a finite number" };
      }
      if (fieldDef.integer && !Number.isSafeInteger(raw)) {
        return { ok: false, error: "Expected a safe integer" };
      }
      if (fieldDef.min !== undefined && raw < fieldDef.min) {
        return { ok: false, error: `Value must be at least ${fieldDef.min}` };
      }
      if (fieldDef.max !== undefined && raw > fieldDef.max) {
        return { ok: false, error: `Value must be at most ${fieldDef.max}` };
      }
      return { ok: true, value: raw === 0 ? 0 : raw };
    }

    case "string": {
      if (typeof raw !== "string") {
        return { ok: false, error: "Expected a string" };
      }
      let val = raw;
      if (fieldDef.stripControlChars !== false) {
        val = stripControlChars(val, Boolean(fieldDef.multiline));
      }
      if (fieldDef.trim) {
        val = val.trim();
      }
      if (fieldDef.minLength !== undefined && val.length < fieldDef.minLength) {
        return { ok: false, error: `Must be at least ${fieldDef.minLength} characters` };
      }
      if (fieldDef.maxLength !== undefined && val.length > fieldDef.maxLength) {
        return { ok: false, error: `Must be at most ${fieldDef.maxLength} characters` };
      }
      if (fieldDef.pattern) {
        const re = fieldDef.pattern;
        if (re.global || re.sticky) {
          re.lastIndex = 0;
        }
        if (!re.test(val)) {
          return {
            ok: false,
            error: fieldDef.patternMessage ?? "Value does not match required pattern",
          };
        }
      }
      return { ok: true, value: val };
    }

    case "enum": {
      if (typeof raw !== "string") {
        return { ok: false, error: "Expected a string option" };
      }
      const allowed = fieldDef.options.some((opt) => opt.value === raw);
      if (!allowed) {
        const validList = fieldDef.options.map((opt) => opt.value).join(", ");
        return { ok: false, error: `Invalid option "${raw}". Allowed: ${validList}` };
      }
      return { ok: true, value: raw };
    }

    case "multiSelect": {
      if (!Array.isArray(raw)) {
        return { ok: false, error: "Expected an array of strings" };
      }
      const allowedSet =
        !fieldDef.allowCustom && typeof fieldDef.options !== "function"
          ? new Set(fieldDef.options.map((opt) => opt.value))
          : null;

      const deduped: string[] = [];
      const seen = new Set<string>();

      for (const item of raw) {
        if (typeof item !== "string") {
          return { ok: false, error: "All items must be strings" };
        }
        const normalized = fieldDef.allowCustom ? stripControlChars(item, false) : item;
        if (fieldDef.maxItemLength !== undefined && normalized.length > fieldDef.maxItemLength) {
          return {
            ok: false,
            error: `Item exceeds maximum length of ${fieldDef.maxItemLength} characters`,
          };
        }
        if (allowedSet !== null && !allowedSet.has(normalized)) {
          return { ok: false, error: `Invalid option "${normalized}"` };
        }
        if (!seen.has(normalized)) {
          seen.add(normalized);
          deduped.push(normalized);
        }
      }

      if (fieldDef.minItems !== undefined && deduped.length < fieldDef.minItems) {
        return { ok: false, error: `Select at least ${fieldDef.minItems} item(s)` };
      }
      if (fieldDef.maxItems !== undefined && deduped.length > fieldDef.maxItems) {
        return { ok: false, error: `Select at most ${fieldDef.maxItems} item(s)` };
      }

      return { ok: true, value: deduped };
    }

    case "model": {
      if (raw === null) {
        if (fieldDef.allowClear) {
          return { ok: true, value: null };
        }
        return { ok: false, error: "A model selection is required" };
      }

      if (fieldDef.includeThinking === false) {
        if (typeof raw !== "string") {
          return { ok: false, error: 'Model must be a "provider/model-id" string' };
        }
        const normalizedModel = stripControlChars(raw, false).trim();
        if (!parseModelIdentity(normalizedModel)) {
          return {
            ok: false,
            error: `Invalid model "${normalizedModel}". Expected "provider/model-id" format`,
          };
        }
        return { ok: true, value: normalizedModel };
      }

      if (!isPlainObject(raw)) {
        return {
          ok: false,
          error: "Expected a model selection object with model and thinkingLevel",
        };
      }

      if (typeof raw.model !== "string") {
        return { ok: false, error: 'Model must be a "provider/model-id" string' };
      }

      const normalizedModel = stripControlChars(raw.model, false).trim();
      if (!parseModelIdentity(normalizedModel)) {
        return {
          ok: false,
          error: `Invalid model "${normalizedModel}". Expected "provider/model-id" format`,
        };
      }

      const allowedThinking =
        fieldDef.thinkingLevels && fieldDef.thinkingLevels.length > 0
          ? fieldDef.thinkingLevels
          : MODEL_THINKING_LEVELS;

      if (!isValidModelThinkingLevel(raw.thinkingLevel) || !allowedThinking.includes(raw.thinkingLevel)) {
        return {
          ok: false,
          error: `Invalid thinking level "${String(raw.thinkingLevel)}". Allowed: ${allowedThinking.join(", ")}`,
        };
      }

      return {
        ok: true,
        value: {
          model: normalizedModel,
          thinkingLevel: raw.thinkingLevel,
        },
      };
    }

    case "custom": {
      if (fieldDef.validate) {
        try {
          const valid = fieldDef.validate(raw);
          if (valid !== true) {
            const error = typeof valid === "string" && valid.length > 0 ? valid : "Invalid value";
            return { ok: false, error };
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      if (fieldDef.normalize) {
        try {
          return { ok: true, value: fieldDef.normalize(raw) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      return { ok: true, value: cloneValue(raw) };
    }
  }
}

/**
 * Validates an untrusted partial settings object against a schema's fields,
 * returning sanitized partial values plus warnings and rejected keys.
 */
export function validatePartialSettings<TFields extends FieldMap>(
  fields: TFields,
  raw: unknown,
): PartialValidationResult<InferSettingsValues<TFields>> {
  if (!isPlainObject(raw)) {
    return {
      values: {},
      warnings: [{ key: "", message: "Settings data must be a plain object" }],
      rejectedKeys: [],
    };
  }

  const values: Record<string, unknown> = {};
  const warnings: ValidationWarning[] = [];
  const rejectedKeys: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      warnings.push({ key, message: `Unknown setting "${key}"` });
      rejectedKeys.push(key);
      continue;
    }

    const fieldDef = fields[key]!;
    const result = validateFieldValue(fieldDef, raw[key]);
    if (result.ok) {
      values[key] = result.value;
    } else {
      warnings.push({ key, message: result.error });
      rejectedKeys.push(key);
    }
  }

  return {
    values: values as Partial<InferSettingsValues<TFields>>,
    warnings,
    rejectedKeys,
  };
}
