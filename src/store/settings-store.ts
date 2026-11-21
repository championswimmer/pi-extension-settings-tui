import {
  cloneValue,
  findSecretKeys,
  type FieldMap,
  type InferSettingsValues,
  type SettingsLayersData,
  type SettingsSchema,
  type SettingsScope,
} from "../schema/index.js";
import { stripSecretKeys } from "./fs-hardening.js";
import { createJsonFileStorageAdapter } from "./json-adapter.js";
import {
  ConcurrencyConflictError,
  SettingsSecurityError,
  type LayerReadResult,
  type LayersSnapshot,
  type LoadSettingsOptions,
  type LoadedSettings,
  type SaveSettingsOptions,
  type SaveSettingsResult,
  type SettingsStoreOptions,
  type StorageAdapter,
} from "./types.js";

export class SettingsStore<TFields extends FieldMap = FieldMap> {
  readonly schema: SettingsSchema<TFields>;
  readonly adapter: StorageAdapter;

  constructor(schema: SettingsSchema<TFields>, options?: SettingsStoreOptions) {
    this.schema = schema;
    this.adapter =
      options?.adapter ?? createJsonFileStorageAdapter(schema, options);
  }

  getPaths(): Partial<Record<SettingsScope, string>> {
    return this.adapter.getPaths?.() ?? {};
  }

  async load(
    options?: LoadSettingsOptions,
  ): Promise<LoadedSettings<InferSettingsValues<TFields>>> {
    type TValues = InferSettingsValues<TFields>;
    const trustedProject = Boolean(options?.trustedProject);
    const supportsGlobal = this.schema.scopes.includes("global");
    const supportsProject = this.schema.scopes.includes("project");
    const includeProject = supportsProject && trustedProject;

    const globalRead: LayerReadResult = supportsGlobal
      ? await this.adapter.readLayer("global")
      : { data: null, hash: null, exists: false };

    const projectRead: LayerReadResult = includeProject
      ? await this.adapter.readLayer("project")
      : { data: null, hash: null, exists: false };

    const warnings: string[] = [];

    const parseLayer = (
      readResult: LayerReadResult,
      scope: SettingsScope,
    ): Partial<TValues> => {
      if (!readResult.exists || readResult.data === null) {
        return {};
      }

      const preClean = stripSecretKeys(readResult.data);
      for (const keyPath of preClean.strippedKeys) {
        warnings.push(`Ignored secret key "${keyPath}" in ${scope} settings.`);
      }

      let raw = preClean.cleaned;
      if (this.schema.config.migrate) {
        raw = this.schema.config.migrate(raw, scope);
        const postMigrate = stripSecretKeys(raw);
        for (const keyPath of postMigrate.strippedKeys) {
          warnings.push(`Ignored secret key "${keyPath}" in ${scope} settings.`);
        }
        raw = postMigrate.cleaned;
      }

      const validated = this.schema.validatePartial(raw);
      for (const warning of validated.warnings) {
        warnings.push(
          warning.key
            ? `${scope}.${warning.key}: ${warning.message}`
            : `${scope}: ${warning.message}`,
        );
      }

      // Enforce field-level scope restrictions if configured.
      const scopedValues: Partial<TValues> = {};
      for (const key of Object.keys(validated.values) as (keyof TFields & string)[]) {
        const fieldDef = this.schema.fields[key];
        if (fieldDef?.scopes && !fieldDef.scopes.includes(scope)) {
          warnings.push(
            `${scope}.${key}: field is not allowed in "${scope}" scope; ignored.`,
          );
          continue;
        }
        scopedValues[key] = validated.values[key];
      }

      return scopedValues;
    };

    const layers: SettingsLayersData<TValues> = {
      global: parseLayer(globalRead, "global"),
      project: parseLayer(projectRead, "project"),
    };

    const effective = this.schema.resolveEffective(layers, { includeProject });
    const provenance = this.schema.computeProvenance(layers, { includeProject });
    const snapshot: LayersSnapshot = {
      globalHash: globalRead.hash,
      projectHash: projectRead.hash,
    };

    return {
      effective,
      layers,
      provenance,
      warnings,
      trustedProject,
      paths: this.getPaths(),
      snapshot,
    };
  }

  async save(
    nextValues: InferSettingsValues<TFields>,
    options: SaveSettingsOptions,
  ): Promise<SaveSettingsResult<InferSettingsValues<TFields>>> {
    type TValues = InferSettingsValues<TFields>;
    const scope = options.scope;
    const trustedProject = Boolean(options.trustedProject);
    const force = Boolean(options.force);

    this.assertWritableScope(scope, trustedProject);

    const secretKeysInInput = findSecretKeys(nextValues);
    if (secretKeysInInput.length > 0) {
      throw new SettingsSecurityError(
        "SECRET_KEY_REJECTED",
        `Refusing to save forbidden secret key(s): ${secretKeysInInput.join(", ")}`,
        { keys: secretKeysInInput },
      );
    }

    const current = await this.load({ trustedProject });
    this.assertExpectedSnapshot(scope, options.expectedSnapshot, current.snapshot, force);

    const normalizedNext = {} as TValues;
    for (const key of this.schema.fieldKeys) {
      const validation = this.schema.validateField(key, nextValues[key]);
      if (!validation.ok) {
        throw new Error(`Invalid value for setting "${key}": ${validation.error}`);
      }
      normalizedNext[key] = validation.value;
    }

    const rawDiff = this.schema.diffForScope(normalizedNext, scope, current.layers);
    const diff: Record<string, unknown> = {};
    for (const key of Object.keys(rawDiff) as (keyof TFields & string)[]) {
      const fieldDef = this.schema.fields[key];
      if (fieldDef?.scopes && !fieldDef.scopes.includes(scope)) {
        continue;
      }
      diff[key] = rawDiff[key];
    }

    const secretKeysInDiff = findSecretKeys(diff);
    if (secretKeysInDiff.length > 0) {
      throw new SettingsSecurityError(
        "SECRET_KEY_REJECTED",
        `Refusing to save forbidden secret key(s): ${secretKeysInDiff.join(", ")}`,
        { keys: secretKeysInDiff },
      );
    }

    const writtenKeys = Object.keys(diff);
    const currentHash =
      scope === "global"
        ? current.snapshot.globalHash
        : current.snapshot.projectHash;
    const expectedHash = force ? undefined : currentHash;

    const writeResult = await this.adapter.writeLayer(scope, diff, { expectedHash });
    const deletedFile = Boolean(writeResult.deleted);

    const loaded = await this.load({ trustedProject });
    return {
      savedScope: scope,
      writtenKeys,
      deletedFile,
      loaded,
    };
  }

  async patch(
    partial: Partial<InferSettingsValues<TFields>>,
    options: SaveSettingsOptions,
  ): Promise<SaveSettingsResult<InferSettingsValues<TFields>>> {
    type TValues = InferSettingsValues<TFields>;
    const scope = options.scope;
    const trustedProject = Boolean(options.trustedProject);
    const force = Boolean(options.force);

    this.assertWritableScope(scope, trustedProject);

    const secretKeys = findSecretKeys(partial);
    if (secretKeys.length > 0) {
      throw new SettingsSecurityError(
        "SECRET_KEY_REJECTED",
        `Refusing to patch forbidden secret key(s): ${secretKeys.join(", ")}`,
        { keys: secretKeys },
      );
    }

    const current = await this.load({ trustedProject });
    this.assertExpectedSnapshot(scope, options.expectedSnapshot, current.snapshot, force);

    const baseValues =
      scope === "global"
        ? this.schema.resolveEffective(current.layers, { includeProject: false })
        : cloneValue(current.effective);
    const nextValues = baseValues as TValues;
    for (const [key, rawValue] of Object.entries(partial)) {
      if (!(key in this.schema.fields)) {
        throw new Error(`Unknown setting key "${key}" for schema "${this.schema.id}".`);
      }
      const typedKey = key as keyof TFields & string;
      const fieldDef = this.schema.fields[typedKey];
      if (fieldDef?.scopes && !fieldDef.scopes.includes(scope)) {
        throw new Error(
          `Setting "${key}" cannot be saved to "${scope}" scope.`,
        );
      }
      const validation = this.schema.validateField(typedKey, rawValue);
      if (!validation.ok) {
        throw new Error(`Invalid value for setting "${key}": ${validation.error}`);
      }
      nextValues[typedKey] = validation.value;
    }

    return this.save(nextValues, {
      ...options,
      expectedSnapshot: force ? undefined : options.expectedSnapshot ?? current.snapshot,
    });
  }

  async restoreDefaults(
    options: SaveSettingsOptions,
  ): Promise<SaveSettingsResult<InferSettingsValues<TFields>>> {
    const scope = options.scope;
    const trustedProject = Boolean(options.trustedProject);
    const force = Boolean(options.force);

    this.assertWritableScope(scope, trustedProject);

    const current = await this.load({ trustedProject });
    this.assertExpectedSnapshot(scope, options.expectedSnapshot, current.snapshot, force);

    const currentHash =
      scope === "global"
        ? current.snapshot.globalHash
        : current.snapshot.projectHash;
    const expectedHash = force ? undefined : currentHash;

    let deletedFile = false;
    if (this.adapter.deleteLayer) {
      await this.adapter.deleteLayer(scope, { expectedHash });
      deletedFile = currentHash !== null;
    } else {
      const writeResult = await this.adapter.writeLayer(scope, {}, { expectedHash });
      deletedFile = Boolean(writeResult.deleted);
    }

    const loaded = await this.load({ trustedProject });
    return {
      savedScope: scope,
      writtenKeys: [],
      deletedFile,
      loaded,
    };
  }

  private assertWritableScope(scope: SettingsScope, trustedProject: boolean): void {
    if (!this.schema.scopes.includes(scope)) {
      throw new Error(
        `Scope "${scope}" is not supported by settings schema "${this.schema.id}".`,
      );
    }
    if (scope === "project" && !trustedProject) {
      throw new Error(
        `Cannot save settings to "project" scope because the current project is not trusted.`,
      );
    }
  }

  private assertExpectedSnapshot(
    scope: SettingsScope,
    expectedSnapshot: LayersSnapshot | undefined,
    currentSnapshot: LayersSnapshot,
    force: boolean,
  ): void {
    if (force || expectedSnapshot === undefined) {
      return;
    }
    const expectedHash =
      scope === "global" ? expectedSnapshot.globalHash : expectedSnapshot.projectHash;
    const currentHash =
      scope === "global" ? currentSnapshot.globalHash : currentSnapshot.projectHash;
    if (expectedHash !== currentHash) {
      throw new ConcurrencyConflictError(scope);
    }
  }
}

export function createSettingsStore<TFields extends FieldMap>(
  schema: SettingsSchema<TFields>,
  options?: SettingsStoreOptions,
): SettingsStore<TFields> {
  return new SettingsStore(schema, options);
}
