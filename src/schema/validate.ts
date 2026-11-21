import type {
  AnyFieldDef,
  FieldMap,
  InferSettingsValues,
  PartialValidationResult,
  ValidationResult,
  ValidationWarning,
} from "./types.js";

export const SECRET_KEY_PATTERN = /api.?key|token|secret|password|authorization|credential/i;

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
