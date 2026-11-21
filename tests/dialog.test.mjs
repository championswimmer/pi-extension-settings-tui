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
import { SettingsDialogComponent } from "../dist/dialog/index.js";

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_RIGHT = "\x1b[C";
const KEY_LEFT = "\x1b[D";
const KEY_TAB = "\t";
const KEY_SHIFT_TAB = "\x1b[Z";
const KEY_ENTER = "\r";
const KEY_ESC = "\x1b";
const KEY_CTRL_S = "\x13";
const KEY_CTRL_A = "\x01";

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
