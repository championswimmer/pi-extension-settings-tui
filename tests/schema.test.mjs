import test from "node:test";
import assert from "node:assert/strict";
import {
  MODEL_THINKING_LEVELS,
  SECRET_KEY_PATTERN,
  cloneValue,
  deepEqual,
  defineSettings,
  field,
  findSecretKeys,
  formatModelIdentity,
  getSupportedThinkingLevelsForModel,
  isPersistedFieldDef,
  parseModelIdentity,
  stripControlChars,
  validateFieldValue,
  validatePartialSettings,
} from "../dist/schema/index.js";

test("defineSettings handles implicit single tab vs explicit tabs", () => {
  const implicit = defineSettings({
    id: "implicit-ext",
    title: "Implicit",
    fields: {
      enabled: field.boolean({ label: "Enabled", default: true }),
      count: field.integer({ label: "Count", default: 2 }),
    },
  });

  assert.equal(implicit.hasExplicitTabs, false);
  assert.deepEqual(implicit.tabs, [{ id: "general", label: "General" }]);
  assert.deepEqual(implicit.scopes, ["global", "project"]);
  assert.equal(implicit.defaultScope, "global");
  assert.equal(implicit.saveMode, "draft");
  assert.deepEqual(
    implicit.getFieldsForTab("general").map((entry) => entry.key),
    ["enabled", "count"],
  );
  assert.deepEqual(implicit.getFieldsForTab("missing"), []);

  const explicit = defineSettings({
    id: "explicit-ext",
    title: "Explicit",
    scopes: ["project", "global"],
    defaultScope: "project",
    saveMode: "immediate",
    tabs: [
      { id: "basics", label: "Basics" },
      { id: "limits", label: "Limits", description: "Resource limits" },
    ],
    fields: {
      flag: field.boolean({ label: "Flag", default: false }), // defaults to first tab
      maxRetries: field.integer({ tab: "limits", label: "Max Retries", default: 3 }),
    },
  });

  assert.equal(explicit.hasExplicitTabs, true);
  assert.equal(explicit.defaultScope, "project");
  assert.equal(explicit.saveMode, "immediate");
  assert.deepEqual(
    explicit.getFieldsForTab("basics").map((entry) => entry.key),
    ["flag"],
  );
  assert.deepEqual(
    explicit.getFieldsForTab("limits").map((entry) => entry.key),
    ["maxRetries"],
  );
});

test("defineSettings validates tab references, duplicate tabs, and defaultScope", () => {
  assert.throws(
    () =>
      defineSettings({
        id: "dup-tabs",
        title: "Dup Tabs",
        tabs: [
          { id: "a", label: "A" },
          { id: "a", label: "A2" },
        ],
        fields: {},
      }),
    /Duplicate tab id "a"/,
  );

  assert.throws(
    () =>
      defineSettings({
        id: "bad-field-tab",
        title: "Bad Field Tab",
        tabs: [{ id: "main", label: "Main" }],
        fields: {
          x: field.boolean({ tab: "unknown", label: "X", default: true }),
        },
      }),
    /references unknown tab "unknown"/,
  );

  assert.throws(
    () =>
      defineSettings({
        id: "bad-scope",
        title: "Bad Scope",
        scopes: ["global"],
        defaultScope: "project",
        fields: {},
      }),
    /defaultScope "project" is not included in scopes/,
  );
});

test("getDefaults returns deep-cloned independent snapshots", () => {
  const schema = defineSettings({
    id: "clone-defaults",
    title: "Clone Defaults",
    fields: {
      tags: field.multiSelect({
        label: "Tags",
        default: ["alpha"],
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
        ],
      }),
      custom: field.custom({
        label: "Custom",
        default: { nested: { list: [1, 2] } },
      }),
    },
  });

  const d1 = schema.getDefaults();
  d1.tags.push("beta");
  d1.custom.nested.list.push(3);

  const d2 = schema.getDefaults();
  assert.deepEqual(d2.tags, ["alpha"]);
  assert.deepEqual(d2.custom.nested.list, [1, 2]);
  assert.deepEqual(schema.defaults.tags, ["alpha"]);
  assert.deepEqual(schema.defaults.custom.nested.list, [1, 2]);
});

test("boolean, number, and integer validation edge cases", () => {
  const boolDef = field.boolean({ label: "Bool", default: false });
  assert.deepEqual(validateFieldValue(boolDef, true), { ok: true, value: true });
  assert.deepEqual(validateFieldValue(boolDef, false), { ok: true, value: false });
  for (const invalid of ["true", 1, 0, null, undefined, {}]) {
    assert.equal(validateFieldValue(boolDef, invalid).ok, false);
  }

  const numDef = field.number({ label: "Ratio", default: 0.5, min: 0, max: 1.5 });
  assert.deepEqual(validateFieldValue(numDef, 0.75), { ok: true, value: 0.75 });
  assert.deepEqual(validateFieldValue(numDef, -0), { ok: true, value: 0 });
  assert.equal(Object.is(validateFieldValue(numDef, -0).value, 0), true);
  for (const invalid of [NaN, Infinity, -Infinity, "0.5", null, -0.1, 1.6]) {
    assert.equal(validateFieldValue(numDef, invalid).ok, false);
  }

  const intDef = field.integer({ label: "Retries", default: 3, min: 0, max: 10 });
  assert.equal(intDef.integer, true);
  assert.deepEqual(validateFieldValue(intDef, 0), { ok: true, value: 0 });
  assert.deepEqual(validateFieldValue(intDef, 10), { ok: true, value: 10 });
  for (const invalid of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, -1, 11, "3"]) {
    assert.equal(validateFieldValue(intDef, invalid).ok, false);
  }
});

test("stripControlChars and string field validation edge cases", () => {
  // CSI, OSC, DCS, 2-byte ESC, C0, C1
  assert.equal(stripControlChars("\x1b[31;1mred\x1b[0m text"), "red text");
  assert.equal(
    stripControlChars("\x1b]8;;https://example.com\x07link\x1b]8;;\x07"),
    "link",
  );
  assert.equal(stripControlChars("\x1b]0;title\x1b\\body"), "body");
  assert.equal(stripControlChars("a\x1bPfoo\x1b\\b\x9b31mc\x85d\x00\x07e"), "abcde");
  assert.equal(stripControlChars("line1\r\nline2\tcol\x00", true), "line1\nline2\tcol");
  assert.equal(stripControlChars("line1\nline2\tcol", false), "line1line2col");

  const trimmed = field.string({
    label: "Slug",
    default: "abc",
    trim: true,
    minLength: 2,
    maxLength: 5,
    pattern: /^[a-z0-9-]+$/g, // global flag tests lastIndex reset
    patternMessage: "Slug must be lowercase alphanumeric",
  });

  assert.deepEqual(validateFieldValue(trimmed, "  \x1b[32mab-1\x1b[0m  "), {
    ok: true,
    value: "ab-1",
  });
  // Second consecutive call ensures stateful global regex does not flip
  assert.deepEqual(validateFieldValue(trimmed, "ab-1"), { ok: true, value: "ab-1" });

  assert.equal(validateFieldValue(trimmed, " a ").ok, false); // trimmed length < 2
  assert.equal(validateFieldValue(trimmed, "abcdef").ok, false); // > maxLength
  assert.deepEqual(validateFieldValue(trimmed, "AB!"), {
    ok: false,
    error: "Slug must be lowercase alphanumeric",
  });
  assert.equal(validateFieldValue(trimmed, 123).ok, false);

  const multiline = field.string({
    label: "Notes",
    default: "",
    multiline: true,
  });
  assert.deepEqual(validateFieldValue(multiline, "a\x1b[31m\nb\tc\x07"), {
    ok: true,
    value: "a\nb\tc",
  });

  const rawAllowed = field.string({
    label: "Raw",
    default: "",
    stripControlChars: false,
  });
  assert.deepEqual(validateFieldValue(rawAllowed, "x\x07y"), { ok: true, value: "x\x07y" });
});

test("enum and multiSelect validation edge cases", () => {
  const enumDef = field.enum({
    label: "Mode",
    default: "off",
    options: [
      { value: "off", label: "Off" },
      { value: "strict", label: "Strict" },
    ],
  });
  assert.deepEqual(validateFieldValue(enumDef, "strict"), { ok: true, value: "strict" });
  assert.equal(validateFieldValue(enumDef, "warn").ok, false);
  assert.equal(validateFieldValue(enumDef, 1).ok, false);

  const multiDef = field.multiSelect({
    label: "Tools",
    default: ["read"],
    options: [
      { value: "read", label: "Read" },
      { value: "write", label: "Write" },
      { value: "edit", label: "Edit" },
    ],
    minItems: 1,
    maxItems: 2,
    maxItemLength: 5,
  });
  // Deduplicates preserving order before min/max check
  assert.deepEqual(validateFieldValue(multiDef, ["write", "read", "write"]), {
    ok: true,
    value: ["write", "read"],
  });
  assert.equal(validateFieldValue(multiDef, []).ok, false); // minItems
  assert.equal(validateFieldValue(multiDef, ["read", "write", "edit"]).ok, false); // maxItems
  assert.equal(validateFieldValue(multiDef, ["unknown"]).ok, false); // not in static options
  assert.equal(validateFieldValue(multiDef, "read").ok, false); // not an array
  assert.equal(validateFieldValue(multiDef, [123]).ok, false); // non-string item

  const customMultiDef = field.multiSelect({
    label: "Custom Tags",
    default: [],
    options: [{ value: "core", label: "Core" }],
    allowCustom: true,
    maxItemLength: 6,
  });
  assert.deepEqual(
    validateFieldValue(customMultiDef, ["core", "\x1b[31mextra\x1b[0m", "extra"]),
    { ok: true, value: ["core", "extra"] },
  );
  assert.equal(validateFieldValue(customMultiDef, ["toolongtag"]).ok, false);

  const dynamicMultiDef = field.multiSelect({
    label: "Dynamic",
    default: [],
    options: () => [{ value: "a", label: "A" }],
  });
  assert.deepEqual(validateFieldValue(dynamicMultiDef, ["anything", "anything"]), {
    ok: true,
    value: ["anything"],
  });
});

test("custom field validate and normalize handling", () => {
  const customDef = field.custom({
    label: "Endpoint",
    default: { host: "localhost", port: 8080 },
    validate: (raw) => {
      if (!raw || typeof raw !== "object" || !("host" in raw)) {
        return "Endpoint requires a host";
      }
      return Boolean(raw.host);
    },
    normalize: (raw) => {
      return { host: raw.host.trim(), port: raw.port ?? 8080 };
    },
  });

  assert.deepEqual(validateFieldValue(customDef, { host: "  api.local  " }), {
    ok: true,
    value: { host: "api.local", port: 8080 },
  });
  assert.deepEqual(validateFieldValue(customDef, {}), {
    ok: false,
    error: "Endpoint requires a host",
  });
  assert.deepEqual(validateFieldValue(customDef, { host: "" }), {
    ok: false,
    error: "Invalid value",
  });

  const throwingCustom = field.custom({
    label: "Throwing",
    default: "ok",
    validate: () => {
      throw new Error("boom validate");
    },
  });
  assert.deepEqual(validateFieldValue(throwingCustom, "x"), {
    ok: false,
    error: "boom validate",
  });

  const throwingNorm = field.custom({
    label: "Throwing Norm",
    default: "ok",
    normalize: () => {
      throw new Error("boom normalize");
    },
  });
  assert.deepEqual(validateFieldValue(throwingNorm, "x"), {
    ok: false,
    error: "boom normalize",
  });
});

test("validatePartialSettings collects warnings and rejectedKeys while preserving valid keys", () => {
  const schema = defineSettings({
    id: "partial",
    title: "Partial",
    fields: {
      flag: field.boolean({ label: "Flag", default: true }),
      count: field.integer({ label: "Count", default: 1, min: 0 }),
    },
  });

  const nonObj = schema.validatePartial(["not", "an", "object"]);
  assert.deepEqual(nonObj.values, {});
  assert.equal(nonObj.warnings.length, 1);

  const res = validatePartialSettings(schema.fields, {
    flag: false,
    count: -5,
    extra: "unknown",
  });
  assert.deepEqual(res.values, { flag: false });
  assert.deepEqual(res.rejectedKeys.sort(), ["count", "extra"]);
  assert.equal(res.warnings.length, 2);
});

test("findSecretKeys recursively inspects plain objects and arrays safely", () => {
  assert.equal(SECRET_KEY_PATTERN.test("apiKey"), true);
  assert.equal(SECRET_KEY_PATTERN.test("api_key"), true);
  assert.equal(SECRET_KEY_PATTERN.test("refreshToken"), true);
  assert.equal(SECRET_KEY_PATTERN.test("clientSecret"), true);
  assert.equal(SECRET_KEY_PATTERN.test("dbPassword"), true);
  assert.equal(SECRET_KEY_PATTERN.test("authorizationHeader"), true);
  assert.equal(SECRET_KEY_PATTERN.test("credentials"), true);

  const nullProto = Object.create(null);
  nullProto.secretValue = "hidden";

  const cyclic = { ok: true };
  cyclic.self = cyclic;

  const found = findSecretKeys({
    safe: "hello",
    apiKey: "sk-1",
    nested: {
      deep: [{ auth_token: "t1" }, { password: "p1", sub: nullProto }],
    },
    cyclic,
  });

  assert.deepEqual(found, [
    "apiKey",
    "nested.deep[0].auth_token",
    "nested.deep[1].password",
    "nested.deep[1].sub.secretValue",
  ]);
});

test("deepEqual and cloneValue handle primitives, NaN, arrays, objects, Date, RegExp", () => {
  assert.equal(deepEqual(NaN, NaN), true);
  assert.equal(deepEqual(+0, -0), true);
  assert.equal(deepEqual([1, { a: [NaN, "x"] }], [1, { a: [NaN, "x"] }]), true);
  assert.equal(deepEqual({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(deepEqual(new Date(1000), new Date(1000)), true);
  assert.equal(deepEqual(/abc/gi, /abc/gi), true);
  assert.equal(deepEqual(/abc/g, /abc/i), false);

  const source = { arr: [{ x: 1 }], dt: new Date(5000), re: /test/i };
  const copy = cloneValue(source);
  copy.arr[0].x = 99;
  copy.dt.setTime(0);
  assert.equal(source.arr[0].x, 1);
  assert.equal(source.dt.getTime(), 5000);
});

test("resolveEffective, computeProvenance, and diffForScope behavior", () => {
  const schema = defineSettings({
    id: "layered",
    title: "Layered",
    fields: {
      theme: field.enum({
        label: "Theme",
        default: "system",
        options: [
          { value: "system", label: "System" },
          { value: "dark", label: "Dark" },
          { value: "light", label: "Light" },
        ],
      }),
      tags: field.multiSelect({
        label: "Tags",
        default: ["a"],
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ],
      }),
      globalOnly: field.boolean({
        label: "Global Only",
        default: false,
        scopes: ["global"],
      }),
      retries: field.integer({
        label: "Retries",
        default: 3,
      }),
    },
  });

  const layers = {
    global: { theme: "dark", tags: ["b", "c"], globalOnly: true },
    project: { tags: ["a", "b"], retries: 5 },
  };

  const effFull = schema.resolveEffective(layers, { includeProject: true });
  assert.deepEqual(effFull, {
    theme: "dark",
    tags: ["a", "b"],
    globalOnly: true,
    retries: 5,
  });

  // Mutating returned arrays must not affect layers
  effFull.tags.push("c");
  assert.deepEqual(layers.project.tags, ["a", "b"]);

  const effGlobalOnly = schema.resolveEffective(layers, { includeProject: false });
  assert.deepEqual(effGlobalOnly, {
    theme: "dark",
    tags: ["b", "c"],
    globalOnly: true,
    retries: 3,
  });

  assert.deepEqual(schema.computeProvenance(layers, { includeProject: true }), {
    theme: "global",
    tags: "both",
    globalOnly: "global",
    retries: "project",
  });

  assert.deepEqual(schema.computeProvenance(layers, { includeProject: false }), {
    theme: "global",
    tags: "global",
    globalOnly: "global",
    retries: "default",
  });

  // diffForScope: global diffs against defaults
  const nextForGlobal = {
    theme: "system", // equals default -> omitted
    tags: ["a"], // equals default (deep array equality) -> omitted
    globalOnly: true, // differs from default false -> included
    retries: 5, // differs from default 3 -> included
  };
  assert.deepEqual(schema.diffForScope(nextForGlobal, "global", layers), {
    globalOnly: true,
    retries: 5,
  });

  // diffForScope: project diffs against (globalVal ?? default), and respects field.scopes
  const nextForProject = {
    theme: "dark", // matches global -> omitted
    tags: ["b", "c"], // matches global (deep array equality) -> omitted
    globalOnly: false, // differs from global true, BUT field restricts scopes: ["global"] -> omitted!
    retries: 5, // differs from default 3 (no global override) -> included
  };
  assert.deepEqual(schema.diffForScope(nextForProject, "project", layers), {
    retries: 5,
  });

  // Project explicitly reverting a global override back to default must be persisted in project layer!
  const revertToDefaultInProject = {
    theme: "system", // global is "dark", so "system" differs from global -> included
    tags: ["b", "c"],
    globalOnly: true,
    retries: 3,
  };
  assert.deepEqual(schema.diffForScope(revertToDefaultInProject, "project", layers), {
    theme: "system",
  });
});

test("formatFieldValue and getFieldTone defaults and custom overrides", () => {
  const schema = defineSettings({
    id: "fmt",
    title: "Format",
    fields: {
      boolDefault: field.boolean({ label: "Bool", default: true }),
      boolCustom: field.boolean({
        label: "Bool Custom",
        default: false,
        trueLabel: "Yes",
        falseLabel: "No",
        tone: (v) => (v ? "accent" : "error"),
      }),
      mode: field.enum({
        label: "Mode",
        default: "strict",
        options: [
          { value: "off", label: "Disabled", tone: "muted" },
          { value: "strict", label: "Strict Mode", tone: "warn" },
        ],
      }),
      tags: field.multiSelect({
        label: "Tags",
        default: [],
        emptyLabel: "Nothing",
        options: [
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
          { value: "d", label: "Delta" },
        ],
      }),
      timeout: field.number({
        label: "Timeout",
        default: 500,
        unit: "ms",
      }),
      text: field.string({
        label: "Text",
        default: "",
      }),
      customFmt: field.custom({
        label: "Custom",
        default: 42,
        format: (n) => `#${n}`,
        tone: "accent",
      }),
    },
  });

  assert.equal(schema.formatFieldValue("boolDefault", true), "On");
  assert.equal(schema.formatFieldValue("boolDefault", false), "Off");
  assert.equal(schema.getFieldTone("boolDefault", true), "success");
  assert.equal(schema.getFieldTone("boolDefault", false), "muted");

  assert.equal(schema.formatFieldValue("boolCustom", true), "Yes");
  assert.equal(schema.formatFieldValue("boolCustom", false), "No");
  assert.equal(schema.getFieldTone("boolCustom", true), "accent");
  assert.equal(schema.getFieldTone("boolCustom", false), "error");

  assert.equal(schema.formatFieldValue("mode", "strict"), "Strict Mode");
  assert.equal(schema.getFieldTone("mode", "strict"), "warn");
  assert.equal(schema.getFieldTone("mode", "off"), "muted");

  assert.equal(schema.formatFieldValue("tags", []), "Nothing");
  assert.equal(schema.getFieldTone("tags", []), "muted");
  assert.equal(schema.formatFieldValue("tags", ["a", "b"]), "Alpha, Beta");
  assert.equal(schema.getFieldTone("tags", ["a", "b"]), "accent");
  assert.equal(schema.formatFieldValue("tags", ["a", "b", "c", "d"]), "4 selected");

  assert.equal(schema.formatFieldValue("timeout", 500), "500 ms");
  assert.equal(schema.getFieldTone("timeout", 500), "default");

  assert.equal(schema.formatFieldValue("text", ""), "(empty)");
  assert.equal(schema.getFieldTone("text", ""), "muted");
  assert.equal(schema.formatFieldValue("text", "hello\nworld"), '"hello world"');
  assert.equal(schema.getFieldTone("text", "hello"), "default");
  assert.equal(
    schema.formatFieldValue("text", "a".repeat(40)),
    `"${"a".repeat(27)}..."`,
  );

  assert.equal(schema.formatFieldValue("customFmt", 42), "#42");
  assert.equal(schema.getFieldTone("customFmt", 42), "accent");
});

test("defineSettings resolves settingsFile from top-level config or storage.settingsFile", () => {
  const omitted = defineSettings({
    id: "no-sf",
    title: "No SettingsFile",
    fields: {},
  });
  assert.equal(omitted.settingsFile, undefined);
  assert.equal(omitted.storage.settingsFile, undefined);

  const topLevel = defineSettings({
    id: "top-sf",
    title: "Top SettingsFile",
    settingsFile: "my-ext.json",
    fields: {},
  });
  assert.equal(topLevel.settingsFile, "my-ext.json");
  assert.equal(topLevel.storage.settingsFile, "my-ext.json");

  const fromStorage = defineSettings({
    id: "storage-sf",
    title: "Storage SettingsFile",
    storage: { settingsFile: "nested/prefs.json" },
    fields: {},
  });
  assert.equal(fromStorage.settingsFile, "nested/prefs.json");
  assert.equal(fromStorage.storage.settingsFile, "nested/prefs.json");

  const topWins = defineSettings({
    id: "top-wins",
    title: "Top Wins",
    settingsFile: "preferred.json",
    storage: { settingsFile: "fallback.json" },
    fields: {},
  });
  assert.equal(topWins.settingsFile, "preferred.json");
  assert.equal(topWins.storage.settingsFile, "preferred.json");
});

test("model field helpers, validation, formatting, tone, and layered diffing", () => {
  assert.deepEqual(MODEL_THINKING_LEVELS, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  assert.equal(formatModelIdentity({ provider: "anthropic", id: "claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
  assert.deepEqual(parseModelIdentity("anthropic/claude-sonnet-4-5"), {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  });
  // OpenRouter-style nested slashes & colon suffixes
  assert.deepEqual(parseModelIdentity("openrouter/qwen/qwen3-coder:exacto"), {
    provider: "openrouter",
    id: "qwen/qwen3-coder:exacto",
  });
  for (const invalid of ["", "no-slash", "/leading", "trailing/", "has space/id", "p/has space"]) {
    assert.equal(parseModelIdentity(invalid), null);
  }

  // Supported thinking levels matching Pi rules
  assert.deepEqual(getSupportedThinkingLevelsForModel({ reasoning: false }), ["off"]);
  assert.deepEqual(getSupportedThinkingLevelsForModel({ reasoning: true }), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(
    getSupportedThinkingLevelsForModel({
      reasoning: true,
      thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: "max" },
    }),
    ["off", "low", "medium", "high", "xhigh", "max"],
  );
  assert.deepEqual(
    getSupportedThinkingLevelsForModel({ reasoning: true }, ["low", "high"]),
    ["low", "high"],
  );
  assert.deepEqual(getSupportedThinkingLevelsForModel(undefined), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);

  const requiredModel = field.model({
    label: "Summary model",
    default: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" },
    thinkingLevels: ["off", "low", "medium", "high"],
  });
  assert.equal(requiredModel.allowClear, false);
  assert.deepEqual(
    validateFieldValue(requiredModel, {
      model: "  \x1b[32mopenai/gpt-5-mini\x1b[0m  ",
      thinkingLevel: "medium",
      extraIgnored: true,
    }),
    { ok: true, value: { model: "openai/gpt-5-mini", thinkingLevel: "medium" } },
  );
  assert.equal(validateFieldValue(requiredModel, null).ok, false);
  assert.equal(validateFieldValue(requiredModel, "openai/gpt-5-mini").ok, false);
  assert.equal(
    validateFieldValue(requiredModel, { model: "missing-provider", thinkingLevel: "low" }).ok,
    false,
  );
  assert.equal(
    validateFieldValue(requiredModel, { model: "openai/gpt-5-mini", thinkingLevel: "xhigh" }).ok,
    false,
  );

  const nullableModel = field.model({
    label: "Housekeeping model",
    default: null,
    emptyLabel: "Disabled",
  });
  assert.equal(nullableModel.allowClear, true);
  assert.deepEqual(validateFieldValue(nullableModel, null), { ok: true, value: null });
  assert.deepEqual(
    validateFieldValue(nullableModel, {
      model: "openrouter/anthropic/claude-3.5-sonnet",
      thinkingLevel: "high",
    }),
    {
      ok: true,
      value: { model: "openrouter/anthropic/claude-3.5-sonnet", thinkingLevel: "high" },
    },
  );

  const schema = defineSettings({
    id: "model-schema",
    title: "Model Schema",
    fields: {
      summaryModel: requiredModel,
      housekeepingModel: nullableModel,
    },
  });

  assert.equal(
    schema.formatFieldValue("summaryModel", {
      model: "anthropic/claude-haiku-4-5",
      thinkingLevel: "low",
    }),
    "anthropic/claude-haiku-4-5 (low)",
  );
  assert.equal(
    schema.getFieldTone("summaryModel", {
      model: "anthropic/claude-haiku-4-5",
      thinkingLevel: "low",
    }),
    "accent",
  );
  assert.equal(schema.formatFieldValue("housekeepingModel", null), "Disabled");
  assert.equal(schema.getFieldTone("housekeepingModel", null), "muted");

  // Layered resolution & diffing (changing only thinkingLevel must be persisted!)
  const layers = {
    global: {
      summaryModel: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "medium" },
    },
    project: {},
  };
  assert.deepEqual(
    schema.diffForScope(
      {
        summaryModel: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" },
        housekeepingModel: null,
      },
      "global",
      { global: {}, project: {} },
    ),
    {},
  );
  assert.deepEqual(
    schema.diffForScope(
      {
        summaryModel: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "high" },
        housekeepingModel: { model: "openai/gpt-5-mini", thinkingLevel: "off" },
      },
      "project",
      layers,
    ),
    {
      summaryModel: { model: "anthropic/claude-haiku-4-5", thinkingLevel: "high" },
      housekeepingModel: { model: "openai/gpt-5-mini", thinkingLevel: "off" },
    },
  );
});

test("getFieldDescription supports dynamic descriptions and enum option fallback", () => {
  const schema = defineSettings({
    id: "dynamic-desc",
    title: "Dynamic Desc",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: true,
      }),
      mode: field.enum({
        label: "Mode",
        default: "fast",
        options: [
          { value: "fast", label: "Fast", description: "Prioritize speed" },
          { value: "strict", label: "Strict", description: "Full validation" },
          { value: "plain", label: "Plain" },
        ],
      }),
      threshold: field.integer({
        label: "Threshold",
        default: 10,
        description: (values) =>
          values.enabled ? `Active threshold: ${values.threshold}` : "Disabled",
      }),
    },
  });

  // Uses schema defaults when values omitted
  assert.equal(schema.getFieldDescription("threshold"), "Active threshold: 10");
  // Uses provided draft values
  assert.equal(
    schema.getFieldDescription("threshold", { enabled: false, mode: "fast", threshold: 25 }),
    "Disabled",
  );
  assert.equal(
    schema.getFieldDescription("threshold", { enabled: true, mode: "fast", threshold: 25 }),
    "Active threshold: 25",
  );

  // Enum option description fallback when def.description is omitted
  assert.equal(schema.getFieldDescription("mode"), "Prioritize speed");
  assert.equal(
    schema.getFieldDescription("mode", { enabled: true, mode: "strict", threshold: 10 }),
    "Full validation",
  );
  assert.equal(
    schema.getFieldDescription("mode", { enabled: true, mode: "plain", threshold: 10 }),
    undefined,
  );
  assert.equal(schema.getFieldDescription("enabled"), undefined);
  assert.equal(schema.getFieldDescription("nonexistent"), undefined);
});

test("draft-aware format(value, values) and tone(value, values)", () => {
  const schema = defineSettings({
    id: "draft-fmt-tone",
    title: "Draft Format & Tone",
    fields: {
      enabled: field.boolean({ label: "Enabled", default: true }),
      limit: field.integer({
        label: "Limit",
        default: 5,
        format: (val, values) => (values?.enabled === false ? `${val} (inactive)` : `${val} active`),
        tone: (val, values) => {
          if (values?.enabled === false) return "muted";
          return val > 10 ? "warn" : "success";
        },
      }),
    },
  });

  assert.equal(schema.formatFieldValue("limit", 5, { enabled: true, limit: 5 }), "5 active");
  assert.equal(schema.formatFieldValue("limit", 5, { enabled: false, limit: 5 }), "5 (inactive)");
  assert.equal(schema.getFieldTone("limit", 5, { enabled: true, limit: 5 }), "success");
  assert.equal(schema.getFieldTone("limit", 15, { enabled: true, limit: 15 }), "warn");
  assert.equal(schema.getFieldTone("limit", 15, { enabled: false, limit: 15 }), "muted");
});

test("field.model with includeThinking: false validates, formats, and diffs string model IDs", () => {
  const nullableModelId = field.model({
    label: "Fast Model",
    includeThinking: false,
    default: null,
    emptyLabel: "Auto",
  });
  assert.equal(nullableModelId.includeThinking, false);
  assert.equal(nullableModelId.allowClear, true);

  assert.deepEqual(validateFieldValue(nullableModelId, null), { ok: true, value: null });
  assert.deepEqual(validateFieldValue(nullableModelId, "  \x1b[32mopenai/gpt-4o\x1b[0m  "), {
    ok: true,
    value: "openai/gpt-4o",
  });
  assert.deepEqual(validateFieldValue(nullableModelId, "openrouter/qwen/qwen3-coder:exacto"), {
    ok: true,
    value: "openrouter/qwen/qwen3-coder:exacto",
  });
  assert.equal(
    validateFieldValue(nullableModelId, { model: "openai/gpt-4o", thinkingLevel: "low" }).ok,
    false,
  );
  assert.equal(validateFieldValue(nullableModelId, "no-slash").ok, false);
  assert.equal(validateFieldValue(nullableModelId, "/leading").ok, false);
  assert.equal(validateFieldValue(nullableModelId, "trailing/").ok, false);

  const requiredModelId = field.model({
    label: "Primary Model",
    includeThinking: false,
    default: "openai/gpt-4o",
  });
  assert.equal(requiredModelId.includeThinking, false);
  assert.equal(requiredModelId.allowClear, false);
  assert.equal(validateFieldValue(requiredModelId, null).ok, false);
  assert.deepEqual(validateFieldValue(requiredModelId, "anthropic/claude-sonnet-4-5"), {
    ok: true,
    value: "anthropic/claude-sonnet-4-5",
  });
  assert.equal(
    validateFieldValue(requiredModelId, { model: "openai/gpt-4o", thinkingLevel: "off" }).ok,
    false,
  );

  const schema = defineSettings({
    id: "model-id-only",
    title: "Model ID Only",
    fields: {
      fastModel: nullableModelId,
      primaryModel: requiredModelId,
    },
  });

  assert.equal(schema.formatFieldValue("fastModel", null), "Auto");
  assert.equal(schema.getFieldTone("fastModel", null), "muted");
  assert.equal(schema.formatFieldValue("fastModel", "openai/gpt-4o"), "openai/gpt-4o");
  assert.equal(schema.getFieldTone("fastModel", "openai/gpt-4o"), "accent");
  assert.equal(
    schema.formatFieldValue("primaryModel", "openrouter/qwen/qwen3-coder:exacto"),
    "openrouter/qwen/qwen3-coder:exacto",
  );

  assert.deepEqual(
    schema.diffForScope(
      { fastModel: null, primaryModel: "openai/gpt-4o" },
      "global",
      { global: {}, project: {} },
    ),
    {},
  );
  assert.deepEqual(
    schema.diffForScope(
      { fastModel: "openai/gpt-4o-mini", primaryModel: "anthropic/claude-sonnet-4-5" },
      "global",
      { global: {}, project: {} },
    ),
    { fastModel: "openai/gpt-4o-mini", primaryModel: "anthropic/claude-sonnet-4-5" },
  );
  assert.deepEqual(
    schema.diffForScope(
      { fastModel: "openai/gpt-4o-mini", primaryModel: "openai/gpt-4o" },
      "project",
      { global: { fastModel: "openai/gpt-4o-mini" }, project: {} },
    ),
    {},
  );
});

test("dynamic label, getFieldLabel, eligibility framework, and isFieldHardDisabled", () => {
  const schema = defineSettings({
    id: "eligibility-ext",
    title: "Eligibility",
    fields: {
      enabled: field.boolean({
        label: "Master switch",
        default: true,
      }),
      mode: field.enum({
        label: (v) => (v.enabled ? "Active Mode" : "Mode (inactive)"),
        default: "fast",
        allowInlineStep: false,
        display: "picker",
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      }),
      strictOnly: field.boolean({
        label: "Strict Only",
        default: false,
        eligible: (v) =>
          v.mode === "safe"
            ? true
            : { eligible: false, reason: "Requires Safe mode" },
      }),
      boolIneligible: field.boolean({
        label: "Bool Ineligible",
        default: false,
        eligible: false,
      }),
      stringDisabled: field.boolean({
        label: "String Disabled",
        default: false,
        disabled: (v) => (v.enabled ? false : "Enable master switch first"),
      }),
      hardDisabled: field.boolean({
        label: "Hard Disabled",
        default: false,
        disabled: true,
      }),
      dynamicHardDisabled: field.boolean({
        label: "Dynamic Hard Disabled",
        default: false,
        disabled: (v) => !v.enabled,
      }),
      bothBlocked: field.boolean({
        label: "Both Blocked",
        default: false,
        eligible: { eligible: false, reason: "From eligible" },
        disabled: "From disabled",
      }),
      emptyStringDisabled: field.boolean({
        label: "Empty String Disabled",
        default: false,
        disabled: "",
      }),
    },
  });

  // Dynamic labels
  assert.equal(schema.getFieldLabel("enabled"), "Master switch");
  assert.equal(schema.getFieldLabel("mode"), "Active Mode");
  assert.equal(
    schema.getFieldLabel("mode", { ...schema.getDefaults(), enabled: false }),
    "Mode (inactive)",
  );
  assert.equal(schema.getFieldLabel("nonexistent"), "nonexistent");

  // Enum allowInlineStep preserved
  assert.equal(schema.fields.mode.allowInlineStep, false);

  // Eligibility evaluation
  assert.deepEqual(schema.getFieldEligibility("enabled"), { eligible: true });
  assert.deepEqual(schema.getFieldEligibility("strictOnly"), {
    eligible: false,
    reason: "Requires Safe mode",
  });
  assert.deepEqual(
    schema.getFieldEligibility("strictOnly", { ...schema.getDefaults(), mode: "safe" }),
    { eligible: true },
  );
  assert.deepEqual(schema.getFieldEligibility("boolIneligible"), { eligible: false });

  // String disabled -> ineligible with reason, NOT hard disabled
  assert.deepEqual(schema.getFieldEligibility("stringDisabled"), { eligible: true });
  assert.equal(schema.isFieldHardDisabled("stringDisabled"), false);
  const offDraft = { ...schema.getDefaults(), enabled: false };
  assert.deepEqual(schema.getFieldEligibility("stringDisabled", offDraft), {
    eligible: false,
    reason: "Enable master switch first",
  });
  assert.equal(schema.isFieldHardDisabled("stringDisabled", offDraft), false);

  // Boolean disabled: true -> hard disabled, getFieldEligibility remains { eligible: true }
  assert.equal(schema.isFieldHardDisabled("hardDisabled"), true);
  assert.deepEqual(schema.getFieldEligibility("hardDisabled"), { eligible: true });

  // Dynamic boolean disabled
  assert.equal(schema.isFieldHardDisabled("dynamicHardDisabled"), false);
  assert.equal(schema.isFieldHardDisabled("dynamicHardDisabled", offDraft), true);

  // eligible takes precedence over string disabled
  assert.deepEqual(schema.getFieldEligibility("bothBlocked"), {
    eligible: false,
    reason: "From eligible",
  });

  // Empty string disabled is treated as eligible & not hard-disabled
  assert.deepEqual(schema.getFieldEligibility("emptyStringDisabled"), { eligible: true });
  assert.equal(schema.isFieldHardDisabled("emptyStringDisabled"), false);

  // Unknown key
  assert.deepEqual(schema.getFieldEligibility("unknown"), { eligible: false });
  assert.equal(schema.isFieldHardDisabled("unknown"), false);
});

test("field.view, field.external, field.picker, isPersistedFieldDef, scope helpers, and normalizeDraft", () => {
  const viewDef = field.view({
    label: (v) => `Preview (${v.enabled ? "on" : "off"})`,
    value: (v) => (v.enabled ? "Ready" : "Paused"),
    format: "markdown",
    content: "# Preview",
    refreshable: true,
    scopes: ["global"],
    tone: (v) => (v.enabled ? "accent" : "muted"),
  });

  const externalDef = field.external({
    label: "Manage Rules",
    summary: "3 rules",
    openSubroute: () => null,
    scopes: ["project"],
  });

  const pickerDef = field.picker({
    label: "Profile",
    default: null,
    allowClear: true,
    emptyLabel: "Default profile",
    loadOptions: () => [
      { id: "fast", value: { id: "fast", ver: 1 }, label: "Fast" },
    ],
    validate: (raw) =>
      raw === null ||
      (typeof raw === "object" && raw !== null && typeof raw.id === "string") ||
      "Expected profile object or null",
    normalize: (raw) => (raw === null ? null : { id: raw.id.trim(), ver: raw.ver ?? 1 }),
    equals: (a, b) => (a?.id ?? null) === (b?.id ?? null),
  });

  assert.equal(isPersistedFieldDef(viewDef), false);
  assert.equal(isPersistedFieldDef(externalDef), false);
  assert.equal(isPersistedFieldDef(pickerDef), true);

  const schema = defineSettings({
    id: "v05-fields",
    title: "v0.5 Fields",
    scopes: ["global", "project"],
    normalizeDraft(draft, changedKey) {
      if (changedKey === "enabled" && !draft.enabled) {
        return { ...draft, profile: null };
      }
      return draft;
    },
    fields: {
      enabled: field.boolean({ label: "Enabled", default: true }),
      profile: pickerDef,
      preview: viewDef,
      rules: externalDef,
    },
  });

  // fieldKeys includes all; persistedFieldKeys excludes view and external
  assert.deepEqual(schema.fieldKeys, ["enabled", "profile", "preview", "rules"]);
  assert.deepEqual(schema.persistedFieldKeys, ["enabled", "profile"]);
  assert.deepEqual(schema.getDefaults(), { enabled: true, profile: null });
  assert.equal("preview" in schema.defaults, false);
  assert.equal("rules" in schema.defaults, false);

  // getFieldsForTab includes all fields for UI rendering
  assert.deepEqual(
    schema.getFieldsForTab("general").map((entry) => entry.key),
    ["enabled", "profile", "preview", "rules"],
  );

  // isFieldAllowedInScope
  assert.equal(schema.isFieldAllowedInScope("enabled", "global"), true);
  assert.equal(schema.isFieldAllowedInScope("enabled", "project"), true);
  assert.equal(schema.isFieldAllowedInScope("preview", "global"), true);
  assert.equal(schema.isFieldAllowedInScope("preview", "project"), false);
  assert.equal(schema.isFieldAllowedInScope("rules", "global"), false);
  assert.equal(schema.isFieldAllowedInScope("rules", "project"), true);
  assert.equal(schema.isFieldAllowedInScope("unknown", "global"), false);

  // Picker validation, normalization, formatting, tone, and custom equals in diffForScope
  assert.deepEqual(schema.validateField("profile", { id: "  fast  " }), {
    ok: true,
    value: { id: "fast", ver: 1 },
  });
  assert.deepEqual(schema.validateField("profile", 123), {
    ok: false,
    error: "Expected profile object or null",
  });
  assert.equal(schema.formatFieldValue("profile", null), "Default profile");
  assert.equal(schema.getFieldTone("profile", null), "muted");
  assert.equal(schema.getFieldTone("profile", { id: "fast", ver: 1 }), "accent");

  // Custom equals treats { id: "fast", ver: 2 } as equal to global { id: "fast", ver: 1 }
  assert.deepEqual(
    schema.diffForScope(
      { enabled: true, profile: { id: "fast", ver: 2 } },
      "project",
      { global: { profile: { id: "fast", ver: 1 } }, project: {} },
    ),
    {},
  );

  // Non-persisted fields fail validation and are rejected in validatePartial
  assert.equal(validateFieldValue(viewDef, "anything").ok, false);
  assert.equal(validateFieldValue(externalDef, "anything").ok, false);
  assert.equal(schema.validateField("preview", "anything").ok, false);
  const partialRes = schema.validatePartial({
    enabled: false,
    preview: "should-reject",
    rules: "should-reject",
  });
  assert.deepEqual(partialRes.values, { enabled: false });
  assert.deepEqual(partialRes.rejectedKeys.sort(), ["preview", "rules"]);

  // resolveEffective and computeProvenance exclude view and external
  const eff = schema.resolveEffective({ global: { enabled: false }, project: {} });
  assert.deepEqual(eff, { enabled: false, profile: null });
  const prov = schema.computeProvenance({ global: { enabled: false }, project: {} });
  assert.deepEqual(prov, { enabled: "global", profile: "default" });

  // Format and tone for view/external
  assert.equal(schema.getFieldLabel("preview"), "Preview (on)");
  assert.equal(schema.formatFieldValue("preview", undefined), "Ready");
  assert.equal(schema.getFieldTone("preview", undefined), "accent");
  assert.equal(
    schema.formatFieldValue("preview", undefined, { enabled: false, profile: null }),
    "Paused",
  );
  assert.equal(
    schema.getFieldTone("preview", undefined, { enabled: false, profile: null }),
    "muted",
  );
  assert.equal(schema.formatFieldValue("rules", undefined), "3 rules");
  assert.equal(schema.getFieldTone("rules", undefined), "default");

  // normalizeDraft exposed on schema
  assert.equal(typeof schema.normalizeDraft, "function");
  const normalized = schema.normalizeDraft(
    { enabled: false, profile: { id: "fast", ver: 1 } },
    "enabled",
    { enabled: true, profile: { id: "fast", ver: 1 } },
  );
  assert.deepEqual(normalized, { enabled: false, profile: null });

  // Schema-level scope check in isFieldAllowedInScope
  const globalOnlySchema = defineSettings({
    id: "global-only",
    title: "Global Only",
    scopes: ["global"],
    fields: {
      flag: field.boolean({ label: "Flag", default: true }),
    },
  });
  assert.equal(globalOnlySchema.isFieldAllowedInScope("flag", "global"), true);
  assert.equal(globalOnlySchema.isFieldAllowedInScope("flag", "project"), false);
});
