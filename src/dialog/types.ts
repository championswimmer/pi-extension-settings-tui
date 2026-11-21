import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  ModelPickerEntry,
  PersistedFieldKeys,
  SaveMode,
  ScopedModelEntry,
  SettingsSchema,
  SettingsScope,
} from "../schema/index.js";
import type { LoadedSettings, SettingsStore } from "../store/index.js";

/** Semantic category for a rendered mouse hit target. */
export type HitRegionKind =
  | "tab"
  | "row"
  | "action"
  | "button"
  | "option"
  | "group"
  | "input";

/** Overlay-local bounding span (0-based coordinates, half-open `[x0, x1)`). */
export interface HitRegion {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly kind: HitRegionKind;
  readonly id: string;
  readonly index?: number;
  readonly data?: unknown;
}

/** Local rectangle inside a container where a child component is rendered. */
export interface ChildBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Component contract for sub-routes pushed onto the dialog frame stack. */
export type DialogRouteComponent = Component &
  Focusable & {
    title?: string;
    dispose?(): void;
  };

/** Frame entry on the dialog navigation stack. */
export interface DialogFrame {
  readonly title: string;
  readonly component: DialogRouteComponent;
  readonly abortController?: AbortController;
}

/** Result returned to `done(result)` when the settings dialog closes. */
export interface SettingsDialogResult<TValues extends Record<string, unknown>> {
  readonly saved: boolean;
  readonly values: TValues;
  readonly scope: SettingsScope;
  readonly dirty: boolean;
  readonly closedBy: "save" | "cancel" | "escape" | "abort" | "immediate";
}

/** Configuration options for `SettingsDialogComponent`. */
export interface SettingsDialogOptions<TFields extends FieldMap> {
  readonly schema: SettingsSchema<TFields>;
  readonly store: SettingsStore<TFields>;
  readonly initialState: LoadedSettings<InferSettingsValues<TFields>>;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly done: (result: SettingsDialogResult<InferSettingsValues<TFields>>) => void;
  readonly initialTab?: string;
  readonly initialField?: string;
  readonly saveMode?: SaveMode;
  readonly preferredWidth?: number;
  /** Available models supplied to `field.model` pickers (populated automatically by `openSettingsDialog`). */
  readonly availableModels?: readonly ModelPickerEntry[] | (() => readonly ModelPickerEntry[]);
  /** Scoped models supplied to `field.model` pickers (populated automatically by `openSettingsDialog`). */
  readonly scopedModels?: readonly ScopedModelEntry[] | (() => readonly ScopedModelEntry[]);
  readonly onApply?: (
    next: InferSettingsValues<TFields>,
    meta: {
      scope: SettingsScope;
      provenance: Record<PersistedFieldKeys<TFields>, FieldProvenance>;
      writtenKeys: string[];
    },
  ) => void | Promise<void>;
}
