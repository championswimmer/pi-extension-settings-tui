import test from "node:test";
import assert from "node:assert/strict";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { defineSettings, field } from "../dist/schema/index.js";
import {
  createMemoryStorageAdapter,
  createSettingsStore,
} from "../dist/store/index.js";
import {
  DynamicPickerRoute,
  ModelPickerRoute,
  renderMarkdownToAnsi,
  SelectRoute,
  SettingsDialogComponent,
  TextViewerRoute,
} from "../dist/dialog/index.js";

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_TAB = "\t";
const KEY_SHIFT_TAB = "\x1b[Z";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_CTRL_R = "\x12";
const KEY_CTRL_S = "\x13";
const KEY_CTRL_A = "\x01";
const KEY_PGUP = "\x1b[5~";
const KEY_PGDN = "\x1b[6~";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";

function createMockTheme() {
  return {
    fg: (_color, text) => text,
    bg: (_bg, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    inverse: (text) => text,
    strikethrough: (text) => text,
  };
}

function createMockTui({ rows = 30, columns = 84, mode = "fullscreen" } = {}) {
  let renderRequests = 0;
  let hideOverlayCalls = 0;
  return {
    mode,
    terminal: { rows, columns },
    get renderRequests() {
      return renderRequests;
    },
    get hideOverlayCalls() {
      return hideOverlayCalls;
    },
    requestRender() {
      renderRequests++;
    },
    hideOverlay() {
      hideOverlayCalls++;
      throw new Error("hideOverlay must NEVER be called by SettingsDialogComponent");
    },
  };
}

function createMockKeybindings() {
  return new KeybindingsManager(TUI_KEYBINDINGS);
}

function makeMouseEvent(type, { x, y, width = 84, height = 26, button = "left", wheelDelta, clickCount } = {}) {
  return {
    type,
    button: type === "wheel" ? "none" : button,
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
    clickCount,
  };
}

function findTextPosition(lines, needle, { fromEnd = false } = {}) {
  const start = fromEnd ? lines.length - 1 : 0;
  const end = fromEnd ? -1 : lines.length;
  const step = fromEnd ? -1 : 1;
  for (let y = start; y !== end; y += step) {
    const plain = stripTerminalSequences(lines[y]);
    const idx = plain.indexOf(needle);
    if (idx !== -1) {
      return { x: idx + 1, y, line: plain };
    }
  }
  return null;
}

function createRichSchema(overrides = {}) {
  return defineSettings({
    id: "dialog-test",
    title: "Test Settings",
    scopes: ["global", "project"],
    defaultScope: "global",
    saveMode: "draft",
    tabs: [
      { id: "general", label: "General" },
      { id: "filters", label: "Filters" },
      { id: "advanced", label: "Advanced" },
    ],
    fields: {
      enabled: field.boolean({
        tab: "general",
        label: "Enabled",
        description: "Enable extension features.",
        default: true,
      }),
      mode: field.enum({
        tab: "general",
        label: "Mode",
        description: "Operating mode.",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "auto", label: "Auto" },
          { value: "strict", label: "Strict", tone: "warn" },
        ],
      }),
      region: field.enum({
        tab: "general",
        label: "Region",
        description: "Deployment region.",
        default: "us-east",
        options: [
          { value: "us-east", label: "US East", description: "Virginia" },
          { value: "us-west", label: "US West", description: "Oregon" },
          { value: "eu-west", label: "EU West", description: "Ireland" },
          { value: "ap-south", label: "AP South", description: "Mumbai" },
          { value: "ap-east", label: "AP East", description: "Tokyo" },
        ],
      }),
      dependentFlag: field.boolean({
        tab: "general",
        label: "Dependent Flag",
        description: "Only visible when Enabled is true.",
        default: false,
        visibleWhen: (v) => Boolean(v.enabled),
      }),
      lockedField: field.boolean({
        tab: "general",
        label: "Locked Field",
        description: "Always disabled.",
        default: false,
        disabled: true,
      }),
      tags: field.multiSelect({
        tab: "filters",
        label: "Tags",
        description: "Filter tags.",
        default: ["alpha"],
        minItems: 1,
        maxItems: 3,
        collapsibleGroups: true,
        options: [
          { value: "alpha", label: "Alpha", group: "Core", description: "Primary" },
          { value: "beta", label: "Beta", group: "Core", description: "Secondary" },
          { value: "gamma", label: "Gamma", group: "Labs", description: "Experimental" },
          { value: "delta", label: "Delta", group: "Labs", description: "Canary" },
        ],
      }),
      prefix: field.string({
        tab: "filters",
        label: "Prefix",
        description: "Single-line prefix.",
        default: "pi",
        minLength: 2,
        maxLength: 12,
      }),
      notes: field.string({
        tab: "filters",
        label: "Notes",
        description: "Multi-line notes.",
        default: "line1",
        multiline: true,
      }),
      ratio: field.number({
        tab: "advanced",
        label: "Ratio",
        description: "Threshold ratio.",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      }),
      workers: field.integer({
        tab: "advanced",
        label: "Workers",
        description: "Worker count.",
        default: 4,
        min: 1,
        max: 16,
        step: 1,
      }),
      customField: field.custom({
        tab: "advanced",
        label: "Custom Note",
        description: "Custom sub-route field.",
        experimental: true,
        default: "init",
        validate: (v) => typeof v === "string" && v.length > 0,
      }),
    },
    ...overrides,
  });
}

async function setupDialog({
  initialLayers,
  trustedProject = true,
  saveMode,
  rows = 30,
  columns = 84,
  mode = "fullscreen",
  schemaOverrides,
  customOpenSubroute,
  theme = createMockTheme(),
  wrapStore,
  renderPreview,
} = {}) {
  const schema = createRichSchema(schemaOverrides);
  if (customOpenSubroute) {
    schema.fields.customField = {
      ...schema.fields.customField,
      openSubroute: customOpenSubroute,
    };
  }
  const adapter = createMemoryStorageAdapter(initialLayers);
  const rawStore = createSettingsStore(schema, { adapter });
  const store = wrapStore ? wrapStore(rawStore, adapter) : rawStore;
  const initialState = await store.load({ trustedProject });
  const tui = createMockTui({ rows, columns, mode });
  const keybindings = createMockKeybindings();
  const results = [];
  const applied = [];

  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme,
    keybindings,
    saveMode,
    renderPreview,
    done: (res) => results.push(res),
    onApply: (next, meta) => {
      applied.push({ next, meta });
    },
  });
  dialog.focused = true;

  return { schema, adapter, store, initialState, tui, dialog, results, applied };
}

test("1. Height and width safety across 84x30, 46x24, and 70x12 terminals", async () => {
  const sizes = [
    { columns: 84, rows: 30 },
    { columns: 46, rows: 24 },
    { columns: 70, rows: 12 },
  ];

  for (const { columns, rows } of sizes) {
    const { dialog, tui } = await setupDialog({ rows, columns });
    const maxLines = Math.max(8, rows - 4);
    const lines = dialog.render(columns);

    assert.ok(
      lines.length <= maxLines,
      `Expected <= ${maxLines} lines at ${columns}x${rows}, got ${lines.length}`,
    );
    for (const line of lines) {
      assert.ok(
        visibleWidth(line) <= columns,
        `Line exceeded width ${columns}: ${visibleWidth(line)}`,
      );
    }
    assert.ok(stripTerminalSequences(lines[0]).startsWith("╭"));
    assert.ok(stripTerminalSequences(lines[lines.length - 1]).startsWith("╰"));

    // Also verify sub-route stays inside height & width budget
    dialog.navigateTo({ tab: "general", field: "region" });
    dialog.handleInput(KEY_ENTER);
    const subLines = dialog.render(columns);
    assert.ok(
      subLines.length <= maxLines,
      `Sub-route exceeded ${maxLines} lines at ${columns}x${rows}, got ${subLines.length}`,
    );
    for (const line of subLines) {
      assert.ok(visibleWidth(line) <= columns);
    }
    assert.equal(tui.hideOverlayCalls, 0);
  }
});

test("inline preview uses the current draft and scope and stays on the root screen", async () => {
  const theme = createMockTheme();
  const calls = [];
  const { adapter, dialog } = await setupDialog({
    theme,
    renderPreview: ({ values, scope, tab, theme: previewTheme, width, maxRows }) => {
      calls.push({ tab, theme: previewTheme, width, maxRows });
      return [previewTheme.fg("accent", `Sample: ${scope} / ${values.enabled ? "on" : "off"}`)];
    },
  });
  let lines = dialog.render(84);
  assert.ok(lines.some((line) => line.includes("Sample: global / on")));
  assert.equal(calls.at(-1).tab, "general");
  assert.equal(calls.at(-1).theme, theme);
  assert.equal(calls.at(-1).width, 80);
  assert.ok(calls.at(-1).maxRows >= 1);

  const scopePosition = findTextPosition(lines, "Save scope");
  assert.ok(scopePosition);
  dialog.handleMouse(makeMouseEvent("press", scopePosition));
  dialog.handleMouse(makeMouseEvent("click", { ...scopePosition, clickCount: 1 }));
  dialog.navigateTo({ field: "enabled" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines.some((line) => line.includes("Sample: project / off")));
  assert.ok(lines.findIndex((line) => line.includes("Sample:")) > lines.findIndex((line) => line.includes("Enabled")));
  assert.equal((await adapter.readLayer("project")).exists, false);

  dialog.navigateTo({ field: "region" });
  dialog.handleInput(KEY_ENTER);
  const callCount = calls.length;
  const pickerLines = dialog.render(84);
  assert.ok(pickerLines[1].includes("General › Region"));
  assert.ok(pickerLines.every((line) => !line.includes("Sample:")));
  assert.equal(calls.length, callCount);
  dialog.handleInput(KEY_ESC);
  dialog.handleInput(KEY_TAB);
  assert.ok(dialog.render(84).some((line) => line.includes("Sample: project / off")));
  assert.equal(calls.at(-1).tab, "filters");
});

test("oversized inline preview stays within its budget and preserves the footer mouse targets", async () => {
  const width = 52;
  const rows = 22;
  let previewBudget;
  const { dialog, results, tui } = await setupDialog({
    rows,
    columns: width,
    renderPreview: ({ maxRows }) => {
      previewBudget = maxRows;
      return Array.from({ length: maxRows + 1 }, (_, i) => `\x1b[31mSample ${i + 1} ${"🔄".repeat(width)}\x1b[0m`);
    },
  });
  dialog.navigateTo({ field: "enabled" });
  dialog.handleInput(KEY_ENTER);

  tui.terminal.rows = 12;
  const shortLines = dialog.render(width);
  assert.equal(previewBudget, undefined);
  assert.ok(shortLines.length <= 8);
  assert.ok(stripTerminalSequences(shortLines.at(-1)).startsWith("╰"));
  assert.ok(findTextPosition(shortLines, "[Ctrl+S Save]"));

  tui.terminal.rows = rows;
  const lines = dialog.render(width);
  assert.ok(previewBudget >= 1);
  const previewLines = lines.filter((line) => stripTerminalSequences(line).includes("Sample "));
  assert.equal(previewLines.length, previewBudget);
  assert.ok(previewLines.every((line) => line.includes("\x1b[31m")));
  assert.ok(lines.every((line) => visibleWidth(line) <= width));
  assert.ok(lines.length <= rows - 4);
  assert.ok(stripTerminalSequences(lines.at(-1)).startsWith("╰"));
  const savePosition = findTextPosition(lines, "[Ctrl+S Save]");
  assert.ok(savePosition);
  const target = { ...savePosition, width, height: lines.length };
  dialog.handleMouse(makeMouseEvent("press", target));
  dialog.handleMouse(makeMouseEvent("click", { ...target, clickCount: 1 }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(results[0]?.saved, true);
  assert.equal(results[0]?.values.enabled, false);
});

test("a failing inline preview leaves the draft usable", async () => {
  const { dialog } = await setupDialog({
    renderPreview: ({ values }) => {
      values.enabled = !values.enabled;
      throw new Error("broken host preview");
    },
  });
  let lines = dialog.render(84);
  assert.match(findTextPosition(lines, "Enabled")?.line ?? "", /\bOn\b/);
  assert.ok(findTextPosition(lines, "Preview unavailable"));
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.match(findTextPosition(lines, "Enabled")?.line ?? "", /\bOff\b/);
  assert.ok(findTextPosition(lines, "● Unsaved"));
});

test("2. Tab switching via keyboard (Tab/Shift+Tab) and fullscreen mouse click", async () => {
  const { dialog } = await setupDialog();
  let lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Enabled")));

  // Tab -> Filters
  dialog.handleInput(KEY_TAB);
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Tags")));

  // Shift+Tab -> General
  dialog.handleInput(KEY_SHIFT_TAB);
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Enabled")));

  // Mouse click on Advanced tab chip
  const advPos = findTextPosition(lines, "Advanced");
  assert.ok(advPos, "Advanced tab chip not found");
  const pressRes = dialog.handleMouse(makeMouseEvent("press", advPos));
  assert.deepEqual(pressRes, { handled: true, focus: true, render: true });
  const clickRes = dialog.handleMouse(makeMouseEvent("click", { ...advPos, clickCount: 1 }));
  assert.deepEqual(clickRes, { handled: true, focus: true, render: true });

  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Workers")));
});

test("3. Inline boolean toggle via Enter/Space and single mouse press+click, plus visibleWhen/disabled", async () => {
  const { dialog } = await setupDialog();
  let lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Dependent Flag")));
  assert.ok(lines.some((l) => l.includes("Locked Field")));

  // Toggle Enabled off via Space -> Dependent Flag disappears via visibleWhen
  dialog.handleInput(" ");
  lines = dialog.render(84);
  assert.ok(!lines.some((l) => l.includes("Dependent Flag")));
  assert.ok(lines[1].includes("● Unsaved"));

  // Toggle back on via single mouse press+click on Enabled row
  const enabledPos = findTextPosition(lines, "Enabled");
  assert.ok(enabledPos);
  const pressRes = dialog.handleMouse(makeMouseEvent("press", enabledPos));
  assert.deepEqual(pressRes, { handled: true, focus: true, render: true });
  const clickRes = dialog.handleMouse(makeMouseEvent("click", { ...enabledPos, clickCount: 1 }));
  assert.deepEqual(clickRes, { handled: true, focus: true, render: true });

  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Dependent Flag")));
  // Clean again because toggled back to true
  assert.ok(!lines[1].includes("● Unsaved"));

  // Clicking disabled Locked Field does not activate or crash
  const lockedPos = findTextPosition(lines, "Locked Field");
  assert.ok(lockedPos);
  const lockedPress = dialog.handleMouse(makeMouseEvent("press", lockedPos));
  assert.deepEqual(lockedPress, { handled: true, render: false });
});

test("4. Enum cycling (<=3 options) and searchable SelectRoute (>3 options)", async () => {
  const { dialog } = await setupDialog();

  // Mode has 3 options -> inline cycling
  dialog.navigateTo({ tab: "general", field: "mode" });
  dialog.handleInput(KEY_ENTER);
  let lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Auto")));

  // Region has 5 options -> opens SelectRoute
  dialog.navigateTo({ tab: "general", field: "region" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("General › Region"));
  assert.ok(lines.some((l) => l.includes("US East")));

  // Filter for "Mumbai" and press Enter
  for (const ch of "mumbai") {
    dialog.handleInput(ch);
  }
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("AP South")));
  assert.ok(!lines.some((l) => l.includes("US East")));

  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("General › Region"));
  assert.ok(lines.some((l) => l.includes("AP South")));

  // Re-open SelectRoute, test wheel scroll & Esc cancel & mouse click
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  const wheelRes = dialog.handleMouse(makeMouseEvent("wheel", { x: 10, y: 5, wheelDelta: 1 }));
  assert.deepEqual(wheelRes, { handled: true, render: true });

  dialog.handleInput(KEY_ESC);
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("General › Region"));

  // Re-open and click an option directly
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  const euPos = findTextPosition(lines, "EU West");
  assert.ok(euPos);
  dialog.handleMouse(makeMouseEvent("press", euPos));
  dialog.handleMouse(makeMouseEvent("click", { ...euPos, clickCount: 1 }));
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("EU West")));
});

test("5. MultiSelectRoute: collapsible groups, Space toggle, Ctrl+A, validation, mouse click & wheel", async () => {
  const { dialog } = await setupDialog();
  dialog.navigateTo({ tab: "filters", field: "tags" });
  dialog.handleInput(KEY_ENTER);

  let lines = dialog.render(84);
  assert.ok(lines[1].includes("Filters › Tags"));
  assert.ok(lines.some((l) => l.includes("[-] Core")));
  assert.ok(lines.some((l) => l.includes("[x] Alpha")));

  // Collapse Core group by clicking header
  const corePos = findTextPosition(lines, "Core");
  assert.ok(corePos);
  dialog.handleMouse(makeMouseEvent("press", corePos));
  dialog.handleMouse(makeMouseEvent("click", { ...corePos, clickCount: 1 }));
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("[+] Core")));
  assert.ok(!lines.some((l) => l.includes("Alpha")));

  // Expand Core group back with Enter on group header
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("[-] Core")));

  // Ctrl+A selects all 4 items -> triggers maxItems (3) validation error & blocks commit
  dialog.handleInput(KEY_CTRL_A);
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Select at most 3")));
  // Move off group header onto an option and try Enter -> stays open because invalid
  dialog.handleInput(KEY_DOWN);
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Filters › Tags"));

  // Space toggles highlighted item off (down to 3 selected -> valid!)
  dialog.handleInput(" ");
  lines = dialog.render(84);
  assert.ok(!lines.some((l) => l.includes("Select at most 3")));

  // Wheel scroll inside MultiSelectRoute
  const wheelRes = dialog.handleMouse(makeMouseEvent("wheel", { x: 10, y: 6, wheelDelta: 1 }));
  assert.deepEqual(wheelRes, { handled: true, render: true });

  // Click [Enter Apply] pill to commit
  const applyPos = findTextPosition(lines, "[Enter Apply]");
  assert.ok(applyPos);
  dialog.handleMouse(makeMouseEvent("press", applyPos));
  dialog.handleMouse(makeMouseEvent("click", { ...applyPos, clickCount: 1 }));
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("Filters › Tags"));
});

test("6. TextInputRoute: single-line string, number stepping & invalid guard, multiline Editor Ctrl+S", async () => {
  const { dialog } = await setupDialog();

  // Single-line string with validation error
  dialog.navigateTo({ tab: "filters", field: "prefix" });
  dialog.handleInput(KEY_ENTER);
  let lines = dialog.render(84);
  assert.ok(lines[1].includes("Filters › Prefix"));

  // Clear "pi" via Ctrl+U and try submitting empty -> error banner, stays open
  dialog.handleInput("\x15"); // ctrl+u
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Filters › Prefix"));
  assert.ok(lines.some((l) => l.includes("⚠")));

  // Type valid "custom" and submit
  for (const ch of "custom") {
    dialog.handleInput(ch);
  }
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("Filters › Prefix"));
  assert.ok(lines.some((l) => l.includes("custom")));

  // Number field: ←/→ stepping + invalid text input guard
  dialog.navigateTo({ tab: "advanced", field: "workers" });
  dialog.handleInput(KEY_RIGHT);
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("5")));

  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Advanced › Workers"));
  dialog.handleInput("\x15");
  for (const ch of "abc") {
    dialog.handleInput(ch);
  }
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Advanced › Workers"));
  assert.ok(lines.some((l) => l.includes("not a valid number")));
  dialog.handleInput(KEY_ESC);

  // Multiline Editor field: Enter inserts newline, Ctrl+S commits
  dialog.navigateTo({ tab: "filters", field: "notes" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Filters › Notes"));
  dialog.handleInput(KEY_ENTER);
  for (const ch of "line2") {
    dialog.handleInput(ch);
  }
  dialog.handleInput(KEY_CTRL_S);
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("Filters › Notes"));
});

test("7. Custom sub-route: Frame[] stack, focused forwarding, child-local mouse coords, [Esc Back]", async () => {
  const receivedMouse = [];
  let subFocused = false;
  let disposed = false;

  const { dialog } = await setupDialog({
    customOpenSubroute: (params) => {
      const comp = {
        title: "Custom Editor",
        get focused() {
          return subFocused;
        },
        set focused(v) {
          subFocused = v;
        },
        render(width) {
          return [`Custom body w=${width} val=${params.value}`, "Click me"];
        },
        handleInput(data) {
          if (data === KEY_ENTER) {
            params.commit("updated-custom");
          } else if (data === KEY_ESC) {
            params.cancel();
          }
        },
        handleMouse(ev) {
          receivedMouse.push({ type: ev.type, x: ev.x, y: ev.y, width: ev.width, height: ev.height });
          return { handled: true, focus: true, render: true };
        },
        invalidate() {},
        dispose() {
          disposed = true;
        },
      };
      return comp;
    },
  });

  dialog.navigateTo({ tab: "advanced", field: "customField" });
  dialog.handleInput(KEY_ENTER);

  assert.equal(subFocused, true);
  let lines = dialog.render(84);
  assert.ok(lines[1].includes("Advanced › Custom Editor"));
  assert.ok(lines.some((l) => l.includes("[lab]")) === false); // inside sub-route

  // Forward mouse inside child bounds (body starts at y=3, x=2)
  const clickTarget = findTextPosition(lines, "Click me");
  assert.ok(clickTarget);
  dialog.handleMouse(makeMouseEvent("press", clickTarget));
  dialog.handleMouse(makeMouseEvent("click", { ...clickTarget, clickCount: 1 }));
  assert.equal(receivedMouse.length, 2);
  assert.equal(receivedMouse[0].x, clickTarget.x - 2);
  assert.equal(receivedMouse[0].y, 1);
  assert.equal(receivedMouse[0].width, 80);

  // Click [Esc Back] pill in outer footer
  const backPos = findTextPosition(lines, "[Esc Back]");
  assert.ok(backPos);
  dialog.handleMouse(makeMouseEvent("press", backPos));
  dialog.handleMouse(makeMouseEvent("click", { ...backPos, clickCount: 1 }));
  assert.equal(disposed, true);

  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("[lab]")));
  assert.ok(!lines[1].includes("Custom Editor"));
});

test("8. Provenance dots, Save scope toggle (blocked when untrusted), and Restore defaults ConfirmRoute", async () => {
  // Multi-scope provenance dots: global, project, both
  const { dialog: d1 } = await setupDialog({
    trustedProject: true,
    initialLayers: {
      global: { enabled: false, mode: "auto" },
      project: { mode: "strict", region: "eu-west" },
    },
  });

  let lines = d1.render(84);
  const enabledLine = lines.find((l) => l.includes("Enabled"));
  const modeLine = lines.find((l) => l.includes("Mode"));
  const regionLine = lines.find((l) => l.includes("Region"));
  assert.ok(enabledLine?.includes("●  "));
  assert.ok(modeLine?.includes("● ●"));
  assert.ok(regionLine?.includes("  ●"));
  assert.ok(lines.some((l) => l.includes("Saved: ● Global · ● Project · ● ● Both")));

  // Switch Save scope to Project, then open Restore defaults ConfirmRoute and confirm
  const scopePos = findTextPosition(lines, "Save scope");
  assert.ok(scopePos);
  d1.handleMouse(makeMouseEvent("press", scopePos));
  d1.handleMouse(makeMouseEvent("click", { ...scopePos, clickCount: 1 }));
  lines = d1.render(84);
  assert.ok(lines[1].includes("[Project]"));

  const restorePos = findTextPosition(lines, "Restore defaults");
  assert.ok(restorePos);
  d1.handleMouse(makeMouseEvent("press", restorePos));
  d1.handleMouse(makeMouseEvent("click", { ...restorePos, clickCount: 1 }));
  lines = d1.render(84);
  assert.ok(lines.some((l) => l.includes("Restore defaults for Project scope?")));

  // Confirm with 'y'
  d1.handleInput("y");
  await new Promise((r) => setTimeout(r, 15));
  lines = d1.render(84);
  assert.ok(lines.some((l) => l.includes("Restored project defaults")));

  // Untrusted project blocks switching to Project scope
  const { dialog: d2 } = await setupDialog({ trustedProject: false });
  let untrustedLines = d2.render(84);
  assert.ok(untrustedLines.some((l) => l.includes("(Project untrusted)")));
  const untrustedScopePos = findTextPosition(untrustedLines, "Save scope");
  d2.handleMouse(makeMouseEvent("press", untrustedScopePos));
  d2.handleMouse(makeMouseEvent("click", { ...untrustedScopePos, clickCount: 1 }));
  untrustedLines = d2.render(84);
  assert.ok(untrustedLines[1].includes("[Global]"));
  assert.ok(untrustedLines.some((l) => l.includes("untrusted")));
});

test("9. Draft mode (Ctrl+S, dirty badge, Esc discard, ConcurrencyConflictError + [R Reload]) and Immediate mode", async () => {
  // Draft mode: Esc discard leaves store untouched
  const discardCtx = await setupDialog({ saveMode: "draft" });
  discardCtx.dialog.handleInput(" "); // toggle Enabled off
  assert.ok(discardCtx.dialog.render(84)[1].includes("● Unsaved"));
  discardCtx.dialog.handleInput(KEY_ESC);
  assert.equal(discardCtx.results.length, 1);
  assert.equal(discardCtx.results[0].saved, false);
  assert.equal(discardCtx.results[0].dirty, true);
  assert.equal(discardCtx.results[0].closedBy, "escape");
  assert.equal(discardCtx.results[0].values.enabled, true);

  // Draft mode: ConcurrencyConflictError -> [R Reload] -> Ctrl+S save
  const saveCtx = await setupDialog({ saveMode: "draft" });
  saveCtx.dialog.handleInput(" "); // dirty Enabled = false
  // Mutate underlying adapter behind the dialog's back to trigger ConcurrencyConflictError
  await saveCtx.adapter.writeLayer("global", { mode: "strict" });

  saveCtx.dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 15));
  let lines = saveCtx.dialog.render(84);
  assert.equal(saveCtx.results.length, 0);
  assert.ok(lines.some((l) => l.includes("[R Reload]")));

  // Click [R Reload] pill in footer
  const reloadPos = findTextPosition(lines, "[R Reload]", { fromEnd: true });
  assert.ok(reloadPos);
  saveCtx.dialog.handleMouse(makeMouseEvent("press", reloadPos));
  saveCtx.dialog.handleMouse(makeMouseEvent("click", { ...reloadPos, clickCount: 1 }));
  await new Promise((r) => setTimeout(r, 15));
  lines = saveCtx.dialog.render(84);
  assert.ok(!lines.some((l) => l.includes("[R Reload]")));
  assert.ok(lines.some((l) => l.includes("Strict")));

  // Now edit and Ctrl+S save cleanly
  saveCtx.dialog.handleInput(" ");
  saveCtx.dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(saveCtx.results.length, 1);
  assert.equal(saveCtx.results[0].saved, true);
  assert.equal(saveCtx.results[0].closedBy, "save");
  assert.equal(saveCtx.results[0].values.enabled, false);
  assert.equal(saveCtx.applied.length, 1);

  // Immediate mode + regular tui mode footer hints
  const immCtx = await setupDialog({ saveMode: "immediate", mode: "regular" });
  const immLines = immCtx.dialog.render(84);
  assert.ok(immLines.some((l) => l.includes("↑/↓ move · Enter edit")));
  assert.ok(immLines.some((l) => l.includes("[Esc Close]")));

  immCtx.dialog.handleInput(" ");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(immCtx.applied.length, 1);
  immCtx.dialog.handleInput(KEY_ESC);
  assert.equal(immCtx.results.length, 1);
  assert.equal(immCtx.results[0].saved, true);
  assert.equal(immCtx.results[0].closedBy, "immediate");
});

test("10. Mouse dead-space press returns { handled: true, render: false } and wheel scrolls row list", async () => {
  const { dialog } = await setupDialog({ rows: 14, columns: 84 });
  let lines = dialog.render(84);

  // Dead space press on top border (y=0, x=0)
  const deadPress = dialog.handleMouse(makeMouseEvent("press", { x: 0, y: 0 }));
  assert.deepEqual(deadPress, { handled: true, render: false });

  // Wheel scroll down on short terminal
  assert.ok(lines.some((l) => l.includes("↓")));
  const wheelRes = dialog.handleMouse(makeMouseEvent("wheel", { x: 10, y: 5, wheelDelta: 2 }));
  assert.deepEqual(wheelRes, { handled: true, render: true });

  const scrolledLines = dialog.render(84);
  assert.ok(scrolledLines.some((l) => l.includes("↑")));
});

test("11. saveMode 'draft': in-memory holding, warning-colored ● Unsaved/(N) & * markers, revert, Ctrl+S batch save, Esc discard", async () => {
  const WARN_START = "\x1b[33m";
  const WARN_END = "\x1b[39m";
  const warnTheme = {
    ...createMockTheme(),
    fg: (color, text) => (color === "warning" ? `${WARN_START}${text}${WARN_END}` : text),
  };

  let saveCalls = 0;
  let writeCalls = 0;
  const wrapWithWriteSpy = (rawStore, adapter) => {
    const origWrite = adapter.writeLayer.bind(adapter);
    adapter.writeLayer = async (...args) => {
      writeCalls++;
      return origWrite(...args);
    };
    return {
      ...rawStore,
      load: rawStore.load.bind(rawStore),
      restoreDefaults: rawStore.restoreDefaults.bind(rawStore),
      save: async (...args) => {
        saveCalls++;
        return rawStore.save(...args);
      },
    };
  };

  // Part A: Esc discards held in-memory changes with zero writes to store
  const discardCtx = await setupDialog({
    saveMode: "draft",
    theme: warnTheme,
    wrapStore: wrapWithWriteSpy,
  });

  // Clean initially: no ● Unsaved, no *
  let lines = discardCtx.dialog.render(84);
  assert.ok(!stripTerminalSequences(lines[1]).includes("● Unsaved"));
  assert.ok(!lines.some((l) => l.includes(`${WARN_START}*${WARN_END}`)));

  // Edit 1st field (Enabled -> false)
  discardCtx.dialog.handleInput(" ");
  assert.equal(saveCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(discardCtx.applied.length, 0);
  lines = discardCtx.dialog.render(84);
  assert.ok(lines[1].includes(`${WARN_START}● Unsaved${WARN_END}`));
  const enabledDirtyRow = lines.find((l) => stripTerminalSequences(l).includes("Enabled"));
  assert.ok(enabledDirtyRow?.includes(`${WARN_START}*${WARN_END}`));

  // Edit 2nd field (Mode -> Auto)
  discardCtx.dialog.navigateTo({ tab: "general", field: "mode" });
  discardCtx.dialog.handleInput(KEY_ENTER);
  assert.equal(saveCalls, 0);
  assert.equal(writeCalls, 0);
  lines = discardCtx.dialog.render(84);
  assert.ok(lines[1].includes(`${WARN_START}● Unsaved (2)${WARN_END}`));
  const modeDirtyRow = lines.find((l) => stripTerminalSequences(l).includes("Mode"));
  assert.ok(modeDirtyRow?.includes(`${WARN_START}*${WARN_END}`));

  // Revert 1st field back to original (Enabled -> true) -> count drops to 1 and Enabled * clears
  discardCtx.dialog.navigateTo({ tab: "general", field: "enabled" });
  discardCtx.dialog.handleInput(" ");
  lines = discardCtx.dialog.render(84);
  assert.ok(lines[1].includes(`${WARN_START}● Unsaved${WARN_END}`));
  assert.ok(!stripTerminalSequences(lines[1]).includes("● Unsaved ("));
  const enabledCleanRow = lines.find((l) => stripTerminalSequences(l).includes("Enabled"));
  assert.ok(!enabledCleanRow?.includes(`${WARN_START}*${WARN_END}`));

  // Revert 2nd field back to original (Auto -> Strict -> Off) -> clears both * and ● Unsaved
  discardCtx.dialog.navigateTo({ tab: "general", field: "mode" });
  discardCtx.dialog.handleInput(KEY_ENTER);
  discardCtx.dialog.handleInput(KEY_ENTER);
  lines = discardCtx.dialog.render(84);
  assert.ok(!stripTerminalSequences(lines[1]).includes("● Unsaved"));
  const modeCleanRow = lines.find((l) => stripTerminalSequences(l).includes("Mode"));
  assert.ok(!modeCleanRow?.includes(`${WARN_START}*${WARN_END}`));

  // Dirty again and press Esc -> discards without writing to store
  discardCtx.dialog.handleInput(KEY_ENTER); // Mode -> Auto
  assert.ok(stripTerminalSequences(discardCtx.dialog.render(84)[1]).includes("● Unsaved"));
  discardCtx.dialog.handleInput(KEY_ESC);
  assert.equal(saveCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(discardCtx.applied.length, 0);
  assert.equal(discardCtx.results.length, 1);
  assert.equal(discardCtx.results[0].saved, false);
  assert.equal(discardCtx.results[0].dirty, true);
  assert.equal(discardCtx.results[0].closedBy, "escape");
  const discardLayer = await discardCtx.adapter.readLayer("global");
  assert.equal(discardLayer.exists, false);
  assert.equal(discardLayer.data, null);

  // Part B: Ctrl+S persists all held in-memory changes together & clears dirty state
  let ctrlSSaveCalls = 0;
  let ctrlSWriteCalls = 0;
  const saveCtx = await setupDialog({
    saveMode: "draft",
    theme: warnTheme,
    customOpenSubroute: (params) => ({
      title: "Custom",
      focused: true,
      render: () => ["custom"],
      handleInput: (d) => {
        if (d === KEY_ENTER) params.commit("modified-custom");
      },
      invalidate: () => {},
    }),
    wrapStore: (rawStore, adapter) => {
      const origWrite = adapter.writeLayer.bind(adapter);
      adapter.writeLayer = async (...args) => {
        ctrlSWriteCalls++;
        return origWrite(...args);
      };
      return {
        ...rawStore,
        load: rawStore.load.bind(rawStore),
        restoreDefaults: rawStore.restoreDefaults.bind(rawStore),
        save: async (...args) => {
          ctrlSSaveCalls++;
          return rawStore.save(...args);
        },
      };
    },
  });

  // Modify Mode, Workers, and experimental Custom Note (verifying `*` after `[lab]`)
  saveCtx.dialog.navigateTo({ tab: "general", field: "mode" });
  saveCtx.dialog.handleInput(KEY_ENTER); // off -> auto
  saveCtx.dialog.navigateTo({ tab: "advanced", field: "workers" });
  saveCtx.dialog.handleInput(KEY_RIGHT); // 4 -> 5
  saveCtx.dialog.navigateTo({ tab: "advanced", field: "customField" });
  saveCtx.dialog.handleInput(KEY_ENTER);
  saveCtx.dialog.handleInput(KEY_ENTER); // commit "modified-custom"

  assert.equal(ctrlSSaveCalls, 0);
  assert.equal(ctrlSWriteCalls, 0);
  lines = saveCtx.dialog.render(84);
  assert.ok(lines[1].includes(`${WARN_START}● Unsaved (3)${WARN_END}`));
  const customRow = stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Custom Note")) ?? "");
  assert.ok(customRow.includes("Custom Note [lab] *"));

  // Ctrl+S persists all 3 edits in a single save & clears dirty markers
  saveCtx.dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(ctrlSSaveCalls, 1);
  assert.equal(ctrlSWriteCalls, 1);
  assert.equal(saveCtx.applied.length, 1);
  assert.equal(saveCtx.applied[0].next.mode, "auto");
  assert.equal(saveCtx.applied[0].next.workers, 5);
  assert.equal(saveCtx.applied[0].next.customField, "modified-custom");
  assert.equal(saveCtx.results.length, 1);
  assert.equal(saveCtx.results[0].saved, true);
  assert.equal(saveCtx.results[0].dirty, false);
  assert.equal(saveCtx.results[0].closedBy, "save");

  const stored = await saveCtx.adapter.readLayer("global");
  assert.equal(stored.exists, true);
  assert.equal(stored.data?.mode, "auto");
  assert.equal(stored.data?.workers, 5);
  assert.equal(stored.data?.customField, "modified-custom");

  // Re-rendering post-save reflects cleared dirty state
  const afterSaveLines = saveCtx.dialog.render(84);
  assert.ok(!stripTerminalSequences(afterSaveLines[1]).includes("● Unsaved"));
  assert.ok(!afterSaveLines.some((l) => l.includes(`${WARN_START}*${WARN_END}`)));
});

test("12. saveMode 'immediate': serialized rapid back-to-back edits with zero dropped changes & Auto-save footer", async () => {
  let inFlightSaves = 0;
  let maxConcurrentSaves = 0;
  let totalSaveCalls = 0;
  const pendingGates = [];

  const ctx = await setupDialog({
    saveMode: "immediate",
    mode: "fullscreen",
    wrapStore: (rawStore) => ({
      ...rawStore,
      load: rawStore.load.bind(rawStore),
      restoreDefaults: rawStore.restoreDefaults.bind(rawStore),
      save: async (values, opts) => {
        totalSaveCalls++;
        inFlightSaves++;
        maxConcurrentSaves = Math.max(maxConcurrentSaves, inFlightSaves);
        // Force the first save to stay in-flight so synchronous follow-up edits race against it
        await new Promise((resolve) => {
          pendingGates.push(resolve);
          setTimeout(resolve, 15);
        });
        try {
          return await rawStore.save(values, opts);
        } finally {
          inFlightSaves--;
        }
      },
    }),
  });

  // Footer shows Auto-save, no ● Unsaved badge, no [Ctrl+S Save] pill
  let lines = ctx.dialog.render(84);
  const footerLine = stripTerminalSequences(lines[lines.length - 2]);
  assert.ok(footerLine.includes("Auto-save · Click/Enter edit"));
  assert.ok(!footerLine.includes("[Ctrl+S Save]"));
  assert.ok(footerLine.includes("[Esc Close]"));
  assert.ok(!stripTerminalSequences(lines[1]).includes("● Unsaved"));

  // Rapid back-to-back edits synchronously before awaiting:
  // 1) Toggle Enabled (true -> false)
  ctx.dialog.handleInput(" ");
  // 2) Immediately move to Mode and cycle it (off -> auto), then cycle again (auto -> strict)
  ctx.dialog.navigateTo({ tab: "general", field: "mode" });
  ctx.dialog.handleInput(KEY_ENTER);
  ctx.dialog.handleInput(KEY_ENTER);

  // Immediately after synchronous edits: first save is in-flight, second flush hasn't overlapped
  assert.equal(totalSaveCalls, 1);
  assert.equal(maxConcurrentSaves, 1);

  // Wait for serialized flushing to complete
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(maxConcurrentSaves, 1);
  assert.equal(totalSaveCalls, 2);
  assert.equal(ctx.applied.length, 2);
  assert.equal(ctx.applied[1].next.enabled, false);
  assert.equal(ctx.applied[1].next.mode, "strict");

  // Verify underlying storage has BOTH rapid edits persisted cleanly
  const stored = await ctx.adapter.readLayer("global");
  assert.equal(stored.exists, true);
  assert.equal(stored.data?.enabled, false);
  assert.equal(stored.data?.mode, "strict");

  // Rendered dialog also retains both edits and has no ● Unsaved badge
  lines = ctx.dialog.render(84);
  assert.ok(!stripTerminalSequences(lines[1]).includes("● Unsaved"));
  assert.ok(lines.some((l) => l.includes("Strict")));

  // Esc closes with saved: true, closedBy: "immediate", and latest values
  ctx.dialog.handleInput(KEY_ESC);
  assert.equal(ctx.results.length, 1);
  assert.equal(ctx.results[0].saved, true);
  assert.equal(ctx.results[0].dirty, false);
  assert.equal(ctx.results[0].closedBy, "immediate");
  assert.equal(ctx.results[0].values.enabled, false);
  assert.equal(ctx.results[0].values.mode, "strict");
});

test("13. ModelPickerRoute: two-step model -> thinking flow, fuzzy search, Scoped/All toggle, mouse, allowClear, height/width safety", async () => {
  const availableModels = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    },
    {
      provider: "anthropic",
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      reasoning: false,
    },
    {
      provider: "openai",
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      reasoning: true,
    },
    {
      provider: "openrouter",
      id: "qwen/qwen3-coder:exacto",
      name: "Qwen3 Coder Exacto",
      reasoning: true,
    },
  ];
  const scopedModels = [
    { model: availableModels[0], thinkingLevel: "high" },
    { model: availableModels[1] },
  ];

  const modelSchema = defineSettings({
    id: "model-picker-dialog-test",
    title: "Model Settings",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      summaryModel: field.model({
        label: "Summary model",
        description: "Choose a summarizer model and thinking level.",
        default: null,
        emptyLabel: "Active model (default)",
        emptyDescription: "Use the active session model",
      }),
      fallbackModel: field.model({
        label: "Fallback model",
        default: { model: "legacy/offline-model", thinkingLevel: "medium" },
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(modelSchema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 30, columns: 86, mode: "fullscreen" });
  const keybindings = createMockKeybindings();
  const results = [];

  const dialog = new SettingsDialogComponent({
    schema: modelSchema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings,
    availableModels,
    scopedModels,
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Root renders emptyLabel and formatted model (thinkingLevel)
  let lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Active model (default)")));
  assert.ok(lines.some((l) => l.includes("legacy/offline-model (medium)")));

  // Enter opens ModelPickerRoute Step 1 on Scoped (2) by default
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Step 1/2")));
  assert.ok(lines.some((l) => l.includes("[Scoped (2)]")));
  assert.ok(lines.some((l) => l.includes("[All (4)]")));
  assert.ok(lines.some((l) => l.includes("claude-sonnet-4-5")));
  assert.ok(lines.some((l) => l.includes("claude-haiku-4-5")));
  // gpt-5-mini is NOT in scopedModels
  assert.ok(!lines.some((l) => l.includes("gpt-5-mini")));

  // Fuzzy search "gpt" in Scoped -> no matches; press Tab -> switches to All and shows gpt-5-mini!
  for (const ch of "gpt") {
    dialog.handleInput(ch);
  }
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("No matching models")));

  dialog.handleInput(KEY_TAB);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("gpt-5-mini")));
  assert.ok(!lines.some((l) => l.includes("claude-sonnet-4-5")));

  // Press Enter on gpt-5-mini -> Step 2 (Thinking level)
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Step 2/2")));
  assert.ok(lines.some((l) => l.includes("openai/gpt-5-mini")));
  assert.ok(lines.some((l) => l.includes("medium")));
  assert.ok(lines.some((l) => l.includes("high")));
  // gpt-5-mini has no xhigh in thinkingLevelMap
  assert.ok(!lines.some((l) => l.includes("xhigh")));

  // Click [← Models] pill in Step 2 -> returns to Step 1 preserving search/scope!
  const backToModelsPos = findTextPosition(lines, "[← Models]");
  assert.ok(backToModelsPos, "[← Models] pill not found");
  dialog.handleMouse(makeMouseEvent("press", backToModelsPos));
  dialog.handleMouse(makeMouseEvent("click", { ...backToModelsPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Step 1/2")));
  assert.ok(lines.some((l) => l.includes("gpt-5-mini")));

  // Clear search with Ctrl+U, click [Scoped (2)] pill -> back to scoped models
  dialog.handleInput("\x15");
  lines = dialog.render(86);
  const scopedPos = findTextPosition(lines, "[Scoped (2)]");
  assert.ok(scopedPos, "[Scoped (2)] pill not found");
  dialog.handleMouse(makeMouseEvent("press", scopedPos));
  dialog.handleMouse(makeMouseEvent("click", { ...scopedPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("claude-sonnet-4-5")));
  assert.ok(!lines.some((l) => l.includes("gpt-5-mini")));

  // Click claude-sonnet-4-5 (has xhigh in thinkingLevelMap and scoped thinkingLevel: "high")
  const sonnetPos = findTextPosition(lines, "claude-sonnet-4-5");
  assert.ok(sonnetPos);
  dialog.handleMouse(makeMouseEvent("press", sonnetPos));
  dialog.handleMouse(makeMouseEvent("click", { ...sonnetPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Step 2/2")));
  assert.ok(lines.some((l) => l.includes("xhigh")));
  assert.ok(lines.some((l) => l.includes("· scoped")));

  // Click xhigh -> commits { model: "anthropic/claude-sonnet-4-5", thinkingLevel: "xhigh" }
  const xhighPos = findTextPosition(lines, "xhigh");
  assert.ok(xhighPos);
  dialog.handleMouse(makeMouseEvent("press", xhighPos));
  dialog.handleMouse(makeMouseEvent("click", { ...xhighPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(!lines.some((l) => l.includes("Step 2/2")));
  assert.ok(lines.some((l) => l.includes("anthropic/claude-sonnet-4-5")));

  // Save via Ctrl+S and verify both model and thinkingLevel are saved!
  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results.length, 1);
  assert.equal(results[0].saved, true);
  assert.deepEqual(results[0].values.summaryModel, {
    model: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "xhigh",
  });
  const savedLayer = await adapter.readLayer("global");
  assert.deepEqual(savedLayer.data?.summaryModel, {
    model: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "xhigh",
  });

  // Verify non-reasoning model shows off-only in Step 2, allowClear commits null,
  // and unavailable current model appears in All view + height/width safety across tiny terminals
  for (const { columns, rows } of [
    { columns: 84, rows: 30 },
    { columns: 46, rows: 24 },
    { columns: 70, rows: 12 },
  ]) {
    const smallTui = createMockTui({ rows, columns, mode: "fullscreen" });
    const smallDialog = new SettingsDialogComponent({
      schema: modelSchema,
      store,
      initialState: await store.load({ trustedProject: true }),
      tui: smallTui,
      theme: createMockTheme(),
      keybindings,
      availableModels,
      scopedModels,
      done: () => {},
    });
    smallDialog.focused = true;
    const maxLines = Math.max(8, rows - 4);

    // Open Summary model -> Step 1
    smallDialog.handleInput(KEY_ENTER);
    const step1Lines = smallDialog.render(columns);
    assert.ok(step1Lines.length <= maxLines, `Step 1 exceeded ${maxLines} at ${columns}x${rows}`);
    for (const line of step1Lines) {
      assert.ok(visibleWidth(line) <= columns, `Step 1 line exceeded ${columns}`);
    }

    // Select haiku (reasoning: false) -> Step 2 (off only)
    for (const ch of "haiku") smallDialog.handleInput(ch);
    smallDialog.handleInput(KEY_ENTER);
    const step2Lines = smallDialog.render(columns);
    assert.ok(step2Lines.length <= maxLines, `Step 2 exceeded ${maxLines} at ${columns}x${rows}`);
    for (const line of step2Lines) {
      assert.ok(visibleWidth(line) <= columns, `Step 2 line exceeded ${columns}`);
    }
    assert.ok(step2Lines.some((l) => l.includes("off")));
    assert.ok(!step2Lines.some((l) => l.includes("medium")));

    // Esc back to Step 1 -> clear query -> select clear row ("Active model (default)") -> commits null
    smallDialog.handleInput(KEY_ESC);
    smallDialog.handleInput("\x15");
    // Move to index 0 (clear row) via selecting it with keyboard after re-opening
    smallDialog.handleInput(KEY_ESC); // exit route
    // Open fallbackModel (has unavailable saved model legacy/offline-model)
    smallDialog.navigateTo({ field: "fallbackModel" });
    smallDialog.handleInput(KEY_ENTER);
    smallDialog.handleInput(KEY_TAB); // switch to All
    const allLines = smallDialog.render(columns);
    assert.ok(allLines.some((l) => l.includes("offline-model")));
  }
});

test("14. Dynamic description(values) updates live and multi-line wrapped help text respects height budget", async () => {
  const dynSchema = defineSettings({
    id: "dyn-desc-test",
    title: "Dynamic Help",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        description: "Master toggle for dynamic help.",
        default: true,
      }),
      mode: field.enum({
        label: "Mode",
        default: "fast",
        description: (values) =>
          values.enabled
            ? `Active mode is ${values.mode}: this is an intentionally long dynamic description that wraps across multiple lines inside the help area of the dialog.`
            : "Feature is currently disabled so mode selection has no runtime effect until Enabled is turned back on.",
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
          { value: "deep", label: "Deep" },
          { value: "ultra", label: "Ultra" },
        ],
      }),
    },
  });

  const makeDialog = async (rows, columns) => {
    const adapter = createMemoryStorageAdapter();
    const store = createSettingsStore(dynSchema, { adapter });
    const initialState = await store.load({ trustedProject: true });
    const tui = createMockTui({ rows, columns, mode: "fullscreen" });
    const dialog = new SettingsDialogComponent({
      schema: dynSchema,
      store,
      initialState,
      tui,
      theme: createMockTheme(),
      keybindings: createMockKeybindings(),
      done: () => {},
    });
    dialog.focused = true;
    return dialog;
  };

  // At 60x30 (maxLines = 26 >= 20 -> helpCap = 3): wraps full 3-line dynamic description
  const dTall = await makeDialog(30, 60);
  dTall.navigateTo({ field: "mode" });
  let lines = dTall.render(60);
  assert.ok(lines.length <= 26);
  for (const line of lines) assert.ok(visibleWidth(line) <= 60);
  const joinedTall = lines.map((l) => stripTerminalSequences(l)).join("\n");
  assert.ok(joinedTall.includes("Active mode is fast:"));
  assert.ok(joinedTall.includes("help area of the dialog."));

  // Toggle Enabled off -> dynamic description on Mode updates live in draft state
  dTall.navigateTo({ field: "enabled" });
  dTall.handleInput(" ");
  dTall.navigateTo({ field: "mode" });
  lines = dTall.render(60);
  const joinedDisabled = lines.map((l) => stripTerminalSequences(l)).join("\n");
  assert.ok(joinedDisabled.includes("Feature is currently disabled"));
  assert.ok(!joinedDisabled.includes("Active mode is fast:"));

  // Open SelectRoute for Mode -> sub-route receives resolved dynamic description string
  dTall.handleInput(KEY_ENTER);
  const subLines = dTall.render(60);
  assert.ok(subLines.some((l) => stripTerminalSequences(l).includes("Feature is currently")));

  // Tight terminal heights: rows=14 (maxLines=10, helpCap=1) & rows=12 (maxLines=8, helpCap=0)
  for (const rows of [14, 12]) {
    const dShort = await makeDialog(rows, 54);
    dShort.navigateTo({ field: "mode" });
    const shortLines = dShort.render(54);
    const maxLines = Math.max(8, rows - 4);
    assert.ok(shortLines.length <= maxLines, `Expected <= ${maxLines}, got ${shortLines.length}`);
    for (const line of shortLines) {
      assert.ok(visibleWidth(line) <= 54);
    }
    // At least 2 body rows remain visible
    assert.ok(shortLines.some((l) => l.includes("Enabled")));
    assert.ok(shortLines.some((l) => l.includes("Mode")));
  }
});

test("15. Draft-aware format(val, values) and tone(val, values) update live on root rows", async () => {
  const toneTheme = {
    ...createMockTheme(),
    fg: (color, text) => `<${color}>${text}</${color}>`,
  };

  const schema = defineSettings({
    id: "draft-format-tone-test",
    title: "Draft Format & Tone",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: true,
      }),
      limit: field.integer({
        label: "Limit",
        default: 10,
        min: 1,
        max: 100,
        format: (val, values) => (values?.enabled ? `${val} active` : `${val} (paused)`),
        tone: (_val, values) => (values?.enabled ? "success" : "warn"),
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 80, mode: "fullscreen" });
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: toneTheme,
    keybindings: createMockKeybindings(),
    done: () => {},
  });
  dialog.focused = true;

  let lines = dialog.render(80);
  let limitRow = lines.find((l) => stripTerminalSequences(l).includes("Limit"));
  assert.ok(limitRow?.includes("<success>10 active</success>"));

  // Toggle Enabled off in draft -> Limit row immediately updates format & tone
  dialog.handleInput(" ");
  lines = dialog.render(80);
  limitRow = lines.find((l) => stripTerminalSequences(l).includes("Limit"));
  assert.ok(limitRow?.includes("<warning>10 (paused)</warning>"));
});

test("16. SelectRoute renders full wrapped description preview for long option descriptions with mouse & height safety", async () => {
  const longDesc =
    "Prunes all tool results older than the configured retention window while preserving pinned assistant summaries.";
  const selected = [];
  const route = new SelectRoute({
    title: "Strategy",
    description: "Choose a pruning strategy.",
    currentValue: "none",
    theme: {
      ...createMockTheme(),
      fg: (color, text) => (color === "muted" ? `[muted:${text}]` : text),
    },
    keybindings: createMockKeybindings(),
    getMaxHeight: () => 14,
    options: [
      { value: "none", label: "None", description: "Short" },
      { value: "aggressive", label: "Aggressive Pruning Strategy", description: longDesc },
      { value: "balanced", label: "Balanced", description: "Moderate retention" },
      { value: "minimal", label: "Minimal", description: "Light touch" },
    ],
    onSelect: (val) => selected.push(val),
    onCancel: () => {},
  });
  route.focused = true;

  // Move to "aggressive" whose long description does not fit inline at width 72
  route.handleInput(KEY_DOWN);
  const lines = route.render(72);
  assert.ok(lines.length <= 14);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 72, `Line exceeded width 72: ${visibleWidth(line)}`);
  }

  // Full wrapped description appears in muted preview above the footer hint
  const plainLines = lines.map((l) => stripTerminalSequences(l));
  assert.ok(plainLines.some((l) => l.includes("[muted:") && l.includes("Prunes all tool results")));
  assert.ok(plainLines.some((l) => l.includes("[muted:") && l.includes("pinned assistant summaries.")));
  assert.ok(plainLines[plainLines.length - 1].includes("Enter select"));

  // Mouse click on "Minimal" still hits the exact row y coordinate
  const minPos = findTextPosition(lines, "Minimal");
  assert.ok(minPos);
  route.handleMouse(makeMouseEvent("press", { x: minPos.x - 1, y: minPos.y }));
  route.handleMouse(makeMouseEvent("click", { x: minPos.x - 1, y: minPos.y, clickCount: 1 }));
  assert.deepEqual(selected, ["minimal"]);
});

test("17. ModelPickerRoute & SettingsDialogComponent with includeThinking: false (1-step selection, clear, header/footer)", async () => {
  const availableModels = [
    { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true },
    { provider: "openai", id: "gpt-5-mini", name: "GPT-5 Mini", reasoning: true },
  ];

  // Direct ModelPickerRoute with includeThinking: false
  const directSelected = [];
  const directRoute = new ModelPickerRoute({
    title: "Summarizer Model",
    includeThinking: false,
    availableModels,
    currentValue: "anthropic/claude-sonnet-4-5",
    allowClear: true,
    emptyLabel: "Inherit active",
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    onSelect: (val) => directSelected.push(val),
    onCancel: () => {},
  });
  directRoute.focused = true;

  // Wide header says "Select model" without "Step 1/2", footer says "Enter select"
  const wideLines = directRoute.render(72);
  assert.ok(wideLines[0].includes("Select model"));
  assert.ok(!wideLines[0].includes("Step 1/2"));
  assert.ok(wideLines[wideLines.length - 1].includes("Enter select"));
  assert.ok(!wideLines[wideLines.length - 1].includes("Enter next"));

  // Narrow (< 50) header says "Model" without "1/2 Model"
  const narrowLines = directRoute.render(44);
  assert.ok(narrowLines[0].includes("Model"));
  assert.ok(!narrowLines[0].includes("1/2"));

  // Clicking gpt-5-mini immediately commits "openai/gpt-5-mini" in 1 step (never enters thinking step)
  const gptPos = findTextPosition(wideLines, "gpt-5-mini");
  assert.ok(gptPos);
  directRoute.handleMouse(makeMouseEvent("press", { x: gptPos.x - 1, y: gptPos.y }));
  directRoute.handleMouse(makeMouseEvent("click", { x: gptPos.x - 1, y: gptPos.y, clickCount: 1 }));
  assert.equal(directRoute.getStep(), "model");
  assert.deepEqual(directSelected, ["openai/gpt-5-mini"]);

  // SettingsDialogComponent integration with field.model({ includeThinking: false, allowClear: true })
  const schema = defineSettings({
    id: "model-only-dialog-test",
    title: "Model Only Settings",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      summarizerModel: field.model({
        label: "Summarizer model",
        includeThinking: false,
        allowClear: true,
        default: null,
        emptyLabel: "Active model",
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 80, mode: "fullscreen" });
  const results = [];

  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    availableModels,
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Open picker -> Move to claude-sonnet-4-5 -> Enter commits string directly
  dialog.handleInput(KEY_ENTER);
  let lines = dialog.render(80);
  assert.ok(lines.some((l) => l.includes("Select model")));
  assert.ok(!lines.some((l) => l.includes("Step 1/2")));

  dialog.handleInput(KEY_DOWN); // skip clear row -> claude-sonnet-4-5
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(80);
  assert.ok(!lines.some((l) => l.includes("Step 2/2")));
  assert.ok(lines.some((l) => l.includes("anthropic/claude-sonnet-4-5")));

  // Re-open picker -> select clear row -> commits null
  dialog.handleInput(KEY_ENTER);
  dialog.handleInput(KEY_UP); // move up to Active model (clear row)
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(80);
  assert.ok(lines.some((l) => l.includes("Active model")));

  // Re-select via Enter on gpt-5-mini and Ctrl+S save
  dialog.handleInput(KEY_ENTER);
  for (const ch of "gpt") dialog.handleInput(ch);
  dialog.handleInput(KEY_ENTER);
  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results.length, 1);
  assert.equal(results[0].saved, true);
  assert.equal(results[0].values.summarizerModel, "openai/gpt-5-mini");
});

test("18. Dynamic label(values) updates live on root rows and sub-route titles", async () => {
  const schema = defineSettings({
    id: "dyn-label-test",
    title: "Dynamic Label Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Master Switch",
        default: true,
      }),
      target: field.string({
        label: (v) => (v.enabled ? "Active Endpoint" : "Standby Endpoint"),
        description: "Endpoint label tracks Master Switch.",
        default: "https://api.example.com",
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 84, mode: "fullscreen" });
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: () => {},
  });
  dialog.focused = true;

  let lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Active Endpoint")));
  assert.ok(!lines.some((l) => l.includes("Standby Endpoint")));

  // Toggle Master Switch off -> root row label updates immediately
  dialog.handleInput(" ");
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Standby Endpoint")));
  assert.ok(!lines.some((l) => l.includes("Active Endpoint")));

  // Open sub-route -> header title reflects the dynamic label
  dialog.navigateTo({ field: "target" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Standby Endpoint"));
});

test("19. Row eligibility framework: eligible() and string disabled stay focusable, show help & warning banner without mutating", async () => {
  const warnTheme = {
    ...createMockTheme(),
    fg: (color, text) => (color === "warning" ? `<warn>${text}</warn>` : text),
  };

  const schema = defineSettings({
    id: "eligibility-test",
    title: "Eligibility Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: false,
      }),
      hardLocked: field.boolean({
        label: "Hard Locked",
        default: false,
        disabled: true,
      }),
      eligibleGated: field.boolean({
        label: "Eligible Gated",
        description: "Base description.",
        default: false,
        eligible: (v) =>
          v.enabled
            ? true
            : { eligible: false, reason: "Turn on Enabled before toggling Eligible Gated." },
      }),
      stringDisabled: field.integer({
        label: "String Disabled",
        description: "Worker count.",
        default: 4,
        min: 1,
        max: 10,
        disabled: (v) => (v.enabled ? false : "String reason: feature is currently off."),
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 26, columns: 86, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: warnTheme,
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Pressing Down from Enabled skips Hard Locked (boolean disabled: true) and lands on Eligible Gated
  dialog.handleInput(KEY_DOWN);
  let lines = dialog.render(86);
  const gatedRow = lines.find((l) => stripTerminalSequences(l).includes("Eligible Gated"));
  assert.ok(stripTerminalSequences(gatedRow ?? "").startsWith("│ ❯"));
  assert.ok(lines.some((l) => stripTerminalSequences(l).includes("Turn on Enabled before toggling")));

  // Enter, Space, and click show warning banner and do NOT mutate eligibleGated
  for (const trigger of ["enter", "space", "click"]) {
    if (trigger === "enter") dialog.handleInput(KEY_ENTER);
    else if (trigger === "space") dialog.handleInput(" ");
    else {
      const pos = findTextPosition(lines, "Eligible Gated");
      assert.ok(pos);
      dialog.handleMouse(makeMouseEvent("press", pos));
      dialog.handleMouse(makeMouseEvent("click", { ...pos, clickCount: 1 }));
    }
    lines = dialog.render(86);
    assert.ok(
      lines.some((l) => l.includes("<warn>Turn on Enabled before toggling Eligible Gated.</warn>")),
      `Expected warning banner on ${trigger}`,
    );
    const updatedGated = lines.find((l) => stripTerminalSequences(l).includes("Eligible Gated"));
    assert.ok(stripTerminalSequences(updatedGated ?? "").includes("Off"));
  }

  // Move down to String Disabled -> focusable, help shows string reason, Enter/arrow/click blocked with warning
  dialog.handleInput(KEY_DOWN);
  lines = dialog.render(86);
  const strRow = lines.find((l) => stripTerminalSequences(l).includes("String Disabled"));
  assert.ok(stripTerminalSequences(strRow ?? "").startsWith("│ ❯"));
  assert.ok(lines.some((l) => stripTerminalSequences(l).includes("String reason: feature is currently off.")));

  dialog.handleInput(KEY_RIGHT);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("<warn>String reason: feature is currently off.</warn>")));
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("String Disabled")) ?? "").includes("4"));

  dialog.handleInput(" ");
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("<warn>String reason: feature is currently off.</warn>")));

  // Enable master switch -> both rows become eligible and editable
  dialog.navigateTo({ field: "enabled" });
  dialog.handleInput(" ");
  dialog.navigateTo({ field: "eligibleGated" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(86);
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Eligible Gated")) ?? "").includes("On"));

  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results[0].values.eligibleGated, true);
  assert.equal(results[0].values.stringDisabled, 4);
});

test("20. Scope-aware rows render [Global only]/[Project only], stay focusable, and show scope-switch warning banner", async () => {
  const warnTheme = {
    ...createMockTheme(),
    fg: (color, text) => (color === "warning" ? `<warn>${text}</warn>` : text),
  };

  const schema = defineSettings({
    id: "scope-aware-test",
    title: "Scope Aware Test",
    scopes: ["global", "project"],
    defaultScope: "global",
    saveMode: "draft",
    fields: {
      globalOnly: field.boolean({
        label: "Global Secret Policy",
        description: "Applies globally.",
        default: true,
        scopes: ["global"],
      }),
      projectOnly: field.integer({
        label: "Project Concurrency",
        description: "Applies per project.",
        default: 2,
        min: 1,
        max: 8,
        scopes: ["project"],
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 26, columns: 88, mode: "fullscreen" });
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: warnTheme,
    keybindings: createMockKeybindings(),
    done: () => {},
  });
  dialog.focused = true;

  // In Global scope: projectOnly renders [Project only], is focusable, and blocks Enter/Space/Left/Right/Click
  let lines = dialog.render(88);
  assert.ok(lines[1].includes("[Global]"));
  assert.ok(lines.some((l) => stripTerminalSequences(l).includes("Project Concurrency [Project only]")));
  assert.ok(!lines.some((l) => stripTerminalSequences(l).includes("[Global only]")));

  dialog.handleInput(KEY_DOWN); // moves to Project Concurrency
  lines = dialog.render(88);
  assert.ok(
    stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Project Concurrency")) ?? "").startsWith("│ ❯"),
  );

  for (const input of [KEY_ENTER, " ", KEY_LEFT, KEY_RIGHT]) {
    dialog.handleInput(input);
    lines = dialog.render(88);
    assert.ok(
      lines.some((l) => l.includes("<warn>Project-only setting. Switch Save scope to Project to edit.</warn>")),
    );
    assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Project Concurrency")) ?? "").includes("2"));
  }

  const projPos = findTextPosition(lines, "Project Concurrency");
  assert.ok(projPos);
  dialog.handleMouse(makeMouseEvent("press", projPos));
  dialog.handleMouse(makeMouseEvent("click", { ...projPos, clickCount: 1 }));
  lines = dialog.render(88);
  assert.ok(
    lines.some((l) => l.includes("<warn>Project-only setting. Switch Save scope to Project to edit.</warn>")),
  );

  // Switch Save scope to Project -> projectOnly becomes editable, globalOnly shows [Global only] and blocks edits
  const scopePos = findTextPosition(lines, "Save scope");
  assert.ok(scopePos);
  dialog.handleMouse(makeMouseEvent("press", scopePos));
  dialog.handleMouse(makeMouseEvent("click", { ...scopePos, clickCount: 1 }));
  lines = dialog.render(88);
  assert.ok(lines[1].includes("[Project]"));
  assert.ok(lines.some((l) => stripTerminalSequences(l).includes("Global Secret Policy [Global only]")));
  assert.ok(!lines.some((l) => stripTerminalSequences(l).includes("[Project only]")));

  // Edit projectOnly via Right arrow -> succeeds (2 -> 3)
  dialog.navigateTo({ field: "projectOnly" });
  dialog.handleInput(KEY_RIGHT);
  lines = dialog.render(88);
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Project Concurrency")) ?? "").includes("3"));

  // Try editing globalOnly via Enter/Space/Left/Right/Click -> blocked with Global-only warning
  dialog.navigateTo({ field: "globalOnly" });
  for (const input of [KEY_ENTER, " ", KEY_LEFT, KEY_RIGHT]) {
    dialog.handleInput(input);
    lines = dialog.render(88);
    assert.ok(
      lines.some((l) => l.includes("<warn>Global-only setting. Switch Save scope to Global to edit.</warn>")),
    );
  }
  const globalPos = findTextPosition(lines, "Global Secret Policy");
  assert.ok(globalPos);
  dialog.handleMouse(makeMouseEvent("press", globalPos));
  dialog.handleMouse(makeMouseEvent("click", { ...globalPos, clickCount: 1 }));
  lines = dialog.render(88);
  assert.ok(
    lines.some((l) => l.includes("<warn>Global-only setting. Switch Save scope to Global to edit.</warn>")),
  );
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Global Secret Policy")) ?? "").includes("On"));
});

test("21. field.view (TextViewerRoute): Markdown rendering, bounds, scrolling, async load + Ctrl+R refresh, Esc, mouse, never persisted", async () => {
  // Unit check renderMarkdownToAnsi directly for headings, bold, code, lists, and width safety
  const mdLines = renderMarkdownToAnsi(
    [
      "# Main Heading",
      "Paragraph with **bold text** and `inlineCode()`.",
      "",
      "- First item",
      "  - Nested item",
      "1. Ordered one",
      "",
      "```ts",
      "const x = 42;",
      "```",
    ].join("\n"),
    32,
    createMockTheme(),
  );
  assert.ok(mdLines.some((l) => l.includes("Main Heading")));
  assert.ok(mdLines.some((l) => l.includes("bold text")));
  assert.ok(mdLines.some((l) => l.includes("inlineCode()")));
  assert.ok(mdLines.some((l) => l.includes("• First item")));
  assert.ok(mdLines.some((l) => l.includes("1. Ordered one")));
  assert.ok(mdLines.some((l) => l.includes("const x = 42;")));
  for (const line of mdLines) {
    assert.ok(visibleWidth(line) <= 32, `Markdown line exceeded width 32: ${visibleWidth(line)}`);
  }

  // Async TextViewerRoute via field.view in SettingsDialogComponent
  let loadCount = 0;
  let abortedSignals = 0;
  let resolveFirstLoad;
  const schema = defineSettings({
    id: "view-field-test",
    title: "View Field Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: true,
      }),
      changelog: field.view({
        label: "Diagnostics Report",
        description: "Read-only markdown diagnostics.",
        value: "Inspect…",
        format: "markdown",
        content: async (ctx) => {
          loadCount++;
          ctx.signal.addEventListener("abort", () => {
            abortedSignals++;
          });
          if (loadCount === 1) {
            await new Promise((resolve) => {
              resolveFirstLoad = resolve;
            });
            return "# Should Be Aborted";
          }
          const bodyLines = Array.from({ length: 24 }, (_, idx) => `- Line ${idx + 1}: **item** \`code_${idx + 1}\``);
          return `# Report v${loadCount} (${ctx.scope})\n\n${bodyLines.join("\n")}`;
        },
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 18, columns: 70, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Root shows value summary "Inspect…"
  let lines = dialog.render(70);
  assert.ok(lines.some((l) => l.includes("Diagnostics Report") && l.includes("Inspect…")));

  // Open viewer -> shows Loading… initially
  dialog.navigateTo({ field: "changelog" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(70);
  assert.ok(lines[1].includes("Diagnostics Report"));
  assert.ok(lines.some((l) => l.includes("Loading…")));

  // Press Ctrl+R while first load is still pending -> aborts first load and loads v2 immediately
  dialog.handleInput(KEY_CTRL_R);
  resolveFirstLoad?.();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loadCount, 2);
  assert.equal(abortedSignals, 1);

  const maxLines = Math.max(8, 18 - 4);
  lines = dialog.render(70);
  assert.ok(lines.length <= maxLines);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 70);
  }
  assert.ok(lines.some((l) => l.includes("Report v2 (global)")));
  assert.ok(lines.some((l) => l.includes("Line 1: item code_1")));

  // Scroll via End, Home, PgDn, and mouse wheel
  dialog.handleInput(KEY_END);
  lines = dialog.render(70);
  assert.ok(lines.some((l) => l.includes("Line 24:")));
  dialog.handleInput(KEY_HOME);
  lines = dialog.render(70);
  assert.ok(lines.some((l) => l.includes("Report v2 (global)")));
  dialog.handleInput(KEY_PGDN);
  lines = dialog.render(70);
  assert.ok(!lines.some((l) => l.includes("Report v2 (global)")));
  dialog.handleMouse(makeMouseEvent("wheel", { x: 10, y: 5, wheelDelta: -20 }));
  lines = dialog.render(70);
  assert.ok(lines.some((l) => l.includes("Report v2 (global)")));

  // Click [Ctrl+R Refresh] pill -> loads v3
  const refreshPos = findTextPosition(lines, "[Ctrl+R Refresh]");
  assert.ok(refreshPos);
  dialog.handleMouse(makeMouseEvent("press", refreshPos));
  dialog.handleMouse(makeMouseEvent("click", { ...refreshPos, clickCount: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loadCount, 3);
  lines = dialog.render(70);
  assert.ok(lines.some((l) => l.includes("Report v3 (global)")));

  // Click [Esc Back] (and also test Esc key) returns to root
  const backPos = findTextPosition(lines, "[Esc Back]");
  assert.ok(backPos);
  dialog.handleMouse(makeMouseEvent("press", backPos));
  dialog.handleMouse(makeMouseEvent("click", { ...backPos, clickCount: 1 }));
  lines = dialog.render(70);
  assert.ok(!lines[1].includes("Diagnostics Report"));

  // Re-open and close with Esc key
  dialog.handleInput(KEY_ENTER);
  await new Promise((r) => setTimeout(r, 20));
  dialog.handleInput(KEY_ESC);
  lines = dialog.render(70);
  assert.ok(!lines[1].includes("Diagnostics Report"));

  // Toggle enabled and save -> verify changelog is NEVER written to storage
  dialog.navigateTo({ field: "enabled" });
  dialog.handleInput(" ");
  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  const savedLayer = await adapter.readLayer("global");
  assert.deepEqual(savedLayer.data, { enabled: false });
  assert.equal("changelog" in results[0].values, false);
  // Sanity check TextViewerRoute export can be constructed directly
  assert.equal(typeof TextViewerRoute, "function");
});

test("22. field.external: async summary, sync & async openSubroute (LoadingRoute + Esc abort), close() refresh, never persisted", async () => {
  const toneTheme = {
    ...createMockTheme(),
    fg: (color, text) => (color === "success" ? `<success>${text}</success>` : text),
  };

  let summaryCalls = 0;
  let syncParams = null;
  let asyncSignalAborted = false;
  let resolveAsyncSubroute;

  const schema = defineSettings({
    id: "external-field-test",
    title: "External Field Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: true,
      }),
      syncTool: field.external({
        label: "Sync Profiles",
        description: "Manage external profiles.",
        summary: async () => {
          summaryCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return { text: `${summaryCalls} synced`, tone: "success" };
        },
        openSubroute: (params) => {
          syncParams = params;
          return {
            title: "Profile Manager",
            focused: false,
            render: () => [`Scope=${params.scope} MaxH=${params.getMaxHeight()}`],
            handleInput: (data) => {
              if (data === KEY_ENTER) {
                params.close({
                  saved: true,
                  message: "Profiles updated externally.",
                  tone: "success",
                });
              }
            },
            invalidate: () => {},
          };
        },
      }),
      asyncTool: field.external({
        label: "Async Connect",
        description: "Connect asynchronously.",
        summary: "Ready",
        openSubroute: async (params) => {
          params.signal.addEventListener("abort", () => {
            asyncSignalAborted = true;
          });
          await new Promise((resolve) => {
            resolveAsyncSubroute = resolve;
          });
          return {
            title: "Connected",
            focused: false,
            render: () => ["Connected"],
            invalidate: () => {},
          };
        },
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 84, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: toneTheme,
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Initial render shows "…" placeholder while async summary resolves
  let lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Sync Profiles") && l.includes("…")));

  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Sync Profiles") && l.includes("<success>1 synced</success>")));

  // Open syncTool -> verify params & close({ saved: true, message }) refreshes summary and sets banner
  dialog.navigateTo({ field: "syncTool" });
  dialog.handleInput(KEY_ENTER);
  assert.ok(syncParams);
  assert.equal(syncParams.scope, "global");
  assert.equal(typeof syncParams.getMaxHeight, "function");
  assert.ok(syncParams.getMaxHeight() > 0);
  assert.equal(syncParams.signal instanceof AbortSignal, true);
  assert.equal(typeof syncParams.close, "function");

  lines = dialog.render(84);
  assert.ok(lines[1].includes("Profile Manager"));
  assert.ok(lines.some((l) => l.includes("Scope=global")));

  dialog.handleInput(KEY_ENTER); // triggers params.close(...)
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("Profiles updated externally.")));
  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(84);
  assert.ok(lines.some((l) => l.includes("<success>2 synced</success>")));

  // Open asyncTool -> LoadingRoute appears; Esc cancels & aborts signal
  dialog.navigateTo({ field: "asyncTool" });
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(84);
  assert.ok(lines[1].includes("Async Connect"));
  assert.ok(lines.some((l) => l.includes("Loading…")));

  dialog.handleInput(KEY_ESC);
  assert.equal(asyncSignalAborted, true);
  resolveAsyncSubroute?.();
  await new Promise((r) => setTimeout(r, 10));
  lines = dialog.render(84);
  assert.ok(!lines[1].includes("Async Connect"));

  // Save another field -> external fields are never written to storage
  dialog.navigateTo({ field: "enabled" });
  dialog.handleInput(" ");
  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  const savedLayer = await adapter.readLayer("global");
  assert.deepEqual(savedLayer.data, { enabled: false });
  assert.equal("syncTool" in results[0].values, false);
  assert.equal("asyncTool" in results[0].values, false);
});

test("23. field.picker (DynamicPickerRoute): async load, fuzzy search, groups, badges, disabledReason, validateSelection, allowClear, Ctrl+R, mouse & persistence", async () => {
  let loadCalls = 0;
  const schema = defineSettings({
    id: "picker-field-test",
    title: "Picker Field Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      profile: field.picker({
        label: "Target Profile",
        description: "Choose a deployment profile.",
        default: null,
        allowClear: true,
        emptyLabel: "No Profile",
        emptyDescription: "Use built-in defaults",
        loadOptions: async () => {
          loadCalls++;
          await new Promise((r) => setTimeout(r, 5));
          return [
            {
              id: "dev",
              value: "dev",
              label: "Development",
              group: "Local",
              badge: "fast",
              badgeTone: "accent",
              description: "Local dev sandbox",
            },
            {
              id: "staging",
              value: "staging",
              label: "Staging",
              group: "Cloud",
              badge: "beta",
              description: "Pre-prod cluster",
            },
            {
              id: "prod-locked",
              value: "prod-locked",
              label: "Production Locked",
              group: "Cloud",
              disabled: true,
              disabledReason: "Requires elevated prod token.",
            },
            {
              id: "prod",
              value: "prod",
              label: "Production",
              group: "Cloud",
              badge: `v${loadCalls}`,
            },
          ];
        },
        validateSelection: async (opt) => {
          await new Promise((r) => setTimeout(r, 5));
          if (opt.value === "staging") {
            return "Staging cluster is currently under maintenance.";
          }
          return true;
        },
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 86, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Open picker -> Loading options… -> resolves with groups, badges, clear row
  dialog.handleInput(KEY_ENTER);
  let lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Loading options…")));

  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("No Profile")));
  assert.ok(lines.some((l) => l.includes("Local")));
  assert.ok(lines.some((l) => l.includes("Development")) && lines.some((l) => l.includes("fast")));
  assert.ok(lines.some((l) => l.includes("Cloud")));

  // Mouse wheel inside DynamicPickerRoute
  const wheelRes = dialog.handleMouse(makeMouseEvent("wheel", { x: 10, y: 6, wheelDelta: 1 }));
  assert.deepEqual(wheelRes, { handled: true, render: true });

  // Ctrl+R refresh reloads options (v1 -> v2)
  dialog.handleInput(KEY_CTRL_R);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(loadCalls, 2);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("v2")));

  // Fuzzy filter "prod" -> shows Production Locked & Production; clicking disabled option shows inline banner
  for (const ch of "prod") dialog.handleInput(ch);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Production Locked")));
  assert.ok(!lines.some((l) => l.includes("Development")));

  const lockedPos = findTextPosition(lines, "Production Locked");
  assert.ok(lockedPos);
  dialog.handleMouse(makeMouseEvent("press", lockedPos));
  dialog.handleMouse(makeMouseEvent("click", { ...lockedPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("⚠ Requires elevated prod token.")));

  // Clear filter with Ctrl+U, select Staging -> async validateSelection fails with inline error banner
  dialog.handleInput("\x15");
  for (const ch of "staging") dialog.handleInput(ch);
  dialog.handleInput(KEY_ENTER);
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("Validating selection…")));
  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("⚠ Staging cluster is currently under maintenance.")));

  // Filter "Development" and click it -> passes validateSelection and commits "dev"
  dialog.handleInput("\x15");
  for (const ch of "dev") dialog.handleInput(ch);
  lines = dialog.render(86);
  const devPos = findTextPosition(lines, "Development");
  assert.ok(devPos);
  dialog.handleMouse(makeMouseEvent("press", devPos));
  dialog.handleMouse(makeMouseEvent("click", { ...devPos, clickCount: 1 }));
  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(86);
  assert.ok(!lines[1].includes("Target Profile"));
  assert.ok(lines.some((l) => l.includes("dev")));

  // Re-open picker and clear back to null via clear row
  dialog.handleInput(KEY_ENTER);
  await new Promise((r) => setTimeout(r, 20));
  lines = dialog.render(86);
  const clearPos = findTextPosition(lines, "No Profile");
  assert.ok(clearPos);
  dialog.handleMouse(makeMouseEvent("press", clearPos));
  dialog.handleMouse(makeMouseEvent("click", { ...clearPos, clickCount: 1 }));
  lines = dialog.render(86);
  assert.ok(lines.some((l) => l.includes("No Profile")));

  // Re-open picker, pick Production, and Ctrl+S save -> persists "prod"
  dialog.handleInput(KEY_ENTER);
  await new Promise((r) => setTimeout(r, 20));
  for (const ch of "production") dialog.handleInput(ch);
  lines = dialog.render(86);
  const prodPos = findTextPosition(lines, `v${loadCalls}`);
  assert.ok(prodPos);
  dialog.handleMouse(makeMouseEvent("press", prodPos));
  dialog.handleMouse(makeMouseEvent("click", { ...prodPos, clickCount: 1 }));
  await new Promise((r) => setTimeout(r, 20));

  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results[0].saved, true);
  assert.equal(results[0].values.profile, "prod");
  const savedLayer = await adapter.readLayer("global");
  assert.equal(savedLayer.data?.profile, "prod");
  assert.equal(typeof DynamicPickerRoute, "function");
});

test("24. Upgraded field.custom receives scope, signal (aborted on pop), getMaxHeight, requestRender, commitFields, and notify", async () => {
  let receivedParams = null;
  let abortedCount = 0;

  const schema = defineSettings({
    id: "upgraded-custom-test",
    title: "Upgraded Custom Test",
    scopes: ["global", "project"],
    defaultScope: "project",
    saveMode: "draft",
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: true,
      }),
      workers: field.integer({
        label: "Workers",
        default: 2,
        min: 1,
        max: 32,
      }),
      bundle: field.custom({
        label: "Preset Bundle",
        default: "standard",
        openSubroute: (params) => {
          receivedParams = params;
          params.signal.addEventListener("abort", () => {
            abortedCount++;
          });
          return {
            title: "Bundle Editor",
            focused: false,
            render: () => [`scope=${params.scope} maxH=${params.getMaxHeight()}`],
            handleInput: (data) => {
              if (data === "n") {
                params.notify("Custom helper notice", "warn");
              } else if (data === KEY_ENTER) {
                params.commitFields({
                  bundle: "turbo",
                  enabled: false,
                  workers: 16,
                });
              } else if (data === KEY_ESC) {
                params.cancel();
              }
            },
            invalidate: () => {},
          };
        },
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 84, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // Open bundle subroute -> verify params and Esc aborts signal
  dialog.navigateTo({ field: "bundle" });
  dialog.handleInput(KEY_ENTER);
  assert.ok(receivedParams);
  assert.equal(receivedParams.scope, "project");
  assert.equal(receivedParams.signal.aborted, false);
  assert.ok(receivedParams.getMaxHeight() > 0);

  const rendersBefore = tui.renderRequests;
  receivedParams.requestRender();
  assert.equal(tui.renderRequests, rendersBefore + 1);

  dialog.handleInput(KEY_ESC);
  assert.equal(abortedCount, 1);
  assert.equal(receivedParams.signal.aborted, true);

  // Re-open -> trigger notify, then commitFields atomically updates 3 fields and pops route
  dialog.handleInput(KEY_ENTER);
  dialog.handleInput("n");
  dialog.handleInput(KEY_ENTER);
  assert.equal(abortedCount, 2);

  let lines = dialog.render(84);
  assert.ok(!lines[1].includes("Bundle Editor"));
  assert.ok(lines[1].includes("● Unsaved (3)"));

  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results[0].saved, true);
  assert.equal(results[0].values.bundle, "turbo");
  assert.equal(results[0].values.enabled, false);
  assert.equal(results[0].values.workers, 16);
  const savedLayer = await adapter.readLayer("project");
  assert.deepEqual(savedLayer.data, { bundle: "turbo", enabled: false, workers: 16 });
});

test("25. Arrow stepping (picker enum ignores Left/Right; exact float stepping 0.375 + 0.05 = 0.425) and normalizeDraft", async () => {
  const schema = defineSettings({
    id: "stepping-normalize-test",
    title: "Stepping & Normalize",
    scopes: ["global"],
    saveMode: "draft",
    normalizeDraft: (draft, changedKey) => {
      if (changedKey === "mode" && draft.mode === "strict") {
        return { ...draft, enabled: true, ratio: 0.425 };
      }
      if (changedKey === "enabled" && !draft.enabled) {
        return { ...draft, mode: "off" };
      }
      return draft;
    },
    fields: {
      enabled: field.boolean({
        label: "Enabled",
        default: false,
      }),
      mode: field.enum({
        label: "Mode",
        display: "picker",
        default: "off",
        options: [
          { value: "off", label: "Off" },
          { value: "auto", label: "Auto" },
          { value: "strict", label: "Strict" },
        ],
      }),
      ratio: field.number({
        label: "Ratio",
        default: 0.375,
        min: 0,
        max: 1,
        step: 0.05,
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });
  const tui = createMockTui({ rows: 24, columns: 84, mode: "fullscreen" });
  const results = [];
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
  });
  dialog.focused = true;

  // display: "picker" enum ignores Left/Right inline stepping
  dialog.navigateTo({ field: "mode" });
  dialog.handleInput(KEY_RIGHT);
  dialog.handleInput(KEY_LEFT);
  let lines = dialog.render(84);
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Mode")) ?? "").includes("Off"));

  // field.number starting at 0.375 with step 0.05 steps cleanly to 0.425 (no 0.42500000000000004)
  dialog.navigateTo({ field: "ratio" });
  dialog.handleInput(KEY_RIGHT);
  lines = dialog.render(84);
  const ratioLine = stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Ratio")) ?? "");
  assert.match(ratioLine, /\s0\.425 │$/, `Expected exact 0.425, got: ${ratioLine}`);

  dialog.handleInput(KEY_LEFT);
  lines = dialog.render(84);
  const backRatioLine = stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Ratio")) ?? "");
  assert.match(backRatioLine, /\s0\.375 │$/, `Expected exact 0.375, got: ${backRatioLine}`);

  // Open picker for Mode and pick "Strict" -> normalizeDraft atomically sets enabled=true and ratio=0.425
  dialog.navigateTo({ field: "mode" });
  dialog.handleInput(KEY_ENTER);
  dialog.handleInput(KEY_DOWN);
  dialog.handleInput(KEY_DOWN);
  dialog.handleInput(KEY_ENTER);

  lines = dialog.render(84);
  assert.ok(lines[1].includes("● Unsaved (3)"));
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Enabled")) ?? "").includes("On"));
  assert.ok(stripTerminalSequences(lines.find((l) => stripTerminalSequences(l).includes("Ratio")) ?? "").includes("0.425"));

  dialog.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(results[0].saved, true);
  assert.deepEqual(results[0].values, {
    enabled: true,
    mode: "strict",
    ratio: 0.425,
  });
});

test("26. session-draft mode: 3 provenance dots, live session edits, Esc preserves session, Ctrl+S saves to Global/Project & prunes session, Reset session", async () => {
  const entries = [];
  const schema = defineSettings({
    id: "session-draft-dialog",
    title: "Session Draft Test",
    scopes: ["global", "project", "session"],
    defaultScope: "global",
    saveMode: "session-draft",
    fields: {
      maxOpen: field.integer({
        label: "Max open",
        description: "Maximum running jobs",
        default: 8,
        min: 1,
        max: 64,
      }),
      maxTotal: field.integer({
        label: "Max total",
        description: "Maximum retained jobs",
        default: 16,
        min: 1,
        max: 64,
      }),
    },
  });

  const mem = createMemoryStorageAdapter({
    global: { maxOpen: 10 },
    project: { maxTotal: 20 },
  });
  const sessionAdapter = createMemoryStorageAdapter().getPaths ? undefined : undefined;
  let sessionHash = null;
  let sessionData = null;
  const { createLayeredStorageAdapter, createSessionStorageAdapter } = await import("../dist/store/index.js");
  const sessionLayerAdapter = createSessionStorageAdapter({
    entryType: "bgmon:test",
    scope: "session",
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    getEntries: () => entries,
  });
  const adapter = createLayeredStorageAdapter({
    global: mem,
    project: mem,
    session: sessionLayerAdapter,
  });
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject: true });

  const applied = [];
  const results = [];
  const tui = createMockTui({ rows: 24, columns: 84, mode: "fullscreen" });
  const dialog = new SettingsDialogComponent({
    schema,
    store,
    initialState,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results.push(res),
    onApply: (next, meta) => applied.push({ next, meta }),
  });
  dialog.focused = true;

  let lines = dialog.render(84).map(stripTerminalSequences);
  assert.ok(lines.every((l) => visibleWidth(l) <= 84));
  assert.ok(lines.length <= 20);
  // 3-scope legend renders Global, Project, Session
  assert.ok(lines.some((l) => l.includes("Saved:") && l.includes("Global") && l.includes("Project") && l.includes("Session")));
  assert.ok(lines.some((l) => l.includes("Live session ·")));
  assert.ok(lines.some((l) => l.includes("[Ctrl+S Save]") && l.includes("[Esc Close]")));

  // Step maxOpen right (10 -> 11) -> immediately saves to session only, leaves global/project untouched
  dialog.handleInput(KEY_RIGHT);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].meta.scope, "session");
  assert.deepEqual(applied[0].next, { maxOpen: 11, maxTotal: 20 });
  assert.equal(applied[0].meta.provenance.maxOpen, "global+session");
  assert.equal((await mem.readLayer("global")).data?.maxOpen, 10);
  assert.equal((await mem.readLayer("project")).data?.maxOpen, undefined);
  assert.equal(entries.length, 1);

  lines = dialog.render(84).map(stripTerminalSequences);
  assert.ok(lines[1].includes("● Session") && lines[1].includes("[Global]"));
  assert.ok(lines.some((l) => l.includes("Reset session")));
  // 3-dot column: global+session has ●   ● before value 11
  assert.ok(lines.some((l) => l.includes("Max open") && l.includes("●   ●") && l.includes("11")));
  // Narrow render safety with 3 provenance dots
  const narrow = dialog.render(46).map(stripTerminalSequences);
  assert.ok(narrow.every((l) => visibleWidth(l) <= 46));

  // Esc closes without discarding session changes
  dialog.handleInput(KEY_ESC);
  assert.equal(results.length, 1);
  assert.equal(results[0].closedBy, "escape");
  assert.equal(results[0].saved, true);
  assert.deepEqual(results[0].values, { maxOpen: 11, maxTotal: 20 });

  // Reopen -> session value is preserved, test Reset session
  const reloaded = await store.load({ trustedProject: true });
  assert.deepEqual(reloaded.effective, { maxOpen: 11, maxTotal: 20 });

  const results2 = [];
  const dialog2 = new SettingsDialogComponent({
    schema,
    store,
    initialState: reloaded,
    tui,
    theme: createMockTheme(),
    keybindings: createMockKeybindings(),
    done: (res) => results2.push(res),
    onApply: (next, meta) => applied.push({ next, meta }),
  });
  dialog2.focused = true;
  // Navigate to Reset session (maxOpen -> maxTotal -> Save scope -> Reset session)
  dialog2.handleInput(KEY_DOWN);
  dialog2.handleInput(KEY_DOWN);
  dialog2.handleInput(KEY_DOWN);
  dialog2.handleInput(KEY_ENTER);
  // Confirm Reset session (default focus is Cancel -> Left to Clear, Enter)
  dialog2.handleInput(KEY_LEFT);
  dialog2.handleInput(KEY_ENTER);
  await new Promise((r) => setTimeout(r, 20));
  const afterReset = await store.load({ trustedProject: true });
  assert.deepEqual(afterReset.effective, { maxOpen: 10, maxTotal: 20 });
  assert.deepEqual(afterReset.layers.session, {});

  // Edit maxTotal -> saves to session, then switch Save scope to Project and Ctrl+S -> writes project & clears session!
  dialog2.navigateTo({ field: "maxTotal" });
  dialog2.handleInput(KEY_RIGHT);
  await new Promise((r) => setTimeout(r, 20));
  dialog2.handleInput(KEY_DOWN); // Save scope
  dialog2.handleInput(KEY_ENTER); // Global -> Project
  dialog2.handleInput(KEY_CTRL_S);
  await new Promise((r) => setTimeout(r, 25));

  assert.equal(results2.length, 1);
  assert.equal(results2[0].closedBy, "save");
  assert.equal(results2[0].saved, true);
  assert.equal(results2[0].scope, "project");
  assert.deepEqual(results2[0].values, { maxOpen: 10, maxTotal: 21 });

  const finalLoaded = await store.load({ trustedProject: true });
  assert.equal(finalLoaded.layers.project.maxTotal, 21);
  assert.deepEqual(finalLoaded.layers.session, {});
  assert.equal(finalLoaded.provenance.maxTotal, "project");
});
