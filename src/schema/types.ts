export type SettingsScope = "global" | "project";
export type FieldProvenance = "default" | "global" | "project" | "both";
export type SaveMode = "draft" | "immediate";
export type ValueTone = "default" | "accent" | "warn" | "error" | "success" | "muted";

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface EnumOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly tone?: ValueTone;
}

export interface MultiSelectOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
}

export interface FieldBase<T, TValues extends Record<string, unknown> = Record<string, unknown>> {
  readonly tab?: string;
  readonly label: string;
  readonly description?: string;
  readonly default: T;
  readonly experimental?: boolean;
  readonly disabled?: boolean | ((values: Readonly<TValues>) => boolean);
  readonly visibleWhen?: (values: Readonly<TValues>) => boolean;
  readonly format?: (value: T) => string;
  readonly tone?: ValueTone | ((value: T) => ValueTone);
  readonly scopes?: readonly SettingsScope[];
}

export interface BooleanFieldDef<TValues extends Record<string, unknown> = Record<string, unknown>>
  extends FieldBase<boolean, TValues> {
  readonly kind: "boolean";
  readonly trueLabel?: string;
  readonly falseLabel?: string;
}

export interface EnumFieldDef<
  T extends string = string,
  TValues extends Record<string, unknown> = Record<string, unknown>,
> extends FieldBase<T, TValues> {
  readonly kind: "enum";
  readonly options: readonly EnumOption<T>[];
  readonly display?: "auto" | "cycle" | "picker";
}

export interface MultiSelectFieldDef<
  T extends string = string,
  TValues extends Record<string, unknown> = Record<string, unknown>,
> extends FieldBase<T[], TValues> {
  readonly kind: "multiSelect";
  readonly options: readonly MultiSelectOption<T>[] | ((context?: unknown) => readonly MultiSelectOption<T>[]);
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly maxItemLength?: number;
  readonly allowCustom?: boolean;
  readonly collapsibleGroups?: boolean;
  readonly emptyLabel?: string;
}

export interface StringFieldDef<TValues extends Record<string, unknown> = Record<string, unknown>>
  extends FieldBase<string, TValues> {
  readonly kind: "string";
  readonly placeholder?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly patternMessage?: string;
  readonly multiline?: boolean;
  readonly trim?: boolean;
  readonly stripControlChars?: boolean;
}

export interface NumberFieldDef<TValues extends Record<string, unknown> = Record<string, unknown>>
  extends FieldBase<number, TValues> {
  readonly kind: "number";
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly step?: number;
  readonly placeholder?: string;
  readonly unit?: string;
}

export interface CustomSubrouteParams<
  T = unknown,
  TValues extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly fieldKey: string;
  readonly field: CustomFieldDef<T, TValues>;
  readonly value: T;
  readonly draft: Readonly<TValues>;
  readonly tui: unknown;
  readonly theme: unknown;
  readonly keybindings: unknown;
  readonly commit: (next: T) => void;
  readonly cancel: () => void;
}

export interface CustomFieldDef<
  T = unknown,
  TValues extends Record<string, unknown> = Record<string, unknown>,
> extends FieldBase<T, TValues> {
  readonly kind: "custom";
  readonly validate?: (raw: unknown) => boolean | string;
  readonly normalize?: (raw: unknown) => T;
  readonly openSubroute?: (params: CustomSubrouteParams<T, TValues>) => unknown;
  readonly rpcEdit?: (ctx: unknown, currentValue: T, draft: Readonly<TValues>) => Promise<T | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFieldDef =
  | BooleanFieldDef<any>
  | EnumFieldDef<any, any>
  | MultiSelectFieldDef<any, any>
  | StringFieldDef<any>
  | NumberFieldDef<any>
  | CustomFieldDef<any, any>;

export type FieldMap = Record<string, AnyFieldDef>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferFieldValue<F> =
  F extends BooleanFieldDef<any> ? boolean :
  F extends EnumFieldDef<infer T, any> ? T :
  F extends MultiSelectFieldDef<infer T, any> ? T[] :
  F extends StringFieldDef<any> ? string :
  F extends NumberFieldDef<any> ? number :
  F extends CustomFieldDef<infer T, any> ? T :
  never;

export type InferSettingsValues<TFields extends FieldMap> = {
  [K in keyof TFields]: InferFieldValue<TFields[K]>;
};

export interface StoragePathContext {
  readonly agentDir: string;
  readonly cwd: string;
  readonly id: string;
  readonly fileName: string;
}

export interface StoragePathConfig {
  readonly fileName?: string;
  readonly globalPath?: string | ((ctx: Pick<StoragePathContext, "agentDir" | "id" | "fileName">) => string);
  readonly projectPath?: string | ((ctx: Pick<StoragePathContext, "cwd" | "id" | "fileName">) => string);
}

export interface SettingsSchemaConfig<TFields extends FieldMap> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly version?: number;
  readonly scopes?: readonly SettingsScope[];
  readonly defaultScope?: SettingsScope;
  readonly saveMode?: SaveMode;
  readonly tabs?: readonly TabDefinition[];
  readonly storage?: StoragePathConfig;
  readonly migrate?: (raw: Record<string, unknown>, scope: SettingsScope) => Record<string, unknown>;
  readonly fields: TFields;
}

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export interface ValidationFailure {
  readonly ok: false;
  readonly error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface ValidationWarning {
  readonly key: string;
  readonly message: string;
}

export interface PartialValidationResult<TValues extends Record<string, unknown>> {
  readonly values: Partial<TValues>;
  readonly warnings: ValidationWarning[];
  readonly rejectedKeys: string[];
}

export interface SettingsLayersData<TValues extends Record<string, unknown>> {
  readonly global: Partial<TValues>;
  readonly project: Partial<TValues>;
}

export interface SettingsSchema<TFields extends FieldMap = FieldMap> {
  readonly config: SettingsSchemaConfig<TFields>;
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly version?: number;
  readonly tabs: readonly TabDefinition[];
  readonly hasExplicitTabs: boolean;
  readonly scopes: readonly SettingsScope[];
  readonly defaultScope: SettingsScope;
  readonly saveMode: SaveMode;
  readonly storage: StoragePathConfig;
  readonly fields: TFields;
  readonly fieldKeys: readonly (keyof TFields & string)[];
  readonly defaults: InferSettingsValues<TFields>;
  readonly Type: InferSettingsValues<TFields>;

  getDefaults(): InferSettingsValues<TFields>;
  getFieldsForTab(tabId: string): readonly { key: keyof TFields & string; def: AnyFieldDef }[];
  validateField<K extends keyof TFields & string>(key: K, raw: unknown): ValidationResult<InferSettingsValues<TFields>[K]>;
  validatePartial(raw: unknown): PartialValidationResult<InferSettingsValues<TFields>>;
  resolveEffective(
    layers: SettingsLayersData<InferSettingsValues<TFields>>,
    options?: { includeProject?: boolean },
  ): InferSettingsValues<TFields>;
  computeProvenance(
    layers: SettingsLayersData<InferSettingsValues<TFields>>,
    options?: { includeProject?: boolean },
  ): Record<keyof TFields & string, FieldProvenance>;
  diffForScope(
    nextValues: InferSettingsValues<TFields>,
    scope: SettingsScope,
    existingLayers: SettingsLayersData<InferSettingsValues<TFields>>,
  ): Partial<InferSettingsValues<TFields>>;
  formatFieldValue<K extends keyof TFields & string>(key: K, value: InferSettingsValues<TFields>[K]): string;
  getFieldTone<K extends keyof TFields & string>(key: K, value: InferSettingsValues<TFields>[K]): ValueTone;
}
