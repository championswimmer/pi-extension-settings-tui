import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { defineSettings, field } from "../dist/schema/index.js";
import {
  ConcurrencyConflictError,
  MAX_SETTINGS_BYTES,
  SettingsSecurityError,
  assertNoSymlinkSegments,
  assertSafeRelativeSettingsFile,
  computeJsonHash,
  createJsonFileStorageAdapter,
  createMemoryStorageAdapter,
  createSessionStorageAdapter,
  createSettingsStore,
  deleteFileHardened,
  ensureSecureDir,
  readJsonFileHardened,
  resolveDefaultAgentDir,
  resolveScopeFilePath,
  writeJsonFileHardened,
} from "../dist/store/index.js";

const tempDirs = [];

function makeTempDir(prefix = "pi-settings-store-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createSampleSchema(overrides = {}) {
  return defineSettings({
    id: overrides.id ?? "sample-ext",
    title: "Sample Extension",
    settingsFile: overrides.settingsFile,
    scopes: overrides.scopes ?? ["global", "project"],
    storage: overrides.storage,
    migrate: overrides.migrate,
    fields: {
      enabled: field.boolean({ label: "Enabled", default: true }),
      mode: field.enum({
        label: "Mode",
        default: "balanced",
        options: [
          { value: "fast", label: "Fast" },
          { value: "balanced", label: "Balanced" },
          { value: "strict", label: "Strict" },
        ],
      }),
      maxItems: field.integer({ label: "Max items", default: 10, min: 1, max: 100 }),
      tags: field.multiSelect({
        label: "Tags",
        default: ["alpha"],
        options: [
          { value: "alpha", label: "Alpha" },
          { value: "beta", label: "Beta" },
          { value: "gamma", label: "Gamma" },
        ],
      }),
      globalOnly: field.string({
        label: "Global only",
        default: "g-default",
        scopes: ["global"],
      }),
      metadata: field.custom({
        label: "Metadata",
        default: { count: 0, nested: { label: "none" } },
      }),
    },
  });
}

describe("store / path resolution & json adapter", () => {
  it("resolves default agent dir with PI_CODING_AGENT_DIR and fallback", () => {
    const prev = process.env.PI_CODING_AGENT_DIR;
    try {
      delete process.env.PI_CODING_AGENT_DIR;
      assert.equal(resolveDefaultAgentDir(), path.join(os.homedir(), ".pi", "agent"));

      process.env.PI_CODING_AGENT_DIR = "~/custom-pi-agent";
      assert.equal(resolveDefaultAgentDir(), path.join(os.homedir(), "custom-pi-agent"));

      const customAbs = path.join(os.tmpdir(), "pi-agent-override");
      process.env.PI_CODING_AGENT_DIR = customAbs;
      assert.equal(resolveDefaultAgentDir(), path.resolve(customAbs));
    } finally {
      if (prev === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = prev;
      }
    }
  });

  it("supports default paths as well as custom fileName, globalPath, and projectPath (string & fn)", () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");

    const defaultSchema = createSampleSchema({ id: "my-ext" });
    assert.equal(
      resolveScopeFilePath(defaultSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "my-ext", "settings.json"),
    );
    assert.equal(
      resolveScopeFilePath(defaultSchema, "project", { agentDir, cwd }),
      path.join(cwd, ".pi", "my-ext", "settings.json"),
    );

    const customFileNameSchema = createSampleSchema({
      id: "my-ext",
      storage: { fileName: "prefs.json" },
    });
    assert.equal(
      resolveScopeFilePath(customFileNameSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "my-ext", "prefs.json"),
    );
    assert.equal(
      resolveScopeFilePath(customFileNameSchema, "project", { agentDir, cwd }),
      path.join(cwd, ".pi", "my-ext", "prefs.json"),
    );

    // Custom fileName + resolver functions (matching pi-checklist / pi-context-decisions style)
    const fnSchema = createSampleSchema({
      id: "pi-checklist",
      storage: {
        fileName: "checklist.json",
        globalPath: ({ agentDir: dir, fileName }) => path.join(dir, fileName),
        projectPath: ({ cwd: projectCwd, fileName }) => path.join(projectCwd, ".pi", fileName),
      },
    });
    assert.equal(
      resolveScopeFilePath(fnSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "checklist.json"),
    );
    assert.equal(
      resolveScopeFilePath(fnSchema, "project", { agentDir, cwd }),
      path.join(cwd, ".pi", "checklist.json"),
    );

    // String paths (relative & absolute) overridden in options
    const adapter = createJsonFileStorageAdapter(defaultSchema, {
      agentDir,
      cwd,
      globalPath: "custom-global.json",
      projectPath: path.join(cwd, ".pi", "custom-project.json"),
    });
    assert.deepEqual(adapter.getPaths?.(), {
      global: path.join(agentDir, "custom-global.json"),
      project: path.join(cwd, ".pi", "custom-project.json"),
    });
  });

  it("resolves flat and nested settingsFile under <agentDir> and <cwd>/.pi with override precedence", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    // 1. Flat settingsFile
    const flatSchema = createSampleSchema({
      id: "flat-ext",
      settingsFile: "my-ext.json",
    });
    assert.equal(
      resolveScopeFilePath(flatSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "my-ext.json"),
    );
    assert.equal(
      resolveScopeFilePath(flatSchema, "project", { agentDir, cwd }),
      path.join(cwd, ".pi", "my-ext.json"),
    );

    // 2. Nested settingsFile
    const nestedSchema = createSampleSchema({
      id: "nested-ext",
      settingsFile: "nested/dir/prefs.json",
    });
    assert.equal(
      resolveScopeFilePath(nestedSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "nested", "dir", "prefs.json"),
    );
    assert.equal(
      resolveScopeFilePath(nestedSchema, "project", { agentDir, cwd }),
      path.join(cwd, ".pi", "nested", "dir", "prefs.json"),
    );

    // 3. Call-time settingsFile override on createSettingsStore
    const storeOverride = createSettingsStore(flatSchema, {
      agentDir,
      cwd,
      settingsFile: "override/custom.json",
    });
    assert.deepEqual(storeOverride.getPaths(), {
      global: path.join(agentDir, "override", "custom.json"),
      project: path.join(cwd, ".pi", "override", "custom.json"),
    });

    // 4. Round-trip Global + Project save/load/provenance using settingsFile
    const roundTripStore = createSettingsStore(nestedSchema, { agentDir, cwd });
    const s0 = await roundTripStore.load({ trustedProject: true });
    const gSaved = await roundTripStore.patch(
      { mode: "strict", maxItems: 40 },
      { scope: "global", trustedProject: true, expectedSnapshot: s0.snapshot },
    );
    const pSaved = await roundTripStore.patch(
      { maxItems: 75, enabled: false },
      { scope: "project", trustedProject: true, expectedSnapshot: gSaved.loaded.snapshot },
    );

    assert.equal(fs.existsSync(path.join(agentDir, "nested", "dir", "prefs.json")), true);
    assert.equal(fs.existsSync(path.join(cwd, ".pi", "nested", "dir", "prefs.json")), true);
    assert.equal(pSaved.loaded.effective.mode, "strict");
    assert.equal(pSaved.loaded.effective.maxItems, 75);
    assert.equal(pSaved.loaded.effective.enabled, false);
    assert.deepEqual(pSaved.loaded.provenance, {
      enabled: "project",
      mode: "global",
      maxItems: "both",
      tags: "default",
      globalOnly: "default",
      metadata: "default",
    });

    // 5. globalPath / projectPath take precedence over settingsFile and receive settingsFile + derived fileName
    let capturedGlobalCtx;
    let capturedProjectCtx;
    const explicitWinsSchema = createSampleSchema({
      id: "precedence-ext",
      settingsFile: "nested/dir/prefs.json",
      storage: {
        globalPath: (ctx) => {
          capturedGlobalCtx = ctx;
          return path.join(ctx.agentDir, "legacy-global.json");
        },
        projectPath: (ctx) => {
          capturedProjectCtx = ctx;
          return path.join(ctx.cwd, "legacy-project.json");
        },
      },
    });
    assert.equal(
      resolveScopeFilePath(explicitWinsSchema, "global", { agentDir, cwd }),
      path.join(agentDir, "legacy-global.json"),
    );
    assert.equal(
      resolveScopeFilePath(explicitWinsSchema, "project", { agentDir, cwd }),
      path.join(cwd, "legacy-project.json"),
    );
    assert.deepEqual(capturedGlobalCtx, {
      agentDir,
      id: "precedence-ext",
      fileName: "prefs.json",
      settingsFile: "nested/dir/prefs.json",
    });
    assert.deepEqual(capturedProjectCtx, {
      cwd,
      id: "precedence-ext",
      fileName: "prefs.json",
      settingsFile: "nested/dir/prefs.json",
    });
  });

  it("rejects unsafe settingsFile and fileName values with SettingsSecurityError(INVALID_PATH)", () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    const baseSchema = createSampleSchema({ id: "sec-ext" });

    const invalidSettingsFiles = [
      "../escape.json",
      "/abs.json",
      "\\abs.json",
      "a/../b.json",
      "a/./b.json",
      ".",
      "..",
      "dir/",
      "dir\\",
      "a//b.json",
      "",
      "   ",
      "bad\0.json",
      "C:\\foo.json",
      "C:/foo.json",
    ];

    for (const bad of invalidSettingsFiles) {
      assert.throws(
        () => assertSafeRelativeSettingsFile(bad),
        (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
        `Expected assertSafeRelativeSettingsFile to reject ${JSON.stringify(bad)}`,
      );
      assert.throws(
        () => resolveScopeFilePath(baseSchema, "global", { agentDir, cwd, settingsFile: bad }),
        (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
        `Expected resolveScopeFilePath(global) to reject ${JSON.stringify(bad)}`,
      );
      assert.throws(
        () => resolveScopeFilePath(baseSchema, "project", { agentDir, cwd, settingsFile: bad }),
        (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
        `Expected resolveScopeFilePath(project) to reject ${JSON.stringify(bad)}`,
      );
    }

    for (const badFileName of ["../x.json", "a/b.json", "a\\b.json", ".", "..", "", "   ", "bad\0.json"]) {
      assert.throws(
        () => resolveScopeFilePath(baseSchema, "global", { agentDir, cwd, fileName: badFileName }),
        (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
        `Expected resolveScopeFilePath(global) to reject fileName ${JSON.stringify(badFileName)}`,
      );
      assert.throws(
        () => resolveScopeFilePath(baseSchema, "project", { agentDir, cwd, fileName: badFileName }),
        (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
        `Expected resolveScopeFilePath(project) to reject fileName ${JSON.stringify(badFileName)}`,
      );
    }
  });

  it("persists override-only diffs, propagates global changes, and cleans up empty files", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });

    const schema = createSampleSchema();
    const store = createSettingsStore(schema, { agentDir, cwd });
    const paths = store.getPaths();

    const initial = await store.load({ trustedProject: true });
    assert.equal(initial.effective.mode, "balanced");
    assert.equal(initial.provenance.mode, "default");

    // Save global change for mode + maxItems
    const gSave = await store.save(
      { ...initial.effective, mode: "strict", maxItems: 25 },
      { scope: "global", trustedProject: true, expectedSnapshot: initial.snapshot },
    );
    assert.deepEqual(gSave.writtenKeys.sort(), ["maxItems", "mode"]);
    assert.equal(gSave.deletedFile, false);

    const rawGlobal = JSON.parse(fs.readFileSync(paths.global, "utf8"));
    assert.deepEqual(rawGlobal, { mode: "strict", maxItems: 25 });

    // Save project override for maxItems only (and verify globalOnly is ignored on project save)
    const pSave = await store.save(
      { ...gSave.loaded.effective, maxItems: 50, globalOnly: "project-attempt" },
      { scope: "project", trustedProject: true, expectedSnapshot: gSave.loaded.snapshot },
    );
    assert.deepEqual(pSave.writtenKeys, ["maxItems"]);
    const rawProject = JSON.parse(fs.readFileSync(paths.project, "utf8"));
    assert.deepEqual(rawProject, { maxItems: 50 });
    assert.equal(pSave.loaded.provenance.mode, "global");
    assert.equal(pSave.loaded.provenance.maxItems, "both");

    // Patching globalOnly in project scope explicitly rejects
    await assert.rejects(
      () =>
        store.patch(
          { globalOnly: "bad" },
          { scope: "project", trustedProject: true, expectedSnapshot: pSave.loaded.snapshot },
        ),
      /cannot be saved to "project" scope/i,
    );

    // Change global mode to "fast" -> propagates to effective and does NOT copy project's maxItems=50 into global
    const gSave2 = await store.patch(
      { mode: "fast" },
      { scope: "global", trustedProject: true, expectedSnapshot: pSave.loaded.snapshot },
    );
    assert.equal(gSave2.loaded.effective.mode, "fast");
    assert.equal(gSave2.loaded.effective.maxItems, 50);
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.global, "utf8")), {
      mode: "fast",
      maxItems: 25,
    });

    // Reverting project maxItems back to global (25) deletes project file via deleteWhenEmpty
    const pRevert = await store.patch(
      { maxItems: 25 },
      { scope: "project", trustedProject: true, expectedSnapshot: gSave2.loaded.snapshot },
    );
    assert.equal(pRevert.deletedFile, true);
    assert.equal(fs.existsSync(paths.project), false);
    assert.equal(pRevert.loaded.effective.maxItems, 25);
    assert.equal(pRevert.loaded.provenance.maxItems, "global");
  });

  it("enforces deleteWhenEmpty: false when configured", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    const schema = createSampleSchema({ scopes: ["global"] });
    const store = createSettingsStore(schema, {
      agentDir,
      cwd,
      deleteWhenEmpty: false,
    });
    const initial = await store.load();
    const s1 = await store.patch({ enabled: false }, { scope: "global", expectedSnapshot: initial.snapshot });
    const s2 = await store.patch({ enabled: true }, { scope: "global", expectedSnapshot: s1.loaded.snapshot });
    assert.equal(s2.deletedFile, false);
    assert.equal(fs.existsSync(store.getPaths().global), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(store.getPaths().global, "utf8")), {});
  });
});

describe("store / untrusted project isolation", () => {
  it("skips reading and refuses writing project scope when trustedProject is false", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    const schema = createSampleSchema();
    const store = createSettingsStore(schema, { agentDir, cwd });

    // Write a hostile/corrupt project file (broken JSON or symlink)
    const projectPath = store.getPaths().project;
    fs.mkdirSync(path.dirname(projectPath), { recursive: true });
    fs.writeFileSync(projectPath, "{not valid json!!!", "utf8");

    // Untrusted load MUST NOT touch or fail on project file
    const untrustedLoaded = await store.load({ trustedProject: false });
    assert.equal(untrustedLoaded.trustedProject, false);
    assert.equal(untrustedLoaded.snapshot.projectHash, null);
    assert.equal(untrustedLoaded.effective.enabled, true);

    // Untrusted save/patch/restoreDefaults MUST refuse project scope
    await assert.rejects(
      () => store.save(untrustedLoaded.effective, { scope: "project", trustedProject: false }),
      /not trusted/i,
    );
    await assert.rejects(
      () => store.patch({ enabled: false }, { scope: "project", trustedProject: false }),
      /not trusted/i,
    );
    await assert.rejects(
      () => store.restoreDefaults({ scope: "project", trustedProject: false }),
      /not trusted/i,
    );

    // Trusted load sees the corrupt JSON
    await assert.rejects(() => store.load({ trustedProject: true }), SyntaxError);
  });

  it("refuses saving to unsupported scope", async () => {
    const root = makeTempDir();
    const schema = createSampleSchema({ scopes: ["global"] });
    const store = createSettingsStore(schema, { agentDir: root, cwd: root });
    const loaded = await store.load({ trustedProject: true });
    await assert.rejects(
      () => store.save(loaded.effective, { scope: "project", trustedProject: true }),
      /not supported/i,
    );
  });
});

describe("store / defense-in-depth fs hardening", () => {
  it("works under macOS /var and /tmp tempdirs while rejecting symlinks below baseRoot", () => {
    const root = makeTempDir();
    const validFile = path.join(root, "nested", "settings.json");
    assertNoSymlinkSegments(validFile, root);
    assertNoSymlinkSegments(path.join(os.tmpdir(), "nonexistent-settings-dir", "settings.json"));

    const realTarget = path.join(root, "real.json");
    fs.writeFileSync(realTarget, '{"enabled":false}\n', "utf8");

    // 1. Symlinked target file
    const fileLink = path.join(root, "link.json");
    fs.symlinkSync(realTarget, fileLink);
    assert.throws(
      () => readJsonFileHardened(fileLink, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );
    assert.throws(
      () => writeJsonFileHardened(fileLink, { enabled: true }, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );
    assert.throws(
      () => deleteFileHardened(fileLink, root),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );

    // 2. Dangling symlink target
    const danglingLink = path.join(root, "dangling.json");
    fs.symlinkSync(path.join(root, "missing.json"), danglingLink);
    assert.throws(
      () => readJsonFileHardened(danglingLink, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );

    // 3. Symlinked intermediate directory below baseRoot
    const realDir = path.join(root, "real-dir");
    fs.mkdirSync(realDir, { recursive: true });
    const dirLink = path.join(root, "dir-link");
    fs.symlinkSync(realDir, dirLink);
    assert.throws(
      () => ensureSecureDir(path.join(dirLink, "sub"), root),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );
    assert.throws(
      () => writeJsonFileHardened(path.join(dirLink, "settings.json"), { enabled: true }, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SYMLINK_REJECTED",
    );
  });

  it("rejects NUL bytes, empty paths, and non-regular files", () => {
    const root = makeTempDir();
    assert.throws(
      () => assertNoSymlinkSegments("bad\0path.json"),
      (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
    );
    assert.throws(
      () => assertNoSymlinkSegments("   "),
      (err) => err instanceof SettingsSecurityError && err.code === "INVALID_PATH",
    );
    const dirPath = path.join(root, "a-dir");
    fs.mkdirSync(dirPath);
    assert.throws(
      () => readJsonFileHardened(dirPath, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "NOT_REGULAR_FILE",
    );
  });

  it("sets 0o700 dir and 0o600 file permissions and leaves no leftover temp files", () => {
    const root = makeTempDir();
    const targetDir = path.join(root, "secure", "sub");
    const targetFile = path.join(targetDir, "settings.json");

    const hash = writeJsonFileHardened(targetFile, { enabled: false }, { baseRoot: root });
    assert.equal(hash, computeJsonHash('{\n  "enabled": false\n}\n'));

    if (process.platform !== "win32") {
      const dirMode = fs.statSync(targetDir).mode & 0o777;
      const fileMode = fs.statSync(targetFile).mode & 0o777;
      assert.equal(dirMode, 0o700);
      assert.equal(fileMode, 0o600);
    }

    const entries = fs.readdirSync(targetDir);
    assert.deepEqual(entries, ["settings.json"]);
  });

  it("enforces 64 KiB size cap on both read and write", () => {
    const root = makeTempDir();
    const filePath = path.join(root, "big.json");
    const oversizedPayload = { big: "a".repeat(MAX_SETTINGS_BYTES) };

    assert.throws(
      () => writeJsonFileHardened(filePath, oversizedPayload, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SIZE_LIMIT_EXCEEDED",
    );
    assert.equal(fs.readdirSync(root).filter((f) => f.startsWith(".settings.")).length, 0);

    // Manually write an oversized file on disk and verify read rejects it
    fs.writeFileSync(filePath, JSON.stringify(oversizedPayload), "utf8");
    assert.throws(
      () => readJsonFileHardened(filePath, { baseRoot: root }),
      (err) => err instanceof SettingsSecurityError && err.code === "SIZE_LIMIT_EXCEEDED",
    );
  });

  it("rejects secret keys recursively on write and strips them with warnings on read", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    const filePath = path.join(root, "secrets.json");

    for (const badPayload of [
      { apiKey: "sk-123" },
      { nested: { authToken: "tok" } },
      { items: [{ clientSecret: "sec" }] },
      { dbPassword: "pw" },
      { authorizationHeader: "Bearer x" },
      { userCredential: "cred" },
    ]) {
      assert.throws(
        () => writeJsonFileHardened(filePath, badPayload, { baseRoot: root }),
        (err) => err instanceof SettingsSecurityError && err.code === "SECRET_KEY_REJECTED",
      );
    }

    // Write file directly to disk containing secret keys (including nested inside custom field)
    const schema = createSampleSchema({ scopes: ["global"] });
    const store = createSettingsStore(schema, { agentDir, cwd });
    const globalPath = store.getPaths().global;
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(
      globalPath,
      JSON.stringify({
        enabled: false,
        apiKey: "should-be-stripped",
        metadata: { count: 3, nested: { apiToken: "hidden", label: "ok" } },
      }),
      "utf8",
    );

    const loaded = await store.load();
    assert.equal(loaded.effective.enabled, false);
    assert.equal(loaded.effective.metadata.count, 3);
    assert.equal("apiToken" in loaded.effective.metadata.nested, false);
    assert.ok(loaded.warnings.some((w) => w.includes("apiKey")));
    assert.ok(loaded.warnings.some((w) => w.includes("metadata.nested.apiToken")));

    // Strict read option rejects on read too
    assert.throws(
      () => readJsonFileHardened(globalPath, { baseRoot: agentDir, rejectSecretKeysOnRead: true }),
      (err) => err instanceof SettingsSecurityError && err.code === "SECRET_KEY_REJECTED",
    );
  });

  it("detects optimistic concurrency conflicts and supports force: true", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");
    const schema = createSampleSchema({ scopes: ["global"] });
    const store = createSettingsStore(schema, { agentDir, cwd });

    const snapA = await store.load();
    const snapB = await store.load();

    const resA = await store.patch(
      { maxItems: 20 },
      { scope: "global", expectedSnapshot: snapA.snapshot },
    );
    assert.equal(resA.loaded.effective.maxItems, 20);

    // Stale snapshot B must fail with ConcurrencyConflictError
    await assert.rejects(
      () =>
        store.patch(
          { maxItems: 30 },
          { scope: "global", expectedSnapshot: snapB.snapshot },
        ),
      (err) => err instanceof ConcurrencyConflictError && err.code === "CONCURRENCY_CONFLICT" && err.scope === "global",
    );

    // Stale restoreDefaults must also fail
    await assert.rejects(
      () => store.restoreDefaults({ scope: "global", expectedSnapshot: snapB.snapshot }),
      (err) => err instanceof ConcurrencyConflictError && err.scope === "global",
    );

    // force: true overrides stale snapshot
    const forced = await store.patch(
      { maxItems: 42 },
      { scope: "global", expectedSnapshot: snapB.snapshot, force: true },
    );
    assert.equal(forced.loaded.effective.maxItems, 42);
  });

  it("runs legacy migrate hook and cleans up on restoreDefaults", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");

    const schema = createSampleSchema({
      migrate: (raw, scope) => {
        const next = { ...raw };
        if (typeof next.legacyFlag === "boolean" && next.enabled === undefined) {
          next.enabled = next.legacyFlag;
          delete next.legacyFlag;
        }
        if (scope === "project" && next.mode === "legacy") {
          next.mode = "strict";
        }
        return next;
      },
    });

    const store = createSettingsStore(schema, { agentDir, cwd });
    const paths = store.getPaths();
    fs.mkdirSync(path.dirname(paths.global), { recursive: true });
    fs.mkdirSync(path.dirname(paths.project), { recursive: true });
    fs.writeFileSync(paths.global, JSON.stringify({ legacyFlag: false }), "utf8");
    fs.writeFileSync(paths.project, JSON.stringify({ mode: "legacy" }), "utf8");

    const loaded = await store.load({ trustedProject: true });
    assert.equal(loaded.effective.enabled, false);
    assert.equal(loaded.effective.mode, "strict");
    assert.deepEqual(loaded.migratedScopes, ["global", "project"]);

    // restoreDefaults deletes only project scope
    const restoredProj = await store.restoreDefaults({
      scope: "project",
      trustedProject: true,
      expectedSnapshot: loaded.snapshot,
    });
    assert.equal(restoredProj.deletedFile, true);
    assert.equal(fs.existsSync(paths.project), false);
    assert.equal(fs.existsSync(paths.global), true);
    assert.equal(restoredProj.loaded.effective.enabled, false);
    assert.equal(restoredProj.loaded.effective.mode, "balanced");

    // restoreDefaults again when file is already gone returns deletedFile: false
    const restoredAgain = await store.restoreDefaults({
      scope: "project",
      trustedProject: true,
      expectedSnapshot: restoredProj.loaded.snapshot,
    });
    assert.equal(restoredAgain.deletedFile, false);
  });

  it("tracks migratedScopes and persists migrations only when persistMigration: true", async () => {
    const root = makeTempDir();
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");

    // 1. No migrate hook & no-op migrate hook -> migratedScopes is []
    const noMigrateStore = createSettingsStore(createSampleSchema(), { agentDir, cwd });
    const noMigratePaths = noMigrateStore.getPaths();
    fs.mkdirSync(path.dirname(noMigratePaths.global), { recursive: true });
    fs.writeFileSync(noMigratePaths.global, JSON.stringify({ enabled: false }), "utf8");
    const noMigrateLoaded = await noMigrateStore.load();
    assert.deepEqual(noMigrateLoaded.migratedScopes, []);

    const noopSchema = createSampleSchema({
      migrate: (raw) => ({ ...raw }),
    });
    const noopStore = createSettingsStore(noopSchema, { agentDir, cwd });
    const noopLoaded = await noopStore.load();
    assert.deepEqual(noopLoaded.migratedScopes, []);

    // 2. Legacy keys present: persistMigration defaults to false (disk untouched)
    const migrateRoot = makeTempDir();
    const mAgentDir = path.join(migrateRoot, "agent");
    const mCwd = path.join(migrateRoot, "repo");
    const migrateSchema = createSampleSchema({
      migrate: (raw, scope) => {
        const next = { ...raw };
        if (typeof next.legacyFlag === "boolean") {
          next.enabled = next.legacyFlag;
          delete next.legacyFlag;
        }
        if (scope === "project" && next.legacyMode) {
          next.mode = next.legacyMode;
          delete next.legacyMode;
        }
        return next;
      },
    });

    const mStore = createSettingsStore(migrateSchema, { agentDir: mAgentDir, cwd: mCwd });
    const mPaths = mStore.getPaths();
    fs.mkdirSync(path.dirname(mPaths.global), { recursive: true });
    fs.mkdirSync(path.dirname(mPaths.project), { recursive: true });
    const initialGlobalRaw = JSON.stringify({ legacyFlag: false });
    const initialProjectRaw = JSON.stringify({ legacyMode: "strict" });
    fs.writeFileSync(mPaths.global, initialGlobalRaw, "utf8");
    fs.writeFileSync(mPaths.project, initialProjectRaw, "utf8");

    // Untrusted load only migrates global
    const untrustedLoad = await mStore.load({ trustedProject: false });
    assert.deepEqual(untrustedLoad.migratedScopes, ["global"]);
    assert.equal(fs.readFileSync(mPaths.global, "utf8"), initialGlobalRaw);
    assert.equal(fs.readFileSync(mPaths.project, "utf8"), initialProjectRaw);

    // Trusted load with default persistMigration (false) reports both scopes and leaves disk untouched
    const dryLoad = await mStore.load({ trustedProject: true });
    assert.deepEqual(dryLoad.migratedScopes, ["global", "project"]);
    assert.equal(fs.readFileSync(mPaths.global, "utf8"), initialGlobalRaw);
    assert.equal(fs.readFileSync(mPaths.project, "utf8"), initialProjectRaw);

    // 3. persistMigration: true rewrites migrated layers, strips legacy keys, updates snapshot
    const persisted = await mStore.load({ trustedProject: true, persistMigration: true });
    assert.deepEqual(persisted.migratedScopes, ["global", "project"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(mPaths.global, "utf8")), { enabled: false });
    assert.deepEqual(JSON.parse(fs.readFileSync(mPaths.project, "utf8")), { mode: "strict" });
    assert.notEqual(persisted.snapshot.globalHash, dryLoad.snapshot.globalHash);
    assert.notEqual(persisted.snapshot.projectHash, dryLoad.snapshot.projectHash);

    // 4. Subsequent load({ persistMigration: true }) reports migratedScopes: []
    const secondLoad = await mStore.load({ trustedProject: true, persistMigration: true });
    assert.deepEqual(secondLoad.migratedScopes, []);
    assert.equal(secondLoad.snapshot.globalHash, persisted.snapshot.globalHash);
    assert.equal(secondLoad.snapshot.projectHash, persisted.snapshot.projectHash);

    // 5. Migrated values all equal to defaults -> file deleted via deleteWhenEmpty: true
    const cleanRoot = makeTempDir();
    const cleanStore = createSettingsStore(migrateSchema, {
      agentDir: path.join(cleanRoot, "agent"),
      cwd: path.join(cleanRoot, "repo"),
    });
    const cleanGlobalPath = cleanStore.getPaths().global;
    fs.mkdirSync(path.dirname(cleanGlobalPath), { recursive: true });
    fs.writeFileSync(cleanGlobalPath, JSON.stringify({ legacyFlag: true }), "utf8");

    const cleanLoaded = await cleanStore.load({ persistMigration: true });
    assert.deepEqual(cleanLoaded.migratedScopes, ["global"]);
    assert.equal(fs.existsSync(cleanGlobalPath), false);
    assert.equal(cleanLoaded.snapshot.globalHash, null);
    assert.deepEqual((await cleanStore.load({ persistMigration: true })).migratedScopes, []);
  });
});

describe("store / session and memory adapters", () => {
  it("persists and resets settings via createSessionStorageAdapter", async () => {
    const entries = [
      { type: "message", customType: "ignored", data: { enabled: false } },
      { type: "custom", customType: "other-ext", data: { mode: "strict" } },
    ];
    const adapter = createSessionStorageAdapter({
      entryType: "sample-ext-settings",
      appendEntry: (entryType, data) => {
        entries.push({ type: "custom", customType: entryType, data });
      },
      getEntries: () => entries,
      scope: "global",
    });

    const schema = createSampleSchema({ scopes: ["global"] });
    const store = createSettingsStore(schema, { adapter });
    assert.deepEqual(store.getPaths(), { global: "session://sample-ext-settings" });

    const s0 = await store.load();
    assert.equal(s0.effective.mode, "balanced");

    const s1 = await store.patch(
      { mode: "strict", tags: ["alpha", "beta"] },
      { scope: "global", expectedSnapshot: s0.snapshot },
    );
    assert.equal(s1.loaded.effective.mode, "strict");
    assert.deepEqual(s1.loaded.effective.tags, ["alpha", "beta"]);

    // Concurrency conflict check
    await assert.rejects(
      () => store.patch({ enabled: false }, { scope: "global", expectedSnapshot: s0.snapshot }),
      (err) => err instanceof ConcurrencyConflictError,
    );

    // Restore defaults appends tombstone so subsequent loads see defaults
    const s2 = await store.restoreDefaults({
      scope: "global",
      expectedSnapshot: s1.loaded.snapshot,
    });
    assert.equal(s2.deletedFile, true);
    assert.equal(s2.loaded.effective.mode, "balanced");
    assert.deepEqual(s2.loaded.effective.tags, ["alpha"]);
  });

  it("persists, clones, and checks concurrency in createMemoryStorageAdapter", async () => {
    const initialGlobal = { mode: "fast", tags: ["beta"] };
    const adapter = createMemoryStorageAdapter({ global: initialGlobal });
    // Mutating caller object must not affect stored state
    initialGlobal.mode = "strict";

    const schema = createSampleSchema();
    const store = createSettingsStore(schema, { adapter });
    assert.deepEqual(store.getPaths(), {
      global: "memory://global",
      project: "memory://project",
    });

    const loaded = await store.load({ trustedProject: true });
    assert.equal(loaded.effective.mode, "fast");
    assert.deepEqual(loaded.effective.tags, ["beta"]);

    const saved = await store.patch(
      { enabled: false },
      { scope: "project", trustedProject: true, expectedSnapshot: loaded.snapshot },
    );
    assert.equal(saved.loaded.effective.enabled, false);
    assert.equal(saved.loaded.provenance.enabled, "project");

    await assert.rejects(
      () => store.patch({ enabled: true }, { scope: "project", trustedProject: true, expectedSnapshot: loaded.snapshot }),
      (err) => err instanceof ConcurrencyConflictError,
    );

    const restored = await store.restoreDefaults({
      scope: "project",
      trustedProject: true,
      expectedSnapshot: saved.loaded.snapshot,
    });
    assert.equal(restored.deletedFile, true);
    assert.equal(restored.loaded.effective.enabled, true);
  });

  it("reports per-scope rejectedKeys and skips non-persisted view/external fields", async () => {
    const schema = defineSettings({
      id: "non-persisted-store",
      title: "Non-Persisted Store",
      scopes: ["global", "project"],
      fields: {
        enabled: field.boolean({ label: "Enabled", default: true }),
        profile: field.picker({
          label: "Profile",
          default: null,
          allowClear: true,
          loadOptions: () => [{ id: "std", value: "std", label: "Standard" }],
          validate: (raw) => raw === null || typeof raw === "string" || "Invalid profile",
        }),
        inspect: field.view({
          label: "Inspect",
          content: "Markdown details",
        }),
        externalRules: field.external({
          label: "Rules",
          openSubroute: () => null,
        }),
      },
    });

    const adapter = createMemoryStorageAdapter({
      global: {
        enabled: false,
        profile: 42, // invalid
        inspect: "should-not-load", // non-persisted
        unknownGlobal: true,
      },
      project: {
        profile: "std",
        externalRules: { hack: true }, // non-persisted
      },
    });

    const store = createSettingsStore(schema, { adapter });

    // Untrusted load only checks global rejectedKeys
    const untrusted = await store.load({ trustedProject: false });
    assert.deepEqual(untrusted.effective, { enabled: false, profile: null });
    assert.deepEqual([...untrusted.rejectedKeys.global].sort(), [
      "inspect",
      "profile",
      "unknownGlobal",
    ]);
    assert.deepEqual(untrusted.rejectedKeys.project, []);

    // Trusted load checks both global and project rejectedKeys
    const trusted = await store.load({ trustedProject: true });
    assert.deepEqual(trusted.effective, { enabled: false, profile: "std" });
    assert.deepEqual(trusted.provenance, { enabled: "global", profile: "project" });
    assert.deepEqual([...trusted.rejectedKeys.global].sort(), [
      "inspect",
      "profile",
      "unknownGlobal",
    ]);
    assert.deepEqual(trusted.rejectedKeys.project, ["externalRules"]);

    // Saving persisted fields succeeds and ignores any non-persisted keys
    const saved = await store.save(
      { enabled: true, profile: "custom" },
      { scope: "global", trustedProject: true, expectedSnapshot: trusted.snapshot },
    );
    assert.deepEqual(saved.writtenKeys, ["profile"]);
    assert.deepEqual(saved.loaded.rejectedKeys.global, []);
    assert.equal(saved.loaded.effective.profile, "std"); // project still overrides global

    // Patching non-persisted view or external field throws
    await assert.rejects(
      () =>
        store.patch(
          { inspect: "x" },
          { scope: "global", trustedProject: true, expectedSnapshot: saved.loaded.snapshot },
        ),
      /not persisted/i,
    );
    await assert.rejects(
      () =>
        store.patch(
          { externalRules: "x" },
          { scope: "global", trustedProject: true, expectedSnapshot: saved.loaded.snapshot },
        ),
      /not persisted/i,
    );
  });
});
