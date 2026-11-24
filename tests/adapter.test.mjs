import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as rootPkg from "../dist/index.js";
import * as schemaPkg from "../dist/schema/index.js";
import * as storePkg from "../dist/store/index.js";
import * as dialogPkg from "../dist/dialog/index.js";
import * as adapterPkg from "../dist/adapter/index.js";

const { defineSettings, field } = schemaPkg;
const { ConcurrencyConflictError, createMemoryStorageAdapter, createSettingsStore } = storePkg;
const { openSettingsDialog, runRpcSettingsMenu } = adapterPkg;

function createMockTheme() {
  return {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
}

function createMockKeybindings(overrides = {}) {
  return {
    matches(data, action) {
      if (overrides[action]) {
        return overrides[action](data);
      }
      if (action === "tui.select.up") return data === "\u001b[A";
      if (action === "tui.select.down") return data === "\u001b[B";
      if (action === "tui.select.confirm") return data === "\r" || data === "\n";
      if (action === "tui.select.cancel") return data === "\u001b";
      if (action === "tui.select.pageUp") return data === "\u001b[5~";
      if (action === "tui.select.pageDown") return data === "\u001b[6~";
      if (action === "tui.input.tab") return data === "\t";
      return false;
    },
  };
}

function createMockTui() {
  let hideOverlayCalls = 0;
  let renderRequests = 0;
  return {
    mode: "fullscreen",
    terminal: { rows: 30, columns: 100 },
    get hideOverlayCalls() {
      return hideOverlayCalls;
    },
    get renderRequests() {
      return renderRequests;
    },
    requestRender() {
      renderRequests++;
    },
    hideOverlay() {
      hideOverlayCalls++;
    },
  };
}

function createTestSchema(id = "adapter-test-schema") {
  return defineSettings({
    id,
    title: "Adapter Test Settings",
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
        default: true,
        trueLabel: "Yes",
        falseLabel: "No",
      }),
      mode: field.enum({
        tab: "general",
        label: "Mode",
        default: "auto",
        options: [
          { value: "off", label: "Off" },
          { value: "auto", label: "Auto" },
          { value: "strict", label: "Strict", description: "Fail on warnings" },
        ],
      }),
      tags: field.multiSelect({
        tab: "filters",
        label: "Tags",
        default: ["core"],
        allowCustom: true,
        options: [
          { value: "core", label: "Core" },
          { value: "beta", label: "Beta" },
          { value: "trace", label: "Trace" },
        ],
      }),
      prefix: field.string({
        tab: "filters",
        label: "Prefix",
        default: "pi",
        minLength: 2,
        maxLength: 10,
        trim: true,
      }),
      notes: field.string({
        tab: "filters",
        label: "Notes",
        default: "initial",
        multiline: true,
      }),
      ratio: field.number({
        tab: "advanced",
        label: "Ratio",
        default: 0.5,
        min: 0,
        max: 1,
        step: 0.1,
      }),
      retries: field.integer({
        tab: "advanced",
        label: "Retries",
        default: 3,
        min: 1,
        max: 10,
        unit: "times",
      }),
      customEditable: field.custom({
        tab: "advanced",
        label: "Custom Editable",
        default: "v1",
        rpcEdit: async (_ctx, current) => `${current}-edited`,
      }),
      customTuiOnly: field.custom({
        tab: "advanced",
        label: "Custom TUI Only",
        default: { count: 1 },
      }),
    },
  });
}

function createBaseContext(overrides = {}) {
  const notifications = [];
  return {
    notifications,
    ctx: {
      mode: "tui",
      hasUI: true,
      cwd: "/tmp/test-project",
      isProjectTrusted: () => true,
      signal: undefined,
      ui: {
        theme: createMockTheme(),
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        notify: (message, type = "info") => {
          notifications.push({ message, type });
        },
        custom: async () => {
          throw new Error("custom() not expected in this test");
        },
      },
      ...overrides,
    },
  };
}

test("TUI mode mounts single overlay, passes keybindings, never calls hideOverlay, saves & invokes onApply", async () => {
  const schema = createTestSchema("tui-save-test");
  const adapter = createMemoryStorageAdapter();
  const tui = createMockTui();
  const theme = createMockTheme();
  const keybindings = createMockKeybindings();

  let customCalls = 0;
  let capturedOverlayOpts = null;
  const applied = [];

  const { ctx } = createBaseContext({
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async (factory, opts) => {
        customCalls++;
        capturedOverlayOpts = opts;
        let resolved;
        const donePromise = new Promise((resolve) => {
          resolved = resolve;
        });
        const component = await factory(tui, theme, keybindings, (result) => {
          resolved(result);
        });
        opts?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden() {
            return false;
          },
          focus() {},
          unfocus() {},
          isFocused() {
            return true;
          },
          getBounds() {
            return undefined;
          },
        });

        // Render, toggle first boolean field ("enabled" -> false), then Ctrl+S to save
        const lines = component.render(80);
        assert.ok(lines.some((line) => line.includes("Preview: enabled")));
        assert.ok(lines.length <= 18, "preview fits the configured 60% overlay height");
        assert.match(lines.at(-2), /\[Ctrl\+S Save\]/);
        assert.ok(lines.at(-1).startsWith("╰"));
        component.handleInput("\r"); // toggle enabled from true -> false
        assert.ok(component.render(80).some((line) => line.includes("Preview: disabled")));
        component.handleInput("\u0013"); // Ctrl+S -> save

        const result = await donePromise;
        component.dispose?.();
        return result;
      },
    },
  });

  const result = await openSettingsDialog(ctx, {
    schema,
    adapter,
    preferredWidth: 78,
    overlayOptions: { offsetY: 1, maxHeight: "60%" },
    renderPreview: ({ values, maxRows }) => Array(maxRows + 1).fill(`Preview: ${values.enabled ? "enabled" : "disabled"}`),
    onApply: (next, meta) => {
      applied.push({ next, meta });
    },
  });

  assert.equal(customCalls, 1);
  assert.equal(tui.hideOverlayCalls, 0);
  assert.equal(capturedOverlayOpts.overlay, true);
  assert.equal(capturedOverlayOpts.overlayOptions.anchor, "center");
  assert.equal(capturedOverlayOpts.overlayOptions.width, 78);
  assert.equal(capturedOverlayOpts.overlayOptions.minWidth, 44);
  assert.equal(capturedOverlayOpts.overlayOptions.maxHeight, "60%");
  assert.equal(capturedOverlayOpts.overlayOptions.offsetY, 1);

  assert.equal(result.mode, "tui");
  assert.equal(result.opened, true);
  assert.equal(result.saved, true);
  assert.equal(result.closedBy, "save");
  assert.equal(result.values.enabled, false);
  assert.equal(result.scope, "global");
  assert.equal(applied.length, 1);
  assert.equal(applied[0].next.enabled, false);
  assert.deepEqual(applied[0].meta.writtenKeys, ["enabled"]);
});

test("TUI mode singleton registry focuses existing overlay, calls navigateTo, and returns reused result", async () => {
  const schema = createTestSchema("tui-singleton-test");
  const adapter = createMemoryStorageAdapter();
  const tui = createMockTui();
  const theme = createMockTheme();
  const keybindings = createMockKeybindings();

  let customCalls = 0;
  let focusCalls = 0;
  let mountedComponent = null;
  let finishOverlay = null;
  let overlayReadyResolve;
  const overlayReady = new Promise((resolve) => {
    overlayReadyResolve = resolve;
  });

  const { ctx } = createBaseContext({
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async (factory, opts) => {
        customCalls++;
        let resolved;
        const donePromise = new Promise((resolve) => {
          resolved = resolve;
          finishOverlay = resolve;
        });
        mountedComponent = await factory(tui, theme, keybindings, (res) => resolved(res));
        opts?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden() {
            return false;
          },
          focus() {
            focusCalls++;
          },
          unfocus() {},
          isFocused() {
            return true;
          },
          getBounds() {
            return undefined;
          },
        });
        overlayReadyResolve();
        return await donePromise;
      },
    },
  });

  const firstPromise = openSettingsDialog(ctx, { schema, adapter });
  await overlayReady;

  const reusedResult = await openSettingsDialog(ctx, {
    schema,
    adapter,
    initialTab: "advanced",
    initialField: "retries",
  });

  assert.equal(customCalls, 1);
  assert.equal(focusCalls, 1);
  assert.equal(reusedResult.mode, "tui");
  assert.equal(reusedResult.opened, false);
  assert.equal(reusedResult.reusedExisting, true);
  assert.equal(reusedResult.saved, false);
  assert.equal(reusedResult.closedBy, "reused");
  assert.equal(reusedResult.values.retries, 3);

  // Verify navigateTo actually switched to the advanced tab in the rendered output
  const renderedAfterReuse = mountedComponent.render(80).join("\n");
  assert.match(renderedAfterReuse, /Retries/);

  // Close first overlay cleanly via Esc
  mountedComponent.handleInput("\u001b");
  const firstResult = await firstPromise;
  assert.equal(firstResult.opened, true);
  assert.equal(firstResult.closedBy, "escape");
  assert.equal(typeof finishOverlay, "function");
});

test("TUI mode AbortSignal aborts open overlay via component.abort() and cleans up singleton registry", async () => {
  const schema = createTestSchema("tui-abort-test");
  const adapter = createMemoryStorageAdapter();
  const tui = createMockTui();
  const theme = createMockTheme();
  const keybindings = createMockKeybindings();

  let customCalls = 0;
  let readyResolve;
  const readyPromise = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const controller = new AbortController();

  const { ctx } = createBaseContext({
    mode: "tui",
    hasUI: true,
    signal: controller.signal,
    ui: {
      theme,
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async (factory, opts) => {
        customCalls++;
        let resolved;
        const donePromise = new Promise((resolve) => {
          resolved = resolve;
        });
        const comp = await factory(tui, theme, keybindings, (res) => resolved(res));
        opts?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden() {
            return false;
          },
          focus() {},
          unfocus() {},
          isFocused() {
            return true;
          },
          getBounds() {
            return undefined;
          },
        });
        readyResolve(comp);
        const result = await donePromise;
        comp.dispose?.();
        return result;
      },
    },
  });

  const openPromise = openSettingsDialog(ctx, { schema, adapter });
  await readyPromise;

  controller.abort();
  const abortedResult = await openPromise;

  assert.equal(tui.hideOverlayCalls, 0);
  assert.equal(abortedResult.mode, "tui");
  assert.equal(abortedResult.opened, true);
  assert.equal(abortedResult.saved, false);
  assert.equal(abortedResult.closedBy, "abort");

  // Re-opening after abort must NOT reuse a stale entry; it should mount a new overlay.
  const controller2 = new AbortController();
  const { ctx: ctx2 } = createBaseContext({
    mode: "tui",
    hasUI: true,
    signal: controller2.signal,
    ui: {
      ...ctx.ui,
      custom: async (factory, opts) => {
        customCalls++;
        let resolved;
        const donePromise = new Promise((resolve) => {
          resolved = resolve;
        });
        const comp = await factory(tui, theme, keybindings, (res) => resolved(res));
        opts?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden() {},
          focus() {},
          unfocus() {},
          isFocused() {},
          getBounds() {
            return undefined;
          },
        });
        comp.handleInput("\u001b");
        return await donePromise;
      },
    },
  });

  const reopened = await openSettingsDialog(ctx2, { schema, adapter });
  assert.equal(customCalls, 2);
  assert.equal(reopened.opened, true);
  assert.equal(reopened.closedBy, "escape");
});

test("RPC fallback edits all field kinds, validates retries, switches scope, restores defaults, and saves in draft mode", async () => {
  const schema = createTestSchema("rpc-draft-test");
  const adapter = createMemoryStorageAdapter();
  const applied = [];
  let previewCalls = 0;

  // Scripted user choices matched by prompt title / options
  const selectQueue = [
    // 1. Toggle boolean
    (opts) => opts.find((o) => o.includes("Enabled:")),
    () => "No",
    // 2. Enum
    (opts) => opts.find((o) => o.includes("Mode:")),
    (opts) => opts.find((o) => o.startsWith("Strict")),
    // 3. MultiSelect: toggle "Beta", add custom item "ops", then Done
    (opts) => opts.find((o) => o.includes("Tags:")),
    (opts) => opts.find((o) => o.includes("Beta")),
    (opts) => opts.find((o) => o.includes("Add custom")),
    () => "Done",
    // 4. Single-line string (invalid first -> retry -> valid)
    (opts) => opts.find((o) => o.includes("Prefix:")),
    // 5. Multiline string (editor)
    (opts) => opts.find((o) => o.includes("Notes:")),
    // 6. Integer (invalid first -> retry -> valid)
    (opts) => opts.find((o) => o.includes("Retries:")),
    // 7. Custom with rpcEdit
    (opts) => opts.find((o) => o.includes("Custom Editable:")),
    // 8. Custom without rpcEdit -> triggers notify
    (opts) => opts.find((o) => o.includes("Custom TUI Only:")),
    // 9. Switch Save Scope: Global -> Project
    (opts) => opts.find((o) => o.startsWith("Save scope:")),
    // 10. Save changes
    (opts) => opts.find((o) => o.startsWith("Save changes")),
  ];

  const inputQueue = [
    "ops", // custom multiSelect item
    "x", // invalid Prefix (minLength: 2)
    "  ok-prefix  ", // valid Prefix (trimmed -> "ok-prefix")
    "not-a-number", // invalid Retries
    "7", // valid Retries
  ];

  const editorQueue = ["line1\nline2"];

  const { ctx, notifications } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createMockTheme(),
      notify: (message, type = "info") => {
        notifications.push({ message, type });
      },
      select: async (_title, options) => {
        const next = selectQueue.shift();
        assert.ok(next, `Unexpected select call: ${_title}`);
        return next(options);
      },
      input: async () => {
        assert.ok(inputQueue.length > 0, "Unexpected input call");
        return inputQueue.shift();
      },
      editor: async () => {
        assert.ok(editorQueue.length > 0, "Unexpected editor call");
        return editorQueue.shift();
      },
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() should not be called in RPC mode");
      },
    },
  });

  const result = await openSettingsDialog(ctx, {
    schema,
    adapter,
    renderPreview: () => {
      previewCalls++;
      return ["Inline preview"];
    },
    onApply: (next, meta) => {
      applied.push({ next, meta });
    },
  });

  assert.equal(selectQueue.length, 0);
  assert.equal(inputQueue.length, 0);
  assert.equal(editorQueue.length, 0);
  assert.equal(previewCalls, 0);

  assert.equal(result.mode, "rpc");
  assert.equal(result.opened, true);
  assert.equal(result.saved, true);
  assert.equal(result.closedBy, "save");
  assert.equal(result.scope, "project");
  assert.equal(result.values.enabled, false);
  assert.equal(result.values.mode, "strict");
  assert.deepEqual(result.values.tags, ["core", "beta", "ops"]);
  assert.equal(result.values.prefix, "ok-prefix");
  assert.equal(result.values.notes, "line1\nline2");
  assert.equal(result.values.retries, 7);
  assert.equal(result.values.customEditable, "v1-edited");

  // Warnings from invalid prefix, invalid retries, and info notice for TUI-only custom field
  assert.ok(notifications.some((n) => n.type === "warning"));
  assert.ok(notifications.some((n) => n.message.includes("requires interactive TUI mode")));
  assert.equal(applied.length, 1);
  assert.equal(applied[0].meta.scope, "project");
});

test("RPC fallback supports immediate saveMode, restoreDefaults, and ConcurrencyConflictError handling", async () => {
  const schema = createTestSchema("rpc-immediate-test");
  const adapter = createMemoryStorageAdapter();
  const store = createSettingsStore(schema, { adapter });
  const loaded = await store.load({ trustedProject: true });

  // Simulate external write after initial load to trigger ConcurrencyConflictError on first save
  await adapter.writeLayer("global", { retries: 9 });

  const applied = [];
  const selectQueue = [
    // 1. Edit ratio -> triggers save -> hits ConcurrencyConflictError -> reloads latest (retries: 9)
    (opts) => opts.find((o) => o.includes("Ratio:")),
    // 2. Edit enabled -> succeeds immediately
    (opts) => opts.find((o) => o.includes("Enabled:")),
    () => "No",
    // 3. Restore defaults -> confirmed -> clears global layer immediately
    (opts) => opts.find((o) => o === "Restore defaults"),
    // 4. Done
    (opts) => opts.find((o) => o === "Done"),
  ];
  const inputQueue = ["0.75"];
  const confirmQueue = [true];

  const { ctx, notifications } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createMockTheme(),
      notify: (message, type = "info") => {
        notifications.push({ message, type });
      },
      select: async (_title, options) => {
        const next = selectQueue.shift();
        assert.ok(next, `Unexpected select call: ${_title}`);
        return next(options);
      },
      input: async () => inputQueue.shift(),
      editor: async () => undefined,
      confirm: async () => confirmQueue.shift() ?? false,
      custom: async () => {
        throw new Error("custom() should not be called in RPC mode");
      },
    },
  });

  const result = await runRpcSettingsMenu(ctx, schema, store, loaded, {
    saveMode: "immediate",
    onApply: (next, meta) => {
      applied.push({ next, meta });
    },
  });

  assert.equal(result.mode, "rpc");
  assert.equal(result.opened, true);
  assert.equal(result.saved, true);
  assert.equal(result.closedBy, "immediate");
  assert.equal(result.values.enabled, true); // restored to default
  assert.equal(result.values.retries, 3); // restored to default
  assert.ok(
    notifications.some((n) => n.type === "error" && n.message.includes("modified externally")),
  );
  // First apply was enabled=false, second apply was restoreDefaults
  assert.equal(applied.length, 2);
  assert.equal(applied[0].next.enabled, false);
  assert.equal(applied[1].next.enabled, true);
});

test("Headless modes (print, json, and hasUI: false) return structured result without UI calls", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-headless-"));
  try {
    const schema = createTestSchema("headless-test");
    const globalPath = path.join(tempRoot, "global.json");
    const projectPath = path.join(tempRoot, "project.json");
    fs.writeFileSync(globalPath, JSON.stringify({ retries: 5 }), "utf8");
    fs.writeFileSync(projectPath, JSON.stringify({ enabled: false }), "utf8");
    let previewCalls = 0;

    for (const [mode, hasUI] of [
      ["print", false],
      ["json", false],
      ["tui", false],
      ["rpc", false],
    ]) {
      const { ctx } = createBaseContext({
        mode,
        hasUI,
        cwd: tempRoot,
        isProjectTrusted: () => true,
      });

      const result = await openSettingsDialog(ctx, {
        schema,
        globalPath,
        projectPath,
        renderPreview: () => {
          previewCalls++;
          return ["Inline preview"];
        },
      });

      assert.equal(result.mode, mode);
      assert.equal(result.opened, false);
      assert.equal(result.saved, false);
      assert.equal(result.closedBy, "headless");
      assert.equal(result.values.retries, 5);
      assert.equal(result.values.enabled, false);
      assert.equal(result.paths.global, globalPath);
      assert.equal(result.paths.project, projectPath);
    }
    assert.equal(previewCalls, 0);

    // Untrusted project in headless mode ignores project layer
    const { ctx: untrustedCtx } = createBaseContext({
      mode: "json",
      hasUI: false,
      cwd: tempRoot,
      isProjectTrusted: () => false,
    });
    const untrustedResult = await openSettingsDialog(untrustedCtx, {
      schema,
      globalPath,
      projectPath,
    });
    assert.equal(untrustedResult.values.enabled, true);
    assert.equal(untrustedResult.values.retries, 5);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Subpath exports expose all expected symbols across root, /schema, /store, /dialog, and /adapter", () => {
  assert.equal(typeof rootPkg.defineSettings, "function");
  assert.equal(typeof rootPkg.field, "object");
  assert.equal(typeof rootPkg.createSettingsStore, "function");
  assert.equal(typeof rootPkg.SettingsDialogComponent, "function");
  assert.equal(typeof rootPkg.openSettingsDialog, "function");
  assert.equal(typeof rootPkg.runRpcSettingsMenu, "function");

  assert.equal(schemaPkg.defineSettings, rootPkg.defineSettings);
  assert.equal(schemaPkg.field, rootPkg.field);
  assert.equal(schemaPkg.isPersistedFieldDef, rootPkg.isPersistedFieldDef);
  assert.equal(typeof schemaPkg.isPersistedFieldDef, "function");
  assert.equal(typeof schemaPkg.validateFieldValue, "function");
  assert.equal(typeof schemaPkg.parseModelIdentity, "function");
  assert.equal(typeof schemaPkg.formatModelIdentity, "function");
  assert.equal(typeof schemaPkg.getSupportedThinkingLevelsForModel, "function");
  assert.equal(typeof schemaPkg.parseFieldProvenance, "function");
  assert.equal(schemaPkg.parseFieldProvenance, rootPkg.parseFieldProvenance);
  assert.ok(Array.isArray(schemaPkg.MODEL_THINKING_LEVELS));

  assert.equal(storePkg.createSettingsStore, rootPkg.createSettingsStore);
  assert.equal(storePkg.ConcurrencyConflictError, ConcurrencyConflictError);
  assert.equal(typeof storePkg.createJsonFileStorageAdapter, "function");
  assert.equal(typeof storePkg.createSessionStorageAdapter, "function");
  assert.equal(typeof storePkg.createLayeredStorageAdapter, "function");
  assert.equal(storePkg.createLayeredStorageAdapter, rootPkg.createLayeredStorageAdapter);

  assert.equal(dialogPkg.SettingsDialogComponent, rootPkg.SettingsDialogComponent);
  assert.equal(typeof dialogPkg.ConfirmRoute, "function");
  assert.equal(typeof dialogPkg.TextInputRoute, "function");
  assert.equal(typeof dialogPkg.SelectRoute, "function");
  assert.equal(typeof dialogPkg.MultiSelectRoute, "function");
  assert.equal(typeof dialogPkg.ModelPickerRoute, "function");
  assert.equal(dialogPkg.TextViewerRoute, rootPkg.TextViewerRoute);
  assert.equal(typeof dialogPkg.TextViewerRoute, "function");
  assert.equal(dialogPkg.renderMarkdownToAnsi, rootPkg.renderMarkdownToAnsi);
  assert.equal(typeof dialogPkg.renderMarkdownToAnsi, "function");
  assert.equal(dialogPkg.DynamicPickerRoute, rootPkg.DynamicPickerRoute);
  assert.equal(typeof dialogPkg.DynamicPickerRoute, "function");

  assert.equal(adapterPkg.openSettingsDialog, rootPkg.openSettingsDialog);
  assert.equal(adapterPkg.runRpcSettingsMenu, rootPkg.runRpcSettingsMenu);
});

test("RPC discard confirmation and AbortSignal handling work cleanly in both TUI and RPC modes", async () => {
  const schema = createTestSchema("abort-discard-test");
  const adapter = createMemoryStorageAdapter();

  // Pre-aborted TUI signal returns immediately without mounting custom overlay
  const preAborted = new AbortController();
  preAborted.abort();
  let customCalled = false;
  const { ctx: preAbortedCtx } = createBaseContext({
    mode: "tui",
    hasUI: true,
    signal: preAborted.signal,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => {
        customCalled = true;
        throw new Error("Should not mount custom overlay when signal is already aborted");
      },
    },
  });
  const preAbortedResult = await openSettingsDialog(preAbortedCtx, { schema, adapter });
  assert.equal(customCalled, false);
  assert.equal(preAbortedResult.opened, false);
  assert.equal(preAbortedResult.closedBy, "abort");

  // RPC draft mode: edit boolean -> Discard & close -> reject confirm -> Discard & close -> accept confirm
  const rpcSelects = [
    (opts) => opts.find((o) => o.includes("Enabled:")),
    () => "No",
    (opts) => opts.find((o) => o === "Discard & close"),
    (opts) => opts.find((o) => o === "Discard & close"),
  ];
  const rpcConfirms = [false, true];
  const { ctx: rpcCtx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async (_title, options) => rpcSelects.shift()(options),
      confirm: async () => rpcConfirms.shift(),
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => {
        throw new Error("Should not call custom");
      },
    },
  });
  const discardResult = await openSettingsDialog(rpcCtx, { schema, adapter });
  assert.equal(discardResult.opened, true);
  assert.equal(discardResult.saved, false);
  assert.equal(discardResult.closedBy, "cancel");
  assert.equal(discardResult.values.enabled, true);

  // RPC AbortSignal during menu prompt
  const rpcAbort = new AbortController();
  const { ctx: rpcAbortCtx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    signal: rpcAbort.signal,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async () => {
        rpcAbort.abort();
        return undefined;
      },
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async () => {
        throw new Error("Should not call custom");
      },
    },
  });
  const rpcAbortResult = await openSettingsDialog(rpcAbortCtx, { schema, adapter });
  assert.equal(rpcAbortResult.opened, true);
  assert.equal(rpcAbortResult.saved, false);
  assert.equal(rpcAbortResult.closedBy, "abort");
});

test("openSettingsDialog forwards schema and call-time settingsFile to store paths", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-adapter-sf-"));
  try {
    const agentDir = path.join(tempRoot, "agent");
    const cwd = path.join(tempRoot, "project");
    fs.mkdirSync(path.join(agentDir, "nested"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".pi", "nested"), { recursive: true });

    fs.writeFileSync(
      path.join(agentDir, "my-ext.json"),
      JSON.stringify({ retries: 8 }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "my-ext.json"),
      JSON.stringify({ enabled: false }),
      "utf8",
    );

    fs.writeFileSync(
      path.join(agentDir, "nested", "override.json"),
      JSON.stringify({ mode: "strict" }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(cwd, ".pi", "nested", "override.json"),
      JSON.stringify({ retries: 6 }),
      "utf8",
    );

    const baseSchema = createTestSchema("adapter-sf-test");
    const schemaWithSf = defineSettings({
      ...baseSchema.config,
      id: "adapter-sf-schema",
      settingsFile: "my-ext.json",
    });

    const { ctx } = createBaseContext({
      mode: "json",
      hasUI: false,
      cwd,
      isProjectTrusted: () => true,
    });

    // Schema-level settingsFile
    const schemaResult = await openSettingsDialog(ctx, {
      schema: schemaWithSf,
      agentDir,
    });
    assert.deepEqual(schemaResult.paths, {
      global: path.join(agentDir, "my-ext.json"),
      project: path.join(cwd, ".pi", "my-ext.json"),
    });
    assert.equal(schemaResult.values.retries, 8);
    assert.equal(schemaResult.values.enabled, false);

    // Call-time settingsFile override
    const overrideResult = await openSettingsDialog(ctx, {
      schema: schemaWithSf,
      agentDir,
      settingsFile: "nested/override.json",
    });
    assert.deepEqual(overrideResult.paths, {
      global: path.join(agentDir, "nested", "override.json"),
      project: path.join(cwd, ".pi", "nested", "override.json"),
    });
    assert.equal(overrideResult.values.mode, "strict");
    assert.equal(overrideResult.values.retries, 6);
    assert.equal(overrideResult.values.enabled, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("openSettingsDialog auto-discovers Pi ctx.modelRegistry and ctx.scopedModels in both TUI and RPC modes", async () => {
  const modelCatalog = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh" },
    },
    {
      provider: "openai",
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      reasoning: true,
    },
    {
      provider: "google",
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      reasoning: false,
    },
  ];
  const scoped = [{ model: modelCatalog[0], thinkingLevel: "high" }];

  const schema = defineSettings({
    id: "model-adapter-test",
    title: "Model Adapter Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      summaryModel: field.model({
        label: "Summary model",
        default: null,
        emptyLabel: "Active model",
      }),
    },
  });

  // 1. TUI mode automatically pulls from ctx.modelRegistry.getAvailable() and ctx.scopedModels
  const tuiAdapter = createMemoryStorageAdapter();
  const tui = createMockTui();
  const theme = createMockTheme();
  const keybindings = createMockKeybindings();

  const { ctx: tuiCtx } = createBaseContext({
    mode: "tui",
    hasUI: true,
    modelRegistry: { getAvailable: () => modelCatalog },
    scopedModels: scoped,
    ui: {
      theme,
      notify: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      editor: async () => undefined,
      custom: async (factory, opts) => {
        let resolved;
        const donePromise = new Promise((resolve) => {
          resolved = resolve;
        });
        const comp = await factory(tui, theme, keybindings, (res) => resolved(res));
        opts?.onHandle?.({
          hide() {},
          setHidden() {},
          isHidden: () => false,
          focus() {},
          unfocus() {},
          isFocused: () => true,
          getBounds: () => undefined,
        });

        comp.render(84);
        // Enter -> opens ModelPickerRoute (starts on Scoped with claude-sonnet-4-5)
        comp.handleInput("\r");
        // Tab -> switches to All, type "gpt" -> matches openai/gpt-5-mini
        comp.handleInput("\t");
        for (const ch of "gpt") comp.handleInput(ch);
        // Enter -> Step 2 (thinking level, preselected "medium")
        comp.handleInput("\r");
        // Down -> "high", Enter -> commit { model: "openai/gpt-5-mini", thinkingLevel: "high" }
        comp.handleInput("\u001b[B");
        comp.handleInput("\r");
        // Ctrl+S -> save
        comp.handleInput("\u0013");

        const result = await donePromise;
        comp.dispose?.();
        return result;
      },
    },
  });

  const tuiResult = await openSettingsDialog(tuiCtx, { schema, adapter: tuiAdapter });
  assert.equal(tuiResult.saved, true);
  assert.deepEqual(tuiResult.values.summaryModel, {
    model: "openai/gpt-5-mini",
    thinkingLevel: "high",
  });

  // 2. RPC mode supports scope toggle, text filter, Step 1 -> Step 2 -> Back -> final commit
  const rpcAdapter = createMemoryStorageAdapter();
  const rpcSelectQueue = [
    // Root menu: choose Summary model
    (opts) => opts.find((o) => o.includes("Summary model:")),
    // Step 1 (Scoped): toggle to All
    (opts) => opts.find((o) => o.includes("Switch to All")),
    // Step 1 (All): filter by text
    (opts) => opts.find((o) => o.includes("Filter models")),
    // Step 1 (filtered "gemini"): pick google/gemini-2.5-flash
    (opts) => opts.find((o) => o.includes("google/gemini-2.5-flash")),
    // Step 2 (off only): go back to models
    (opts) => opts.find((o) => o.includes("Back to models")),
    // Step 1: clear filter
    (opts) => opts.find((o) => o === "Clear search filter"),
    // Step 1: pick anthropic/claude-sonnet-4-5
    (opts) => opts.find((o) => o.includes("anthropic/claude-sonnet-4-5")),
    // Step 2: pick xhigh
    (opts) => opts.find((o) => o.startsWith("xhigh —")),
    // Root menu: Save changes
    (opts) => opts.find((o) => o.startsWith("Save changes")),
  ];
  const rpcInputQueue = ["gemini"];

  const { ctx: rpcCtx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    modelRegistry: { getAvailable: () => modelCatalog },
    scopedModels: scoped,
    ui: {
      theme,
      notify: () => {},
      select: async (_title, options) => {
        const next = rpcSelectQueue.shift();
        assert.ok(next, `Unexpected RPC select: ${_title}`);
        return next(options);
      },
      input: async () => rpcInputQueue.shift(),
      editor: async () => undefined,
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() must not be called in RPC mode");
      },
    },
  });

  const rpcResult = await openSettingsDialog(rpcCtx, { schema, adapter: rpcAdapter });
  assert.equal(rpcSelectQueue.length, 0);
  assert.equal(rpcInputQueue.length, 0);
  assert.equal(rpcResult.saved, true);
  assert.deepEqual(rpcResult.values.summaryModel, {
    model: "anthropic/claude-sonnet-4-5",
    thinkingLevel: "xhigh",
  });
});

test("RPC mode with field.model({ includeThinking: false }) selects model in 1 step and supports clearing", async () => {
  const modelCatalog = [
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      reasoning: true,
    },
    {
      provider: "openai",
      id: "gpt-5-mini",
      name: "GPT-5 Mini",
      reasoning: true,
    },
  ];
  const scoped = [{ model: modelCatalog[0], thinkingLevel: "high" }];

  const schema = defineSettings({
    id: "model-only-rpc-test",
    title: "Model Only RPC Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      modelOnly: field.model({
        label: "Model only",
        includeThinking: false,
        default: null,
        emptyLabel: "Inherit active",
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const seenTitles = [];
  const selectQueue = [
    // Root menu -> Model only
    (opts) => opts.find((o) => o.includes("Model only:")),
    // 1-step model picker (no Step 1/2 prefix) -> pick anthropic/claude-sonnet-4-5
    (opts) => opts.find((o) => o.includes("anthropic/claude-sonnet-4-5")),
    // Root menu directly (no Step 2) -> Save changes
    (opts) => opts.find((o) => o.startsWith("Save changes")),
  ];

  const { ctx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    modelRegistry: { getAvailable: () => modelCatalog },
    scopedModels: scoped,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async (title, options) => {
        seenTitles.push(title);
        const next = selectQueue.shift();
        assert.ok(next, `Unexpected RPC select: ${title}`);
        return next(options);
      },
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() must not be called in RPC mode");
      },
    },
  });

  const pickedResult = await openSettingsDialog(ctx, { schema, adapter });
  assert.equal(selectQueue.length, 0);
  assert.equal(pickedResult.saved, true);
  assert.equal(pickedResult.values.modelOnly, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(seenTitles, [
    "Model Only RPC Test",
    "Model only — Select model (Scoped)",
    "Model Only RPC Test",
  ]);

  // Re-open with persisted string value, verify "(current)" badge, then clear back to null
  const clearSelectQueue = [
    (opts) => opts.find((o) => o.includes("Model only: anthropic/claude-sonnet-4-5")),
    (opts) => {
      assert.ok(opts.some((o) => o.includes("anthropic/claude-sonnet-4-5") && o.includes("(current)")));
      return opts.find((o) => o.startsWith("Inherit active —"));
    },
    (opts) => opts.find((o) => o.startsWith("Save changes")),
  ];

  const { ctx: clearCtx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    modelRegistry: { getAvailable: () => modelCatalog },
    scopedModels: scoped,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async (title, options) => {
        const next = clearSelectQueue.shift();
        assert.ok(next, `Unexpected RPC select: ${title}`);
        return next(options);
      },
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() must not be called in RPC mode");
      },
    },
  });

  const clearedResult = await openSettingsDialog(clearCtx, { schema, adapter });
  assert.equal(clearSelectQueue.length, 0);
  assert.equal(clearedResult.saved, true);
  assert.equal(clearedResult.values.modelOnly, null);
});

test("RPC menu passes draft values to format(value, values)", async () => {
  const schema = defineSettings({
    id: "rpc-draft-format-test",
    title: "RPC Draft Format Test",
    scopes: ["global"],
    saveMode: "draft",
    fields: {
      mode: field.enum({
        label: "Mode",
        default: "fast",
        options: [
          { value: "fast", label: "Fast" },
          { value: "safe", label: "Safe" },
        ],
      }),
      threshold: field.integer({
        label: "Threshold",
        default: 10,
        format: (val, values) => `${val} (${values?.mode ?? "unknown"})`,
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const rootMenus = [];
  const selectQueue = [
    // 1. Initial root menu: check Threshold: 10 (fast), pick Mode
    (opts) => {
      rootMenus.push(opts);
      return opts.find((o) => o.includes("Mode:"));
    },
    // 2. Pick Safe
    (opts) => opts.find((o) => o === "Safe"),
    // 3. Updated root menu: check Threshold: 10 (safe), then Discard & close
    (opts) => {
      rootMenus.push(opts);
      return opts.find((o) => o === "Discard & close");
    },
  ];

  const { ctx } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createMockTheme(),
      notify: () => {},
      select: async (_title, options) => {
        const next = selectQueue.shift();
        assert.ok(next, `Unexpected RPC select: ${_title}`);
        return next(options);
      },
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() must not be called in RPC mode");
      },
    },
  });

  const result = await openSettingsDialog(ctx, { schema, adapter });
  assert.equal(selectQueue.length, 0);
  assert.equal(result.closedBy, "cancel");
  assert.ok(rootMenus[0].some((o) => o.includes("Threshold: 10 (fast)")));
  assert.ok(rootMenus[1].some((o) => o.includes("Threshold: 10 (safe)")));
});

test("RPC mode handles dynamic labels, ineligible rows, out-of-scope rows, view, external, picker, and normalizeDraft", async () => {
  const rpcRunCalls = [];
  const schema = defineSettings({
    id: "rpc-phase1-test",
    title: "RPC Phase 1 Test",
    scopes: ["global", "project"],
    defaultScope: "global",
    saveMode: "draft",
    normalizeDraft: (draft, changedKey) => {
      if (changedKey === "enabled" && !draft.enabled) {
        return { ...draft, count: 1 };
      }
      return draft;
    },
    fields: {
      enabled: field.boolean({
        label: "Master Enabled",
        default: true,
      }),
      count: field.integer({
        label: (v) => (v.enabled ? "Active Count" : "Paused Count"),
        default: 5,
        min: 1,
        max: 20,
        eligible: (v) =>
          v.enabled ? true : { eligible: false, reason: "Enable Master Enabled to edit Count." },
      }),
      globalOnlyFlag: field.boolean({
        label: "Global Policy",
        default: true,
        scopes: ["global"],
      }),
      projectOnlyFlag: field.boolean({
        label: "Project Override",
        default: false,
        scopes: ["project"],
      }),
      report: field.view({
        label: "Status View",
        value: "Read…",
        content: async ({ scope }) => `Report for ${scope}`,
      }),
      extWithRpc: field.external({
        label: "External Action",
        summary: async ({ scope }) => `Ready (${scope})`,
        openSubroute: () => ({ render: () => ["x"], invalidate: () => {} }),
        rpcRun: async (_ctx, draft, scope) => {
          rpcRunCalls.push({ enabled: draft.enabled, scope });
        },
      }),
      extTuiOnly: field.external({
        label: "External TUI Only",
        openSubroute: () => ({ render: () => ["y"], invalidate: () => {} }),
      }),
      profile: field.picker({
        label: "Profile",
        default: null,
        allowClear: true,
        emptyLabel: "None",
        loadOptions: async () => [
          { id: "alpha", value: "alpha", label: "Alpha", badge: "v1" },
          {
            id: "locked",
            value: "locked",
            label: "Locked",
            disabled: true,
            disabledReason: "Profile is locked.",
          },
          { id: "bad", value: "bad", label: "Bad Profile" },
        ],
        validateSelection: async (opt) =>
          opt.value === "bad" ? "Bad Profile failed validation." : true,
      }),
    },
  });

  const adapter = createMemoryStorageAdapter();
  const rootMenus = [];

  const selectQueue = [
    // 1. Check initial menu (Active Count, [Project only], Ready (global)) -> pick Project Override (blocked)
    (opts) => {
      rootMenus.push(opts);
      return opts.find((o) => o.includes("Project Override:") && o.includes("[Project only]"));
    },
    // 2. View report -> notifies loaded content
    (opts) => opts.find((o) => o.includes("Status View:")),
    // 3. Run External Action (with rpcRun)
    (opts) => opts.find((o) => o.includes("External Action: Ready (global)")),
    // 4. Trigger External TUI Only -> notifies TUI-only
    (opts) => opts.find((o) => o.includes("External TUI Only:")),
    // 5. Open Profile picker -> disabled option -> invalid option -> valid Alpha
    (opts) => opts.find((o) => o.includes("Profile:")),
    (opts) => opts.find((o) => o.includes("Locked [disabled]")),
    (opts) => opts.find((o) => o.includes("Bad Profile")),
    (opts) => opts.find((o) => o.includes("Alpha [v1]")),
    // 6. Re-open Profile picker -> clear to None -> then re-open & pick Alpha again
    (opts) => opts.find((o) => o.includes("Profile: alpha")),
    (opts) => opts.find((o) => o.startsWith("None —")),
    (opts) => opts.find((o) => o.includes("Profile: None")),
    (opts) => opts.find((o) => o.includes("Alpha [v1]")),
    // 7. Toggle Master Enabled to Disabled -> normalizeDraft resets count to 1 & label flips to Paused Count
    (opts) => opts.find((o) => o.includes("Master Enabled:")),
    () => "Disabled",
    // 8. Check menu has "Paused Count: 1 [default] * [unavailable]" and try selecting it (ineligible!)
    (opts) => {
      rootMenus.push(opts);
      return opts.find((o) => o.includes("Paused Count:") && o.includes("[unavailable]"));
    },
    // 9. Switch Save scope to Project
    (opts) => opts.find((o) => o.startsWith("Save scope:")),
    // 10. Try Global Policy [Global only] -> blocked with warning
    (opts) => {
      rootMenus.push(opts);
      return opts.find((o) => o.includes("Global Policy:") && o.includes("[Global only]"));
    },
    // 11. Edit Project Override -> Enabled
    (opts) => opts.find((o) => o.includes("Project Override:")),
    () => "Enabled",
    // 12. Save changes
    (opts) => opts.find((o) => o.startsWith("Save changes")),
  ];

  const { ctx, notifications } = createBaseContext({
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createMockTheme(),
      notify: (message, type = "info") => {
        notifications.push({ message, type });
      },
      select: async (_title, options) => {
        const next = selectQueue.shift();
        assert.ok(next, `Unexpected RPC select: ${_title}`);
        return next(options);
      },
      input: async () => undefined,
      editor: async () => undefined,
      confirm: async () => true,
      custom: async () => {
        throw new Error("custom() must not be called in RPC mode");
      },
    },
  });

  const result = await openSettingsDialog(ctx, { schema, adapter });
  assert.equal(selectQueue.length, 0);
  assert.equal(result.saved, true);
  assert.equal(result.scope, "project");
  assert.equal(result.values.enabled, false);
  assert.equal(result.values.count, 1); // updated atomically by normalizeDraft
  assert.equal(result.values.profile, "alpha");
  assert.equal(result.values.projectOnlyFlag, true);
  assert.equal("report" in result.values, false);
  assert.equal("extWithRpc" in result.values, false);

  assert.ok(rootMenus[0].some((o) => o.includes("Active Count: 5")));
  assert.ok(rootMenus[1].some((o) => o.includes("Paused Count: 1")));
  assert.ok(rootMenus[2].some((o) => o.includes("Global Policy:") && o.includes("[Global only]")));

  assert.deepEqual(rpcRunCalls, [{ enabled: true, scope: "global" }]);
  assert.ok(notifications.some((n) => n.type === "info" && n.message === "Report for global"));
  assert.ok(notifications.some((n) => n.type === "info" && n.message.includes("requires interactive TUI mode")));
  assert.ok(notifications.some((n) => n.type === "warning" && n.message === "Profile is locked."));
  assert.ok(notifications.some((n) => n.type === "warning" && n.message === "Bad Profile failed validation."));
  assert.ok(notifications.some((n) => n.type === "warning" && n.message === "Enable Master Enabled to edit Count."));
  assert.ok(notifications.some((n) => n.type === "warning" && n.message.includes("Switch Save scope to Project")));
  assert.ok(notifications.some((n) => n.type === "warning" && n.message.includes("Switch Save scope to Global")));
});

test("openSettingsDialog supports session option, external signal abort, and RPC session-draft flow", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-settings-adapter-session-"));
  const agentDir = path.join(tmp, "agent");
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });

  const entries = [];
  const schema = defineSettings({
    id: "adapter-session-draft",
    title: "Adapter Session Draft",
    settingsFile: "adapter-session.json",
    scopes: ["global", "project", "session"],
    defaultScope: "global",
    saveMode: "session-draft",
    fields: {
      maxOpen: field.integer({ label: "Max open", default: 8, min: 1, max: 64 }),
    },
  });

  const sessionOpts = {
    entryType: "adapter:session:v1",
    appendEntry: (type, data) => entries.push({ type: "custom", customType: type, data }),
    getEntries: () => entries,
  };

  try {
    // 1. External options.signal aborts an open TUI overlay cleanly
    const externalController = new AbortController();
    let resolveCustom;
    const { ctx: tuiCtx } = createBaseContext({
      mode: "tui",
      hasUI: true,
      cwd,
      ui: {
        theme: createMockTheme(),
        notify: () => {},
        select: async () => undefined,
        confirm: async () => false,
        input: async () => undefined,
        editor: async () => undefined,
        custom: (factory) =>
          new Promise((resolve) => {
            resolveCustom = resolve;
            factory(createMockTui(), createMockTheme(), createMockKeybindings(), resolve);
          }),
      },
    });

    const pendingTui = openSettingsDialog(tuiCtx, {
      schema,
      agentDir,
      cwd,
      session: sessionOpts,
      signal: externalController.signal,
    });
    await new Promise((r) => setTimeout(r, 15));
    externalController.abort();
    const tuiRes = await pendingTui;
    assert.equal(tuiRes.closedBy, "abort");

    // 2. RPC mode in session-draft: live edit saves to session, then "Save to Global*" persists global & prunes session
    const selectQueue = [
      (opts) => {
        assert.ok(opts.some((o) => o.includes("Max open: 8 [default]")));
        assert.ok(opts.some((o) => o === "Save to Global"));
        assert.ok(opts.some((o) => o === "Done"));
        return opts.find((o) => o.includes("Max open:"));
      },
      (opts) => {
        assert.ok(opts.some((o) => o.includes("Max open: 4 [S]")));
        assert.ok(opts.some((o) => o === "Reset session"));
        assert.ok(opts.some((o) => o === "Save to Global*"));
        return "Save to Global*";
      },
    ];
    const applied = [];
    const { ctx: rpcCtx } = createBaseContext({
      mode: "rpc",
      hasUI: true,
      cwd,
      ui: {
        theme: createMockTheme(),
        notify: () => {},
        select: async (_title, opts) => {
          const fn = selectQueue.shift();
          assert.ok(fn, `Unexpected select: ${_title}`);
          return fn(opts);
        },
        input: async () => "4",
        editor: async () => undefined,
        confirm: async () => true,
        custom: async () => {
          throw new Error("unexpected custom");
        },
      },
    });

    const rpcRes = await openSettingsDialog(rpcCtx, {
      schema,
      agentDir,
      cwd,
      session: sessionOpts,
      onApply: (next, meta) => applied.push({ next, meta }),
    });
    assert.equal(selectQueue.length, 0);
    assert.equal(rpcRes.saved, true);
    assert.equal(rpcRes.closedBy, "save");
    assert.equal(rpcRes.scope, "global");
    assert.equal(rpcRes.values.maxOpen, 4);
    assert.equal(applied.length, 2);
    assert.equal(applied[0].meta.scope, "session");
    assert.equal(applied[1].meta.scope, "global");
    assert.equal(applied[1].meta.provenance.maxOpen, "global");

    const globalJson = JSON.parse(fs.readFileSync(path.join(agentDir, "adapter-session.json"), "utf8"));
    assert.deepEqual(globalJson, { maxOpen: 4 });
    // Redundant session override was pruned via tombstone
    assert.equal(entries.at(-1).data.__deleted, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
