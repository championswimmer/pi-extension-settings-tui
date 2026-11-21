import type { OverlayOptions } from "@earendil-works/pi-tui";
import type {
  FieldMap,
  FieldProvenance,
  InferSettingsValues,
  ModelPickerEntry,
  SaveMode,
  ScopedModelEntry,
  SettingsSchema,
  SettingsScope,
  StoragePathConfig,
} from "../schema/index.js";
import type { SettingsStore, StorageAdapter } from "../store/index.js";

export interface OpenSettingsDialogOptions<TFields extends FieldMap> {
  readonly schema: SettingsSchema<TFields>;
  readonly store?: SettingsStore<TFields>;
  readonly adapter?: StorageAdapter;
  readonly agentDir?: string;
  readonly cwd?: string;
  readonly settingsFile?: string;
  readonly fileName?: string;
  readonly globalPath?: StoragePathConfig["globalPath"];
  readonly projectPath?: StoragePathConfig["projectPath"];
  readonly trustedProject?: boolean;
  readonly initialTab?: string;
  readonly initialField?: string;
  readonly saveMode?: SaveMode;
  readonly preferredWidth?: number;
  readonly overlayOptions?: OverlayOptions;
  /** Optional override for available models in `field.model` pickers (defaults to `ctx.modelRegistry.getAvailable()`). */
  readonly availableModels?: readonly ModelPickerEntry[] | (() => readonly ModelPickerEntry[]);
  /** Optional override for scoped models in `field.model` pickers (defaults to `ctx.scopedModels`). */
  readonly scopedModels?: readonly ScopedModelEntry[] | (() => readonly ScopedModelEntry[]);
  readonly onApply?: (
    next: InferSettingsValues<TFields>,
    meta: {
      scope: SettingsScope;
      provenance: Record<keyof TFields & string, FieldProvenance>;
      writtenKeys: string[];
    },
  ) => void | Promise<void>;
}

export interface OpenSettingsDialogResult<TValues extends Record<string, unknown>> {
  readonly mode: "tui" | "rpc" | "json" | "print";
  readonly opened: boolean;
  readonly reusedExisting?: boolean;
  readonly saved: boolean;
  readonly values: TValues;
  readonly scope: SettingsScope;
  readonly paths: Partial<Record<SettingsScope, string>>;
  readonly warnings: string[];
  readonly closedBy:
    | "save"
    | "cancel"
    | "escape"
    | "abort"
    | "immediate"
    | "headless"
    | "reused";
}
