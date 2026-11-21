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
import { deepEqual, type DynamicPickerOption } from "../../schema/index.js";
import {
  computeListWindow,
  ensureIndexInWindow,
  fitToWidth,
  formatActionPill,
  renderScrollIndicator,
  toneToThemeColor,
} from "../frame.js";
import { HitRegionTracker, renderPillRow, type PillItem } from "../hit-test.js";
import type { ChildBounds, DialogRouteComponent } from "../types.js";

/** Configuration for `DynamicPickerRoute`. */
export interface DynamicPickerRouteOptions<T = unknown> {
  readonly title: string;
  readonly description?: string;
  readonly loadOptions: (
    signal: AbortSignal,
  ) => readonly DynamicPickerOption<T>[] | Promise<readonly DynamicPickerOption<T>[]>;
  readonly currentValue: T;
  readonly equals?: (a: T, b: T) => boolean;
  readonly allowClear?: boolean;
  readonly clearValue?: T;
  readonly emptyLabel?: string;
  readonly emptyDescription?: string;
  readonly searchable?: boolean;
  readonly refreshable?: boolean;
  readonly validateSelection?: (
    option: DynamicPickerOption<T>,
    signal: AbortSignal,
  ) => boolean | string | Promise<boolean | string>;
  readonly tui?: { requestRender(): void };
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onSelect: (value: T) => void;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

type DynamicPickerRow<T> =
  | { readonly kind: "clear" }
  | { readonly kind: "group"; readonly group: string }
  | { readonly kind: "option"; readonly option: DynamicPickerOption<T> };

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Searchable single-select sub-route backed by a sync or async option loader,
 * optional grouping, disabled-reason feedback, and async selection validation.
 */
export class DynamicPickerRoute<T = unknown> implements DialogRouteComponent {
  readonly title: string;
  private readonly options: DynamicPickerRouteOptions<T>;
  private readonly searchInput: Input | undefined;
  private readonly tracker = new HitRegionTracker();
  private searchBounds: ChildBounds | undefined;

  private allOptions: DynamicPickerOption<T>[] = [];
  private rows: DynamicPickerRow<T>[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private lastListMaxRows = 8;

  private loading = false;
  private validating = false;
  private loadError: string | undefined;
  private errorMessage: string | undefined;

  private loadAbortController: AbortController | undefined;
  private validateAbortController: AbortController | undefined;
  private loadSeq = 0;
  private validateSeq = 0;
  private disposed = false;
  private _focused = false;

  constructor(options: DynamicPickerRouteOptions<T>) {
    this.options = options;
    this.title = options.title;

    if (options.searchable !== false) {
      this.searchInput = new Input({
        prompt: options.theme.fg("accent", "/ "),
        placeholder: "Filter options...",
        placeholderStyle: (text) => options.theme.fg("dim", text),
      });
    }

    this.startLoad(true);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.searchInput) {
      this.searchInput.focused = value;
    }
  }

  invalidate(): void {
    this.searchInput?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
    this.validateAbortController?.abort();
    this.validateAbortController = undefined;
  }

  private isEqual(a: T, b: T): boolean {
    return this.options.equals ? this.options.equals(a, b) : deepEqual(a, b);
  }

  private getClearValue(): T {
    return (this.options.clearValue !== undefined ? this.options.clearValue : null) as T;
  }

  private isSearchable(): boolean {
    return this.options.searchable !== false && this.searchInput !== undefined;
  }

  private isRefreshable(): boolean {
    return this.options.refreshable !== false;
  }

  private startLoad(preferCurrent: boolean): void {
    if (this.disposed) return;

    this.loadAbortController?.abort();
    this.validateAbortController?.abort();
    this.validateAbortController = undefined;
    this.validating = false;

    const controller = new AbortController();
    this.loadAbortController = controller;
    const seq = ++this.loadSeq;

    this.loading = true;
    this.loadError = undefined;
    this.errorMessage = undefined;

    let result: readonly DynamicPickerOption<T>[] | Promise<readonly DynamicPickerOption<T>[]>;
    try {
      result = this.options.loadOptions(controller.signal);
    } catch (err) {
      if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
        return;
      }
      this.loading = false;
      this.allOptions = [];
      this.rows = [];
      this.loadError = err instanceof Error ? err.message : String(err);
      this.errorMessage = this.loadError;
      return;
    }

    if (!isPromiseLike<readonly DynamicPickerOption<T>[]>(result)) {
      if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
        return;
      }
      this.allOptions = [...result];
      this.loading = false;
      this.loadError = undefined;
      this.rebuildRows(preferCurrent);
      return;
    }

    Promise.resolve(result).then(
      (loaded) => {
        if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
          return;
        }
        this.allOptions = [...loaded];
        this.loading = false;
        this.loadError = undefined;
        this.rebuildRows(preferCurrent);
        this.options.tui?.requestRender();
      },
      (err: unknown) => {
        if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.loadError = err instanceof Error ? err.message : String(err);
        this.errorMessage = this.loadError;
        this.options.tui?.requestRender();
      },
    );
  }

  private rebuildRows(preferCurrent = false): void {
    const query = this.searchInput?.getValue().trim() ?? "";
    const prevRow = this.rows[this.selectedIndex];
    const prevId =
      prevRow?.kind === "clear"
        ? "__clear__"
        : prevRow?.kind === "option"
          ? prevRow.option.id
          : undefined;

    const filtered = query
      ? fuzzyFilter(
          [...this.allOptions],
          query,
          (opt) => `${opt.label} ${opt.group ?? ""} ${opt.badge ?? ""} ${opt.description ?? ""} ${opt.id}`,
        )
      : [...this.allOptions];

    const rows: DynamicPickerRow<T>[] = [];
    const emptyLabel = this.options.emptyLabel ?? "None";
    const emptyDescription = this.options.emptyDescription ?? "Clear selection";

    if (this.options.allowClear && !query) {
      rows.push({ kind: "clear" });
    }

    const hasGroups = filtered.some((o) => Boolean(o.group));
    if (!hasGroups) {
      for (const option of filtered) {
        rows.push({ kind: "option", option });
      }
    } else {
      const ungrouped: DynamicPickerOption<T>[] = [];
      const grouped = new Map<string, DynamicPickerOption<T>[]>();

      for (const option of filtered) {
        if (option.group) {
          const bucket = grouped.get(option.group);
          if (bucket) {
            bucket.push(option);
          } else {
            grouped.set(option.group, [option]);
          }
        } else {
          ungrouped.push(option);
        }
      }

      for (const option of ungrouped) {
        rows.push({ kind: "option", option });
      }

      for (const [group, items] of grouped.entries()) {
        rows.push({ kind: "group", group });
        for (const option of items) {
          rows.push({ kind: "option", option });
        }
      }
    }

    if (this.options.allowClear && query) {
      const clearMatch = fuzzyFilter(
        [{ kind: "clear" as const }],
        query,
        () => `${emptyLabel} ${emptyDescription} none clear default`,
      );
      if (clearMatch.length > 0) {
        rows.push({ kind: "clear" });
      }
    }

    this.rows = rows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }

    const firstSelectable = rows.findIndex((r) => r.kind !== "group");
    if (firstSelectable === -1) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }

    if (query) {
      this.selectedIndex = firstSelectable;
    } else if (preferCurrent) {
      if (this.options.allowClear && this.isEqual(this.options.currentValue, this.getClearValue())) {
        const clearIdx = rows.findIndex((r) => r.kind === "clear");
        this.selectedIndex = clearIdx >= 0 ? clearIdx : firstSelectable;
      } else {
        const currentIdx = rows.findIndex(
          (r) => r.kind === "option" && this.isEqual(r.option.value, this.options.currentValue),
        );
        this.selectedIndex = currentIdx >= 0 ? currentIdx : firstSelectable;
      }
    } else if (prevId) {
      const retainedIdx = rows.findIndex((r) =>
        r.kind === "clear" ? prevId === "__clear__" : r.kind === "option" && r.option.id === prevId,
      );
      this.selectedIndex = retainedIdx >= 0 ? retainedIdx : firstSelectable;
    } else {
      this.selectedIndex = firstSelectable;
    }

    this.syncScrollToSelected();
  }

  private syncScrollToSelected(): void {
    if (this.rows.length === 0) {
      this.scrollOffset = 0;
      return;
    }
    this.scrollOffset = ensureIndexInWindow(
      this.selectedIndex,
      this.scrollOffset,
      this.rows.length,
      this.lastListMaxRows,
    );
    // Keep preceding group header in view when landing on its first option.
    if (this.selectedIndex > 0 && this.rows[this.selectedIndex - 1]?.kind === "group") {
      const win = computeListWindow(this.rows.length, this.scrollOffset, this.lastListMaxRows);
      if (this.selectedIndex - 1 < win.start) {
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex - 1,
          this.scrollOffset,
          this.rows.length,
          this.lastListMaxRows,
        );
      }
    }
  }

  private moveSelection(delta: 1 | -1): void {
    const total = this.rows.length;
    if (total === 0) return;

    let idx = this.selectedIndex;
    for (let step = 0; step < total; step++) {
      idx = (idx + delta + total) % total;
      if (this.rows[idx]?.kind !== "group") {
        this.selectedIndex = idx;
        this.errorMessage = this.loadError;
        this.syncScrollToSelected();
        return;
      }
    }
  }

  private findSelectableNear(target: number, preferDirection: 1 | -1): number {
    const total = this.rows.length;
    if (total === 0) return 0;
    const clamped = Math.max(0, Math.min(total - 1, target));
    if (this.rows[clamped]?.kind !== "group") return clamped;

    for (let offset = 1; offset < total; offset++) {
      const primary = clamped + offset * preferDirection;
      if (primary >= 0 && primary < total && this.rows[primary]?.kind !== "group") {
        return primary;
      }
      const secondary = clamped - offset * preferDirection;
      if (secondary >= 0 && secondary < total && this.rows[secondary]?.kind !== "group") {
        return secondary;
      }
    }
    return clamped;
  }

  private activateSelectedRow(): void {
    const row = this.rows[this.selectedIndex];
    if (!row || row.kind === "group") return;
    this.activateRow(row);
  }

  private activateRow(row: DynamicPickerRow<T>): void {
    if (row.kind === "group") return;

    if (row.kind === "clear") {
      this.validateAbortController?.abort();
      this.validateAbortController = undefined;
      this.validating = false;
      this.errorMessage = undefined;
      this.options.onSelect(this.getClearValue());
      return;
    }

    const opt = row.option;
    if (opt.disabled || opt.disabledReason) {
      this.errorMessage = opt.disabledReason || "Option unavailable";
      return;
    }

    if (!this.options.validateSelection) {
      this.errorMessage = undefined;
      this.options.onSelect(opt.value);
      return;
    }

    this.validateAbortController?.abort();
    const controller = new AbortController();
    this.validateAbortController = controller;
    const seq = ++this.validateSeq;

    this.validating = true;
    this.errorMessage = undefined;

    const applyOutcome = (outcome: boolean | string): void => {
      if (outcome === true || outcome === "") {
        this.errorMessage = undefined;
        this.options.onSelect(opt.value);
      } else if (outcome === false) {
        this.errorMessage = "Selection is invalid.";
      } else {
        this.errorMessage = outcome;
      }
    };

    let result: boolean | string | Promise<boolean | string>;
    try {
      result = this.options.validateSelection(opt, controller.signal);
    } catch (err) {
      if (this.disposed || controller.signal.aborted || seq !== this.validateSeq) {
        return;
      }
      this.validating = false;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      return;
    }

    if (!isPromiseLike<boolean | string>(result)) {
      if (this.disposed || controller.signal.aborted || seq !== this.validateSeq) {
        return;
      }
      this.validating = false;
      applyOutcome(result);
      return;
    }

    this.options.tui?.requestRender();
    Promise.resolve(result).then(
      (outcome) => {
        if (this.disposed || controller.signal.aborted || seq !== this.validateSeq) {
          return;
        }
        this.validating = false;
        applyOutcome(outcome);
        this.options.tui?.requestRender();
      },
      (err: unknown) => {
        if (this.disposed || controller.signal.aborted || seq !== this.validateSeq) {
          return;
        }
        this.validating = false;
        this.errorMessage = err instanceof Error ? err.message : String(err);
        this.options.tui?.requestRender();
      },
    );
  }

  private doesOptionDescriptionFitInline(opt: DynamicPickerOption<T>, safeWidth: number): boolean {
    if (!opt.description) return true;
    const badgeBudget = opt.badge && safeWidth >= 24
      ? Math.min(visibleWidth(opt.badge), Math.floor(safeWidth * 0.3)) + 2
      : 0;
    const leftBudget = Math.max(8, safeWidth - badgeBudget);
    if (leftBudget < 30) return false;
    const prefixW = opt.group ? 6 : 4; // `${cursor} ${mark} ` + optional group indent
    const maxLabelW = Math.min(Math.floor(leftBudget * 0.55), Math.max(12, leftBudget - prefixW - 8));
    const clippedLabel = truncateToWidth(opt.label, maxLabelW, "…", false);
    const remaining = Math.max(0, leftBudget - prefixW - visibleWidth(clippedLabel) - 2);
    return remaining >= 4 && visibleWidth(opt.description) <= remaining;
  }

  private renderOptionRow(opt: DynamicPickerOption<T>, isSelected: boolean, safeWidth: number): string {
    const { theme } = this.options;
    const isDisabled = Boolean(opt.disabled || opt.disabledReason);
    const isCurrent = this.isEqual(opt.value, this.options.currentValue);

    const cursor = isSelected ? theme.fg("accent", "❯") : " ";
    const mark = isCurrent ? theme.fg("success", "●") : " ";
    const indent = opt.group ? "  " : "";
    const prefix = `${cursor} ${mark} ${indent}`;
    const prefixW = visibleWidth(prefix);

    const labelColor = isDisabled
      ? "dim"
      : isSelected
        ? "accent"
        : toneToThemeColor(opt.tone);
    const labelText = theme.fg(labelColor, opt.label);

    let styledBadge = "";
    let badgeW = 0;
    if (opt.badge && safeWidth >= 24) {
      const maxBadgeW = Math.max(4, Math.floor(safeWidth * 0.3));
      const clippedBadge = truncateToWidth(opt.badge, maxBadgeW, "…", false);
      const badgeColor = isDisabled ? "dim" : toneToThemeColor(opt.badgeTone ?? "muted");
      styledBadge = theme.fg(badgeColor, clippedBadge);
      badgeW = visibleWidth(styledBadge);
    }

    const leftBudget = badgeW > 0 ? Math.max(8, safeWidth - badgeW - 2) : safeWidth;
    let leftPart: string;

    if (opt.description && leftBudget >= 30) {
      const maxLabelW = Math.min(
        Math.floor(leftBudget * 0.55),
        Math.max(12, leftBudget - prefixW - 8),
      );
      const clippedLabel = truncateToWidth(labelText, maxLabelW, "…", false);
      const remaining = Math.max(0, leftBudget - prefixW - visibleWidth(clippedLabel) - 2);
      const desc =
        remaining >= 4
          ? "  " + theme.fg("dim", truncateToWidth(opt.description, remaining, "…", false))
          : "";
      leftPart = `${prefix}${clippedLabel}${desc}`;
    } else {
      leftPart = truncateToWidth(`${prefix}${labelText}`, leftBudget, "…", false);
    }

    if (badgeW > 0) {
      const gap = Math.max(2, safeWidth - visibleWidth(leftPart) - badgeW);
      return `${leftPart}${" ".repeat(gap)}${styledBadge}`;
    }

    return leftPart;
  }

  render(width: number): string[] {
    this.tracker.clear();
    this.searchBounds = undefined;

    const safeWidth = Math.max(8, width);
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 18);
    const { theme } = this.options;

    const descLines =
      this.options.description && maxHeight >= 8
        ? wrapTextWithAnsi(this.options.description, safeWidth)
            .slice(0, 1)
            .map((l) => fitToWidth(theme.fg("muted", l), safeWidth))
        : [];

    const bannerLine = this.validating
      ? fitToWidth(theme.fg("accent", "⏳ Validating selection…"), safeWidth)
      : this.errorMessage
        ? fitToWidth(theme.fg("error", `⚠ ${this.errorMessage}`), safeWidth)
        : undefined;
    const bannerCount = bannerLine ? 1 : 0;

    const footerLinesCount = maxHeight >= 7 ? 2 : maxHeight >= 5 ? 1 : 0;
    const searchHeight = this.isSearchable() ? 1 : 0;
    const baseRemaining = Math.max(
      1,
      maxHeight - descLines.length - searchHeight - bannerCount - footerLinesCount,
    );

    // Optional preview below list for long description or disabledReason
    const highlightedRow = this.rows[this.selectedIndex];
    let previewLines: string[] = [];
    if (maxHeight >= 10 && highlightedRow?.kind === "option") {
      const opt = highlightedRow.option;
      const previewCap = maxHeight >= 14 ? 2 : 1;
      const maxPreviewBudget = Math.max(0, baseRemaining - 2);
      const previewCount = Math.min(previewCap, maxPreviewBudget);

      if (previewCount > 0) {
        if (opt.disabledReason) {
          previewLines = wrapTextWithAnsi(`Disabled: ${opt.disabledReason}`, safeWidth)
            .slice(0, previewCount)
            .map((l) => fitToWidth(theme.fg("warning", l), safeWidth));
        } else if (opt.description && !this.doesOptionDescriptionFitInline(opt, safeWidth)) {
          previewLines = wrapTextWithAnsi(opt.description, safeWidth)
            .slice(0, previewCount)
            .map((l) => fitToWidth(theme.fg("muted", l), safeWidth));
        }
      }
    }

    const listMaxRows = Math.max(1, baseRemaining - previewLines.length);
    this.lastListMaxRows = listMaxRows;

    const lines: string[] = [...descLines];

    if (this.searchInput && this.isSearchable()) {
      const searchY = lines.length;
      this.searchBounds = { x: 0, y: searchY, width: safeWidth, height: 1 };
      this.tracker.add({ y: searchY, x0: 0, x1: safeWidth, kind: "input", id: "search" });
      lines.push(fitToWidth(this.searchInput.render(safeWidth)[0] ?? "", safeWidth));
    }

    if (this.loading) {
      lines.push(fitToWidth(theme.fg("muted", "  Loading options…"), safeWidth));
    } else if (this.rows.length === 0) {
      const emptyMsg = this.loadError
        ? "  Failed to load options."
        : this.allOptions.length === 0
          ? "  No options available."
          : "  No matching options.";
      lines.push(fitToWidth(theme.fg("muted", emptyMsg), safeWidth));
    } else {
      const win = computeListWindow(this.rows.length, this.scrollOffset, listMaxRows);
      this.scrollOffset = win.scrollOffset;

      if (win.aboveCount > 0) {
        lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
      }

      for (let idx = win.start; idx < win.end; idx++) {
        const row = this.rows[idx]!;
        const rowY = lines.length;

        if (row.kind === "group") {
          const groupLabel = theme.fg("muted", theme.bold(` ${row.group}`));
          lines.push(fitToWidth(groupLabel, safeWidth));
          continue;
        }

        const isSelected = idx === this.selectedIndex;

        if (row.kind === "clear") {
          this.tracker.add({
            y: rowY,
            x0: 0,
            x1: safeWidth,
            kind: "option",
            id: "__clear__",
            index: idx,
          });
          const cursor = isSelected ? theme.fg("accent", "❯") : " ";
          const isCurrent = this.isEqual(this.options.currentValue, this.getClearValue());
          const mark = isCurrent ? theme.fg("success", "●") : " ";
          const label = theme.fg(isSelected ? "accent" : "muted", this.options.emptyLabel ?? "None");
          const prefix = `${cursor} ${mark} `;
          const desc = this.options.emptyDescription ?? "Clear selection";
          let rowLine = `${prefix}${label}`;
          if (safeWidth >= 34 && desc) {
            const remaining = Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(label) - 2);
            if (remaining >= 6) {
              rowLine += `  ${theme.fg("dim", truncateToWidth(desc, remaining, "…", false))}`;
            }
          }
          const padded = fitToWidth(rowLine, safeWidth);
          lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
          continue;
        }

        const opt = row.option;
        this.tracker.add({
          y: rowY,
          x0: 0,
          x1: safeWidth,
          kind: "option",
          id: opt.id,
          index: idx,
        });
        const rendered = this.renderOptionRow(opt, isSelected, safeWidth);
        const padded = fitToWidth(rendered, safeWidth);
        lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
      }

      if (win.belowCount > 0) {
        lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
      }
    }

    for (const previewLine of previewLines) {
      if (lines.length + bannerCount + footerLinesCount < maxHeight) {
        lines.push(previewLine);
      }
    }

    if (bannerLine && lines.length + footerLinesCount < maxHeight) {
      lines.push(bannerLine);
    }

    if (footerLinesCount >= 1 && lines.length < maxHeight) {
      const pillY = lines.length;
      const pills: PillItem[] = [];
      if (this.isRefreshable()) {
        pills.push({
          kind: "action",
          id: "refresh",
          text: formatActionPill("Ctrl+R Refresh", theme, { tone: "accent" }),
        });
      }
      pills.push({
        kind: "action",
        id: "cancel",
        text: formatActionPill("Esc Cancel", theme, { tone: "muted" }),
      });

      const pillRow = renderPillRow(pills, {
        tracker: this.tracker,
        y: pillY,
        startX: 0,
        separator: "  ",
        maxWidth: safeWidth,
      });
      lines.push(fitToWidth(pillRow, safeWidth));
    }

    if (footerLinesCount >= 2 && lines.length < maxHeight) {
      const parts = ["↑/↓ move", "PgUp/PgDn page"];
      if (this.isSearchable()) parts.push("Type to filter");
      if (this.isRefreshable()) parts.push("Ctrl+R refresh");
      parts.push("Enter select", "Esc back");
      lines.push(fitToWidth(theme.fg("dim", parts.join(" · ")), safeWidth));
    }

    return lines.slice(0, maxHeight);
  }

  private cancelRoute(): void {
    this.loadAbortController?.abort();
    this.validateAbortController?.abort();
    this.validating = false;
    this.options.onCancel();
  }

  handleInput(data: string): void {
    const { keybindings } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.cancelRoute();
      return;
    }

    if (this.isRefreshable() && matchesKey(data, Key.ctrl("r"))) {
      this.startLoad(false);
      this.options.tui?.requestRender();
      return;
    }

    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      this.activateSelectedRow();
      return;
    }

    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }

    const total = this.rows.length;
    const pageTarget = getSelectPageIndex(
      keybindings,
      data,
      this.selectedIndex,
      total,
      Math.max(1, this.lastListMaxRows - 2),
    );
    if (pageTarget !== undefined) {
      if (total > 0) {
        const dir: 1 | -1 = pageTarget >= this.selectedIndex ? 1 : -1;
        this.selectedIndex = this.findSelectableNear(pageTarget, dir);
        this.errorMessage = this.loadError;
        this.syncScrollToSelected();
      }
      return;
    }

    if (this.searchInput && this.isSearchable()) {
      const before = this.searchInput.getValue();
      this.searchInput.handleInput(data);
      if (this.searchInput.getValue() !== before) {
        this.errorMessage = this.loadError;
        this.rebuildRows(false);
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      if (delta !== 0 && this.rows.length > 0) {
        const maxOffset = Math.max(0, this.rows.length - 1);
        this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
      }
      return { handled: true, render: true };
    }

    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "input" && this.searchBounds && this.searchInput) {
        this.searchInput.handleMouse({
          ...event,
          x: event.x - this.searchBounds.x,
          y: 0,
          width: this.searchBounds.width,
          height: 1,
        });
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "option" && hit.index !== undefined) {
        const row = this.rows[hit.index];
        if (row && row.kind !== "group") {
          this.selectedIndex = hit.index;
          return { handled: true, focus: true, render: true };
        }
      }
      if (hit?.kind === "action") {
        return { handled: true, focus: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "action") {
        if (hit.id === "refresh" && this.isRefreshable()) {
          this.startLoad(false);
          return { handled: true, focus: true, render: true };
        }
        if (hit.id === "cancel") {
          this.cancelRoute();
          return { handled: true, focus: true, render: true };
        }
      }

      if (hit?.kind === "option" && hit.index !== undefined) {
        const row = this.rows[hit.index];
        if (row && row.kind !== "group") {
          this.selectedIndex = hit.index;
          this.activateRow(row);
          return { handled: true, focus: true, render: true };
        }
      }

      return { handled: true, render: false };
    }

    return undefined;
  }
}
