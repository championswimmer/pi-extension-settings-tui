import type {
  BooleanFieldDef,
  CustomFieldDef,
  EnumFieldDef,
  ModelFieldDef,
  ModelSelection,
  MultiSelectFieldDef,
  NumberFieldDef,
  StringFieldDef,
} from "./types.js";

function booleanField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<BooleanFieldDef<TValues>, "kind">,
): BooleanFieldDef<TValues> {
  return { ...opts, kind: "boolean" };
}

function enumField<
  const T extends string,
  TValues extends Record<string, unknown> = Record<string, unknown>,
>(
  opts: Omit<EnumFieldDef<T, TValues>, "kind">,
): EnumFieldDef<T, TValues> {
  return { ...opts, kind: "enum" };
}

function multiSelectField<
  const T extends string = string,
  TValues extends Record<string, unknown> = Record<string, unknown>,
>(
  opts: Omit<MultiSelectFieldDef<T, TValues>, "kind">,
): MultiSelectFieldDef<T, TValues> {
  return { ...opts, kind: "multiSelect" };
}

function stringField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<StringFieldDef<TValues>, "kind">,
): StringFieldDef<TValues> {
  return { ...opts, kind: "string" };
}

function numberField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<NumberFieldDef<TValues>, "kind">,
): NumberFieldDef<TValues> {
  return { ...opts, kind: "number" };
}

function integerField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<NumberFieldDef<TValues>, "kind" | "integer">,
): NumberFieldDef<TValues> {
  return { ...opts, kind: "number", integer: true };
}

function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<true, TValues>, "kind" | "allowClear"> & {
    readonly default: null;
    readonly allowClear?: true;
  },
): ModelFieldDef<true, TValues>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<true, TValues>, "kind" | "allowClear"> & {
    readonly allowClear: true;
  },
): ModelFieldDef<true, TValues>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<false, TValues>, "kind" | "allowClear"> & {
    readonly default: ModelSelection;
    readonly allowClear?: false;
  },
): ModelFieldDef<false, TValues>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts:
    | Omit<ModelFieldDef<true, TValues>, "kind">
    | Omit<ModelFieldDef<false, TValues>, "kind">,
): ModelFieldDef<boolean, TValues> {
  return {
    ...(opts as Omit<ModelFieldDef<boolean, TValues>, "kind">),
    kind: "model",
    allowClear: opts.allowClear ?? opts.default === null,
  };
}

function customField<
  T,
  TValues extends Record<string, unknown> = Record<string, unknown>,
>(
  opts: Omit<CustomFieldDef<T, TValues>, "kind">,
): CustomFieldDef<T, TValues> {
  return { ...opts, kind: "custom" };
}

export const field = {
  boolean: booleanField,
  enum: enumField,
  multiSelect: multiSelectField,
  string: stringField,
  number: numberField,
  integer: integerField,
  model: modelField,
  custom: customField,
} as const;
