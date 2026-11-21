import type {
  BooleanFieldDef,
  CustomFieldDef,
  EnumFieldDef,
  ExternalFieldDef,
  ModelFieldDef,
  ModelSelection,
  MultiSelectFieldDef,
  NumberFieldDef,
  PickerFieldDef,
  StringFieldDef,
  ViewFieldDef,
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
  opts: Omit<ModelFieldDef<true, TValues, false>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking: false;
    readonly default: null;
    readonly allowClear?: true;
  },
): ModelFieldDef<true, TValues, false>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<true, TValues, false>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking: false;
    readonly allowClear: true;
  },
): ModelFieldDef<true, TValues, false>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<false, TValues, false>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking: false;
    readonly default: string;
    readonly allowClear?: false;
  },
): ModelFieldDef<false, TValues, false>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<true, TValues, true>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking?: true;
    readonly default: null;
    readonly allowClear?: true;
  },
): ModelFieldDef<true, TValues, true>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<true, TValues, true>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking?: true;
    readonly allowClear: true;
  },
): ModelFieldDef<true, TValues, true>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ModelFieldDef<false, TValues, true>, "kind" | "allowClear" | "includeThinking"> & {
    readonly includeThinking?: true;
    readonly default: ModelSelection;
    readonly allowClear?: false;
  },
): ModelFieldDef<false, TValues, true>;
function modelField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  opts: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ModelFieldDef<any, TValues, any> {
  return {
    ...(opts as Omit<ModelFieldDef<boolean, TValues, boolean>, "kind">),
    kind: "model",
    includeThinking: opts.includeThinking ?? true,
    allowClear: opts.allowClear ?? opts.default === null,
  };
}

function pickerField<
  T,
  TValues extends Record<string, unknown> = Record<string, unknown>,
>(
  opts: Omit<PickerFieldDef<T, TValues>, "kind">,
): PickerFieldDef<T, TValues> {
  return { ...opts, kind: "picker" };
}

function viewField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ViewFieldDef<TValues>, "kind">,
): ViewFieldDef<TValues> {
  return { ...opts, kind: "view" };
}

function externalField<TValues extends Record<string, unknown> = Record<string, unknown>>(
  opts: Omit<ExternalFieldDef<TValues>, "kind">,
): ExternalFieldDef<TValues> {
  return { ...opts, kind: "external" };
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
  picker: pickerField,
  view: viewField,
  external: externalField,
  custom: customField,
} as const;
