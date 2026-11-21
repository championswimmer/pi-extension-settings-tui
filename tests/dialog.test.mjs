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
} = {}) {
  const schema = createRichSchema(schemaOverrides);
  if (customOpenSubroute) {
    schema.fields.customField = {
      ...schema.fields.customField,
      openSubroute: customOpenSubroute,
    };
  }
  const adapter = createMemoryStorageAdapter(initialLayers);
  const store = createSettingsStore(schema, { adapter });
  const initialState = await store.load({ trustedProject });
  const tui = createMockTui({ rows, columns, mode });
  const theme = createMockTheme();
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
