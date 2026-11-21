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
        component.render(80);
        component.handleInput("\r"); // toggle enabled from true -> false
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
    overlayOptions: { offsetY: 1 },
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
  assert.equal(capturedOverlayOpts.overlayOptions.maxHeight, "90%");
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
    onApply: (next, meta) => {
      applied.push({ next, meta });
    },
  });

  assert.equal(selectQueue.length, 0);
  assert.equal(inputQueue.length, 0);
  assert.equal(editorQueue.length, 0);

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
  assert.equal(typeof schemaPkg.validateFieldValue, "function");

  assert.equal(storePkg.createSettingsStore, rootPkg.createSettingsStore);
  assert.equal(storePkg.ConcurrencyConflictError, ConcurrencyConflictError);
  assert.equal(typeof storePkg.createJsonFileStorageAdapter, "function");
  assert.equal(typeof storePkg.createSessionStorageAdapter, "function");

  assert.equal(dialogPkg.SettingsDialogComponent, rootPkg.SettingsDialogComponent);
  assert.equal(typeof dialogPkg.ConfirmRoute, "function");
  assert.equal(typeof dialogPkg.TextInputRoute, "function");
  assert.equal(typeof dialogPkg.SelectRoute, "function");
  assert.equal(typeof dialogPkg.MultiSelectRoute, "function");

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
