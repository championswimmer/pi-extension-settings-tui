import {
  fuzzyFilter,
  getSelectPageIndex,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type KeybindingsManager,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatModelIdentity,
  getSupportedThinkingLevelsForModel,
  MODEL_THINKING_LEVEL_DESCRIPTIONS,
  parseModelIdentity,
  stripControlChars,
  type ModelPickerEntry,
  type ModelPickerScope,
  type ModelSelection,
  type ModelThinkingLevel,
  type ScopedModelEntry,
} from "../../schema/index.js";
import {
  computeListWindow,
  ensureIndexInWindow,
  fitToWidth,
  formatActionPill,
  renderScrollIndicator,
} from "../frame.js";
import { HitRegionTracker, renderPillRow, type PillItem } from "../hit-test.js";
import type { ChildBounds, DialogRouteComponent } from "../types.js";

interface ModelPickerRouteBaseOptions {
  readonly title: string;
  readonly description?: string;
  readonly availableModels: readonly ModelPickerEntry[];
  readonly scopedModels?: readonly ScopedModelEntry[];
  readonly allowClear?: boolean;
  readonly emptyLabel?: string;
  readonly emptyDescription?: string;
  readonly defaultScope?: ModelPickerScope | "auto";
  readonly thinkingLevels?: readonly ModelThinkingLevel[];
  readonly defaultThinkingLevel?: ModelThinkingLevel;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

export interface ModelPickerWithThinkingOptions extends ModelPickerRouteBaseOptions {
  readonly includeThinking?: true;
  readonly currentValue: ModelSelection | null;
  readonly onSelect: (value: ModelSelection | null) => void;
}

export interface ModelPickerModelOnlyOptions extends ModelPickerRouteBaseOptions {
  readonly includeThinking: false;
  readonly currentValue: string | null;
  readonly onSelect: (value: string | null) => void;
}

/** Configuration for `ModelPickerRoute`. */
export type ModelPickerRouteOptions =
  | ModelPickerWithThinkingOptions
  | ModelPickerModelOnlyOptions;

interface NormalizedModelItem {
  readonly identity: string;
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly distinctName: string | undefined;
  readonly reasoning: boolean | undefined;
  readonly thinkingLevelMap?: Partial<Record<ModelThinkingLevel, unknown | null>>;
  readonly isScoped: boolean;
  readonly scopedThinkingLevel?: ModelThinkingLevel;
  readonly unavailable?: boolean;
}

type ModelListRow =
  | { readonly kind: "clear" }
  | { readonly kind: "model"; readonly item: NormalizedModelItem };

function sanitizeText(value: string | undefined): string {
  if (!value) return "";
  return stripControlChars(value, false).trim();
}

function splitLabelWords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Returns `name` only when it carries words not already present in `id`,
 * mirroring Pi's native model selector display behavior.
 */
function getDistinctModelName(id: string, name: string): string | undefined {
  if (!name) return undefined;
  const idWords = splitLabelWords(id);
  const idTokens = new Set(idWords);
  const compactId = idWords.join("");
  const isCovered = (word: string): boolean =>
    idTokens.has(word) || (word.length > 1 && compactId.includes(word));
  return splitLabelWords(name).every(isCovered) ? undefined : name;
}

function getModelSearchText(item: NormalizedModelItem): string {
  const namePart = item.name ? ` ${item.name}` : "";
  return `${item.provider} ${item.identity} ${item.provider} ${item.id}${namePart}`;
}

function normalizeModelEntry(
  entry: ModelPickerEntry,
  isScoped: boolean,
  scopedThinkingLevel?: ModelThinkingLevel,
  unavailable?: boolean,
): NormalizedModelItem | null {
  const provider = sanitizeText(entry.provider);
  const id = sanitizeText(entry.id);
  if (!provider || !id) return null;
  const identity = formatModelIdentity({ provider, id });
  if (!parseModelIdentity(identity)) return null;
  const name = sanitizeText(entry.name);
  return {
    identity,
    provider,
    id,
    name,
    distinctName: getDistinctModelName(id, name),
    reasoning: entry.reasoning,
    thinkingLevelMap: entry.thinkingLevelMap,
    isScoped,
    scopedThinkingLevel,
    unavailable,
  };
}

/**
 * Two-step model picker sub-route:
 * 1. Fuzzy-searchable model list with Scoped / All scope toggle (Tab or click).
 * 2. Thinking level selection tailored to the chosen model's reasoning capabilities.
 */
export class ModelPickerRoute implements DialogRouteComponent {
  readonly title: string;
  private readonly options: ModelPickerRouteOptions;
  private readonly searchInput: Input;
  private readonly tracker = new HitRegionTracker();
  private searchBounds?: ChildBounds;

  private readonly allModels: NormalizedModelItem[];
  private readonly scopedModels: NormalizedModelItem[];
  private readonly unavailableCurrentModel: NormalizedModelItem | undefined;

  private step: "model" | "thinking" = "model";
  private activeScope: ModelPickerScope;
  private filteredRows: ModelListRow[] = [];
  private modelSelectedIndex = 0;
  private modelScrollOffset = 0;
  private lastModelListMaxRows = 8;

  private pendingModel: NormalizedModelItem | undefined;
  private availableThinkingLevels: ModelThinkingLevel[] = [];
  private thinkingSelectedIndex = 0;
  private thinkingScrollOffset = 0;
  private lastThinkingListMaxRows = 8;

  private _focused = false;

  constructor(options: ModelPickerRouteOptions) {
    this.options = options;
    this.title = options.title;
    this.searchInput = new Input({
      prompt: options.theme.fg("accent", "/ "),
      placeholder: "Filter models...",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });

    const scopedThinkingByIdentity = new Map<string, ModelThinkingLevel>();
    const scopedIdentitySet = new Set<string>();
    const scopedRawByIdentity = new Map<string, ModelPickerEntry>();

    for (const entry of options.scopedModels ?? []) {
      const normalized = normalizeModelEntry(entry.model, true, entry.thinkingLevel);
      if (!normalized) continue;
      if (!scopedIdentitySet.has(normalized.identity)) {
        scopedIdentitySet.add(normalized.identity);
        scopedRawByIdentity.set(normalized.identity, entry.model);
      }
      if (entry.thinkingLevel !== undefined && !scopedThinkingByIdentity.has(normalized.identity)) {
        scopedThinkingByIdentity.set(normalized.identity, entry.thinkingLevel);
      }
    }

    const availableByIdentity = new Map<string, NormalizedModelItem>();
    for (const entry of options.availableModels) {
      const provider = sanitizeText(entry.provider);
      const id = sanitizeText(entry.id);
      const identity = provider && id ? formatModelIdentity({ provider, id }) : "";
      const isScoped = scopedIdentitySet.has(identity);
      const normalized = normalizeModelEntry(
        entry,
        isScoped,
        scopedThinkingByIdentity.get(identity),
      );
      if (!normalized || availableByIdentity.has(normalized.identity)) continue;
      availableByIdentity.set(normalized.identity, normalized);
    }

    // Preserve scopedModels order (matching Pi's /model & /scoped-models).
    const scopedList: NormalizedModelItem[] = [];
    for (const identity of scopedIdentitySet) {
      const fromAvailable = availableByIdentity.get(identity);
      if (fromAvailable) {
        scopedList.push(fromAvailable);
        continue;
      }
      const rawScoped = scopedRawByIdentity.get(identity);
      if (rawScoped) {
        const normalized = normalizeModelEntry(
          rawScoped,
          true,
          scopedThinkingByIdentity.get(identity),
        );
        if (normalized) {
          scopedList.push(normalized);
          availableByIdentity.set(normalized.identity, normalized);
        }
      }
    }
    this.scopedModels = scopedList;

    const currentIdentity = this.getCurrentModelIdentity();
    const allList = [...availableByIdentity.values()].sort((a, b) => {
      if (currentIdentity) {
        const aCurrent = a.identity === currentIdentity;
        const bCurrent = b.identity === currentIdentity;
        if (aCurrent && !bCurrent) return -1;
        if (!aCurrent && bCurrent) return 1;
      }
      return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
    });
    this.allModels = allList;

    if (currentIdentity && !availableByIdentity.has(currentIdentity)) {
      const parsed = parseModelIdentity(currentIdentity);
      if (parsed) {
        this.unavailableCurrentModel =
          normalizeModelEntry(
            { provider: parsed.provider, id: parsed.id },
            false,
            undefined,
            true,
          ) ?? undefined;
      }
    }

    const requestedScope = options.defaultScope ?? "auto";
    if (requestedScope === "scoped" || requestedScope === "all") {
      this.activeScope = requestedScope;
    } else {
      this.activeScope = this.scopedModels.length > 0 ? "scoped" : "all";
    }

    this.applyModelFilter(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.step === "model";
  }

  /** Active step (`"model"` or `"thinking"`), useful for diagnostics and tests. */
  getStep(): "model" | "thinking" {
    return this.step;
  }

  /** Active model list scope (`"scoped"` or `"all"`). */
  getScope(): ModelPickerScope {
    return this.activeScope;
  }

  private getCurrentModelIdentity(): string | undefined {
    const { currentValue } = this.options;
    return typeof currentValue === "string" ? currentValue : currentValue?.model;
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private getActiveScopeModels(): NormalizedModelItem[] {
    if (this.activeScope === "scoped") {
      return this.scopedModels;
    }
    if (this.unavailableCurrentModel) {
      return [this.unavailableCurrentModel, ...this.allModels];
    }
    return this.allModels;
  }

  private setScope(scope: ModelPickerScope): void {
    if (this.activeScope === scope) return;
    this.activeScope = scope;
    this.applyModelFilter(true);
  }

  private toggleScope(): void {
    this.setScope(this.activeScope === "scoped" ? "all" : "scoped");
  }

  private applyModelFilter(preferCurrent: boolean): void {
    const query = this.searchInput.getValue().trim();
    const prevRow = this.filteredRows[this.modelSelectedIndex];
    const prevKey =
      prevRow?.kind === "clear" ? "__clear__" : prevRow?.kind === "model" ? prevRow.item.identity : undefined;

    const sourceModels = this.getActiveScopeModels();
    const emptyLabel = this.options.emptyLabel ?? "None";
    const emptyDescription = this.options.emptyDescription ?? "Clear model selection";
    const rows: ModelListRow[] = [];

    if (!query) {
      if (this.options.allowClear) {
        rows.push({ kind: "clear" });
      }
      for (const item of sourceModels) {
        rows.push({ kind: "model", item });
      }
    } else {
      const matched = fuzzyFilter(sourceModels, query, getModelSearchText);
      for (const item of matched) {
        rows.push({ kind: "model", item });
      }
      if (this.options.allowClear) {
        const clearMatched = fuzzyFilter(
          [{ kind: "clear" as const }],
          query,
          () => `${emptyLabel} ${emptyDescription} none clear default`,
        );
        if (clearMatched.length > 0) {
          rows.push({ kind: "clear" });
        }
      }
    }

    this.filteredRows = rows;
    if (rows.length === 0) {
      this.modelSelectedIndex = 0;
      this.modelScrollOffset = 0;
      return;
    }

    const currentIdentity = this.getCurrentModelIdentity();
    if (query) {
      // When actively searching, highlight the top fuzzy match immediately.
      this.modelSelectedIndex = 0;
    } else if (preferCurrent) {
      if (this.options.currentValue === null && this.options.allowClear) {
        this.modelSelectedIndex = 0;
      } else if (currentIdentity) {
        const currentIdx = rows.findIndex(
          (r) => r.kind === "model" && r.item.identity === currentIdentity,
        );
        this.modelSelectedIndex = currentIdx >= 0 ? currentIdx : 0;
      } else {
        this.modelSelectedIndex = 0;
      }
    } else if (prevKey) {
      const retainedIdx = rows.findIndex((r) =>
        r.kind === "clear" ? prevKey === "__clear__" : r.item.identity === prevKey,
      );
      this.modelSelectedIndex = retainedIdx >= 0 ? retainedIdx : 0;
    } else {
      this.modelSelectedIndex = 0;
    }

    this.modelScrollOffset = ensureIndexInWindow(
      this.modelSelectedIndex,
      0,
      rows.length,
      this.lastModelListMaxRows,
    );
  }

  private enterThinkingStep(item: NormalizedModelItem): void {
    this.pendingModel = item;
    this.availableThinkingLevels = getSupportedThinkingLevelsForModel(
      item,
      this.options.thinkingLevels,
    );

    const current =
      this.options.currentValue && typeof this.options.currentValue === "object"
        ? this.options.currentValue
        : null;
    const preferredLevel = this.resolveInitialThinkingLevel(item, this.availableThinkingLevels, current);
    const idx = this.availableThinkingLevels.indexOf(preferredLevel);
    this.thinkingSelectedIndex = idx >= 0 ? idx : 0;
    this.thinkingScrollOffset = ensureIndexInWindow(
      this.thinkingSelectedIndex,
      0,
      this.availableThinkingLevels.length,
      this.lastThinkingListMaxRows,
    );

    this.step = "thinking";
    this.searchInput.focused = false;
  }

  private resolveInitialThinkingLevel(
    item: NormalizedModelItem,
    levels: readonly ModelThinkingLevel[],
    current: ModelSelection | null,
  ): ModelThinkingLevel {
    if (current && current.model === item.identity && levels.includes(current.thinkingLevel)) {
      return current.thinkingLevel;
    }
    if (item.scopedThinkingLevel && levels.includes(item.scopedThinkingLevel)) {
      return item.scopedThinkingLevel;
    }
    if (this.options.defaultThinkingLevel && levels.includes(this.options.defaultThinkingLevel)) {
      return this.options.defaultThinkingLevel;
    }
    if (current && levels.includes(current.thinkingLevel)) {
      return current.thinkingLevel;
    }
    if (levels.includes("medium")) {
      return "medium";
    }
    return levels[0] ?? "off";
  }

  private returnToModelStep(): void {
    this.step = "model";
    this.pendingModel = undefined;
    this.searchInput.focused = this._focused;
  }

  private activateModelRow(row: ModelListRow | undefined): void {
    if (!row) return;
    if (row.kind === "clear") {
      this.options.onSelect(null);
      return;
    }
    if (this.options.includeThinking === false) {
      this.options.onSelect(row.item.identity);
      return;
    }
    this.enterThinkingStep(row.item);
  }

  private commitThinkingSelection(): void {
    if (this.options.includeThinking === false || !this.pendingModel) return;
    const level = this.availableThinkingLevels[this.thinkingSelectedIndex];
    if (!level) return;
    this.options.onSelect({
      model: this.pendingModel.identity,
      thinkingLevel: level,
    });
  }

  render(width: number): string[] {
    this.tracker.clear();
    this.searchBounds = undefined;

    const safeWidth = Math.max(8, width);
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 18);

    if (this.step === "thinking") {
      return this.renderThinkingStep(safeWidth, maxHeight);
    }
    return this.renderModelStep(safeWidth, maxHeight);
  }

  private renderModelStep(safeWidth: number, maxHeight: number): string[] {
    const { theme } = this.options;
    const lines: string[] = [];

    // Header row: Step 1/2 (or Select model in 1-step mode) + clickable [Scoped (N)] [All (M)] pills
    const headerY = lines.length;
    const compactHeader = safeWidth < 50;
    const stepText =
      this.options.includeThinking === false
        ? theme.fg("accent", theme.bold(compactHeader ? "Model" : "Select model"))
        : compactHeader
          ? theme.fg("accent", theme.bold("1/2 Model"))
          : theme.fg("accent", theme.bold("Step 1/2")) + theme.fg("muted", " · Select model");

    const scopedLabel = compactHeader
      ? `Scoped(${this.scopedModels.length})`
      : `Scoped (${this.scopedModels.length})`;
    const allLabel = compactHeader
      ? `All(${this.allModels.length})`
      : `All (${this.allModels.length})`;

    const scopedChip =
      this.activeScope === "scoped"
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(`[${scopedLabel}]`)))
        : theme.fg("muted", `[${scopedLabel}]`);
    const allChip =
      this.activeScope === "all"
        ? theme.bg("selectedBg", theme.fg("accent", theme.bold(`[${allLabel}]`)))
        : theme.fg("muted", `[${allLabel}]`);

    const scopePills: PillItem[] = [
      { kind: "tab", id: "scoped", text: scopedChip },
      { kind: "tab", id: "all", text: allChip },
    ];
    const pillsTotalW = visibleWidth(scopedChip) + 1 + visibleWidth(allChip);
    const leftBudget = Math.max(0, safeWidth - pillsTotalW - 1);
    const clippedLeft =
      leftBudget >= 4 ? truncateToWidth(stepText, leftBudget, "…", false) : "";
    const leftW = visibleWidth(clippedLeft);
    const gap = Math.max(clippedLeft ? 1 : 0, safeWidth - leftW - pillsTotalW);

    const renderedPills = renderPillRow(scopePills, {
      tracker: this.tracker,
      y: headerY,
      startX: leftW + gap,
      separator: " ",
      maxWidth: Math.max(0, safeWidth - leftW),
    });
    lines.push(fitToWidth(`${clippedLeft}${" ".repeat(gap)}${renderedPills}`, safeWidth));

    const descLines =
      this.options.description && maxHeight >= 10
        ? wrapTextWithAnsi(this.options.description, safeWidth)
            .slice(0, 1)
            .map((l) => fitToWidth(theme.fg("muted", l), safeWidth))
        : [];
    lines.push(...descLines);

    const searchY = lines.length;
    this.searchBounds = { x: 0, y: searchY, width: safeWidth, height: 1 };
    this.tracker.add({ y: searchY, x0: 0, x1: safeWidth, kind: "input", id: "search" });
    lines.push(fitToWidth(this.searchInput.render(safeWidth)[0] ?? "", safeWidth));

    const showHint = maxHeight >= 6 ? 1 : 0;
    const listMaxRows = Math.max(1, maxHeight - lines.length - showHint);
    this.lastModelListMaxRows = listMaxRows;

    if (this.filteredRows.length === 0) {
      const emptyMsg =
        this.activeScope === "scoped" && this.scopedModels.length === 0
          ? "  No scoped models configured. Press Tab or click All."
          : this.allModels.length === 0 && !this.unavailableCurrentModel
            ? "  No available models found in Pi."
            : "  No matching models.";
      lines.push(fitToWidth(theme.fg("muted", emptyMsg), safeWidth));
    } else {
      const win = computeListWindow(this.filteredRows.length, this.modelScrollOffset, listMaxRows);
      this.modelScrollOffset = win.scrollOffset;

      if (win.aboveCount > 0) {
        lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
      }

      for (let idx = win.start; idx < win.end; idx++) {
        const row = this.filteredRows[idx]!;
        const isSelected = idx === this.modelSelectedIndex;
        const rowY = lines.length;

        this.tracker.add({
          y: rowY,
          x0: 0,
          x1: safeWidth,
          kind: "option",
          id: row.kind === "clear" ? "__clear__" : row.item.identity,
          index: idx,
        });

        const rendered = this.renderModelRow(row, isSelected, safeWidth);
        const padded = fitToWidth(rendered, safeWidth);
        lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
      }

      if (win.belowCount > 0) {
        lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
      }
    }

    if (showHint && lines.length < maxHeight) {
      const hintText =
        this.options.includeThinking === false
          ? "Tab scope · ↑/↓ move · Type to filter · Enter select · Esc back"
          : "Tab scope · ↑/↓ move · Type to filter · Enter next · Esc back";
      lines.push(fitToWidth(theme.fg("dim", hintText), safeWidth));
    }

    return lines.slice(0, maxHeight);
  }

  private renderModelRow(row: ModelListRow, isSelected: boolean, safeWidth: number): string {
    const { theme } = this.options;
    const cursor = isSelected ? theme.fg("accent", "❯") : " ";

    if (row.kind === "clear") {
      const isCurrent = this.options.currentValue === null;
      const mark = isCurrent ? theme.fg("success", "●") : " ";
      const label = theme.fg(isSelected ? "accent" : "muted", this.options.emptyLabel ?? "None");
      const prefix = `${cursor} ${mark} `;
      const desc = this.options.emptyDescription ?? "Clear model selection";
      if (safeWidth >= 34 && desc) {
        const remaining = Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(label) - 2);
        const clippedDesc =
          remaining >= 6 ? `  ${theme.fg("dim", truncateToWidth(desc, remaining, "…", false))}` : "";
        return `${prefix}${label}${clippedDesc}`;
      }
      return `${prefix}${label}`;
    }

    const { item } = row;
    const isCurrent = this.getCurrentModelIdentity() === item.identity;
    const mark = isCurrent ? theme.fg("success", "●") : " ";
    const prefix = `${cursor} ${mark} `;
    const providerBadge = theme.fg("muted", `[${item.provider}]`);

    const rightTags: string[] = [];
    if (item.unavailable) {
      rightTags.push(theme.fg("warning", "unavailable"));
    } else {
      if (this.activeScope === "all" && item.isScoped) {
        rightTags.push(theme.fg("accent", "scoped"));
      }
      if (item.reasoning === true) {
        rightTags.push(theme.fg("dim", "thinking"));
      }
    }
    const rightMeta =
      safeWidth >= 52 && rightTags.length > 0 ? rightTags.join(theme.fg("dim", " · ")) : "";
    const rightMetaW = visibleWidth(rightMeta);

    const idText = theme.fg(isSelected ? "accent" : "text", item.id);
    const namePart =
      item.distinctName && safeWidth >= 46
        ? theme.fg("muted", ` (${item.distinctName})`)
        : "";
    const leftFull = `${prefix}${idText}${namePart} ${providerBadge}`;

    if (rightMetaW > 0) {
      const maxLeftW = Math.max(10, safeWidth - rightMetaW - 2);
      const clippedLeft = truncateToWidth(leftFull, maxLeftW, "…", false);
      const gap = Math.max(2, safeWidth - visibleWidth(clippedLeft) - rightMetaW);
      return `${clippedLeft}${" ".repeat(gap)}${rightMeta}`;
    }

    return leftFull;
  }

  private renderThinkingStep(safeWidth: number, maxHeight: number): string[] {
    const { theme } = this.options;
    const lines: string[] = [];
    const model = this.pendingModel;
    const modelLabel = model ? model.identity : "";

    // Header row: Step 2/2 + [← Models] clickable pill
    const headerY = lines.length;
    const backPill = formatActionPill("← Models", theme, { tone: "muted" });
    const backPillW = visibleWidth(backPill);
    const titlePrefix =
      safeWidth < 48
        ? `${theme.fg("accent", theme.bold("2/2"))} ${theme.fg("text", modelLabel)}`
        : `${theme.fg("accent", theme.bold("Step 2/2"))} ${theme.fg("muted", "· Thinking:")} ${theme.fg("text", modelLabel)}`;
    const leftBudget = Math.max(0, safeWidth - backPillW - 1);
    const clippedLeft =
      leftBudget >= 4 ? truncateToWidth(titlePrefix, leftBudget, "…", false) : "";
    const leftW = visibleWidth(clippedLeft);
    const gap = Math.max(clippedLeft ? 1 : 0, safeWidth - leftW - backPillW);
    const backRow = renderPillRow([{ kind: "action", id: "back-to-models", text: backPill }], {
      tracker: this.tracker,
      y: headerY,
      startX: leftW + gap,
      maxWidth: Math.max(0, safeWidth - leftW),
    });
    lines.push(fitToWidth(`${clippedLeft}${" ".repeat(gap)}${backRow}`, safeWidth));

    if (model?.reasoning === false && maxHeight >= 7) {
      lines.push(
        fitToWidth(
          theme.fg("muted", "  This model does not support extended thinking (off only)."),
          safeWidth,
        ),
      );
    }

    const showHint = maxHeight >= 6 ? 1 : 0;
    const listMaxRows = Math.max(1, maxHeight - lines.length - showHint);
    this.lastThinkingListMaxRows = listMaxRows;

    const win = computeListWindow(
      this.availableThinkingLevels.length,
      this.thinkingScrollOffset,
      listMaxRows,
    );
    this.thinkingScrollOffset = win.scrollOffset;

    if (win.aboveCount > 0) {
      lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
    }

    const currentSelection =
      this.options.currentValue && typeof this.options.currentValue === "object"
        ? this.options.currentValue
        : null;
    const isCurrentModel =
      Boolean(model) && currentSelection?.model === model?.identity;

    for (let idx = win.start; idx < win.end; idx++) {
      const level = this.availableThinkingLevels[idx]!;
      const isSelected = idx === this.thinkingSelectedIndex;
      const isCurrent = isCurrentModel && currentSelection?.thinkingLevel === level;
      const isScopedLevel = model?.scopedThinkingLevel === level;
      const rowY = lines.length;

      this.tracker.add({
        y: rowY,
        x0: 0,
        x1: safeWidth,
        kind: "option",
        id: level,
        index: idx,
      });

      const cursor = isSelected ? theme.fg("accent", "❯") : " ";
      const mark = isCurrent ? theme.fg("success", "●") : " ";
      const paddedLevel = level.padEnd(8, " ");
      const levelText = theme.fg(isSelected ? "accent" : "text", paddedLevel);
      const prefix = `${cursor} ${mark} ${levelText}`;

      let rowLine = prefix;
      if (safeWidth >= 28) {
        const baseDesc = MODEL_THINKING_LEVEL_DESCRIPTIONS[level];
        const desc = isScopedLevel ? `${baseDesc} · scoped` : baseDesc;
        const remaining = Math.max(0, safeWidth - visibleWidth(prefix) - 2);
        if (remaining >= 4) {
          rowLine = `${prefix}  ${theme.fg("dim", truncateToWidth(desc, remaining, "…", false))}`;
        }
      }

      const padded = fitToWidth(rowLine, safeWidth);
      lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
    }

    if (win.belowCount > 0) {
      lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
    }

    if (showHint && lines.length < maxHeight) {
      lines.push(
        fitToWidth(
          theme.fg("dim", "↑/↓ move · Enter confirm · Esc back to models"),
          safeWidth,
        ),
      );
    }

    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    if (this.step === "thinking") {
      this.handleThinkingInput(data);
      return;
    }
    this.handleModelInput(data);
  }

  private handleModelInput(data: string): void {
    const { keybindings, onCancel } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      onCancel();
      return;
    }

    if (
      keybindings.matches(data, "tui.input.tab") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift("tab"))
    ) {
      this.toggleScope();
      return;
    }

    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.activateModelRow(this.filteredRows[this.modelSelectedIndex]);
      return;
    }

    const total = this.filteredRows.length;
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      if (total > 0) {
        this.modelSelectedIndex = this.modelSelectedIndex > 0 ? this.modelSelectedIndex - 1 : total - 1;
        this.modelScrollOffset = ensureIndexInWindow(
          this.modelSelectedIndex,
          this.modelScrollOffset,
          total,
          this.lastModelListMaxRows,
        );
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      if (total > 0) {
        this.modelSelectedIndex = this.modelSelectedIndex < total - 1 ? this.modelSelectedIndex + 1 : 0;
        this.modelScrollOffset = ensureIndexInWindow(
          this.modelSelectedIndex,
          this.modelScrollOffset,
          total,
          this.lastModelListMaxRows,
        );
      }
      return;
    }

    const pageTarget = getSelectPageIndex(
      keybindings,
      data,
      this.modelSelectedIndex,
      total,
      Math.max(1, this.lastModelListMaxRows - 2),
    );
    if (pageTarget !== undefined) {
      if (total > 0) {
        this.modelSelectedIndex = pageTarget;
        this.modelScrollOffset = ensureIndexInWindow(
          this.modelSelectedIndex,
          this.modelScrollOffset,
          total,
          this.lastModelListMaxRows,
        );
      }
      return;
    }

    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== before) {
      this.applyModelFilter(false);
    }
  }

  private handleThinkingInput(data: string): void {
    const { keybindings } = this.options;

    if (
      keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.backspace) ||
      matchesKey(data, Key.left)
    ) {
      this.returnToModelStep();
      return;
    }

    if (
      keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      data === " "
    ) {
      this.commitThinkingSelection();
      return;
    }

    const total = this.availableThinkingLevels.length;
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      if (total > 0) {
        this.thinkingSelectedIndex =
          this.thinkingSelectedIndex > 0 ? this.thinkingSelectedIndex - 1 : total - 1;
        this.thinkingScrollOffset = ensureIndexInWindow(
          this.thinkingSelectedIndex,
          this.thinkingScrollOffset,
          total,
          this.lastThinkingListMaxRows,
        );
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      if (total > 0) {
        this.thinkingSelectedIndex =
          this.thinkingSelectedIndex < total - 1 ? this.thinkingSelectedIndex + 1 : 0;
        this.thinkingScrollOffset = ensureIndexInWindow(
          this.thinkingSelectedIndex,
          this.thinkingScrollOffset,
          total,
          this.lastThinkingListMaxRows,
        );
      }
      return;
    }

    const pageTarget = getSelectPageIndex(
      keybindings,
      data,
      this.thinkingSelectedIndex,
      total,
      Math.max(1, this.lastThinkingListMaxRows - 2),
    );
    if (pageTarget !== undefined && total > 0) {
      this.thinkingSelectedIndex = pageTarget;
      this.thinkingScrollOffset = ensureIndexInWindow(
        this.thinkingSelectedIndex,
        this.thinkingScrollOffset,
        total,
        this.lastThinkingListMaxRows,
      );
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.step === "thinking") {
      return this.handleThinkingMouse(event);
    }
    return this.handleModelMouse(event);
  }

  private handleModelMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      if (delta !== 0 && this.filteredRows.length > 0) {
        const maxOffset = Math.max(0, this.filteredRows.length - 1);
        this.modelScrollOffset = Math.max(0, Math.min(maxOffset, this.modelScrollOffset + delta));
      }
      return { handled: true, render: true };
    }

    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "input" && this.searchBounds) {
        this.searchInput.handleMouse({
          ...event,
          x: event.x - this.searchBounds.x,
          y: 0,
          width: this.searchBounds.width,
          height: 1,
        });
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "tab") {
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "option" && hit.index !== undefined) {
        this.modelSelectedIndex = hit.index;
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "tab") {
        if (hit.id === "scoped" || hit.id === "all") {
          this.setScope(hit.id);
        }
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "option" && hit.index !== undefined) {
        const row = this.filteredRows[hit.index];
        if (row) {
          this.modelSelectedIndex = hit.index;
          this.activateModelRow(row);
          return { handled: true, focus: true, render: true };
        }
      }
      return { handled: true, render: false };
    }

    return undefined;
  }

  private handleThinkingMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      if (delta !== 0 && this.availableThinkingLevels.length > 0) {
        const maxOffset = Math.max(0, this.availableThinkingLevels.length - 1);
        this.thinkingScrollOffset = Math.max(
          0,
          Math.min(maxOffset, this.thinkingScrollOffset + delta),
        );
      }
      return { handled: true, render: true };
    }

    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "action") {
        return { handled: true, focus: true, render: false };
      }
      if (hit?.kind === "option" && hit.index !== undefined) {
        this.thinkingSelectedIndex = hit.index;
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "action" && hit.id === "back-to-models") {
        this.returnToModelStep();
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "option" && hit.index !== undefined) {
        if (this.availableThinkingLevels[hit.index]) {
          this.thinkingSelectedIndex = hit.index;
          this.commitThinkingSelection();
          return { handled: true, focus: true, render: true };
        }
      }
      return { handled: true, render: false };
    }

    return undefined;
  }
}
