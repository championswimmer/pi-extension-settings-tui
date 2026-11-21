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
import type { ValueTone } from "../../schema/index.js";
import {
  computeListWindow,
  ensureIndexInWindow,
  fitToWidth,
  renderScrollIndicator,
  toneToThemeColor,
} from "../frame.js";
import { HitRegionTracker } from "../hit-test.js";
import type { ChildBounds, DialogRouteComponent } from "../types.js";

/** Option descriptor for `SelectRoute`. */
export interface SelectRouteOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly tone?: ValueTone;
}

/** Configuration for `SelectRoute`. */
export interface SelectRouteOptions<T extends string = string> {
  readonly title: string;
  readonly description?: string;
  readonly options: readonly SelectRouteOption<T>[];
  readonly currentValue: T;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onSelect: (value: T) => void;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

/** Searchable single-select sub-route using `Input` + `fuzzyFilter`. */
export class SelectRoute<T extends string = string> implements DialogRouteComponent {
  readonly title: string;
  private readonly options: SelectRouteOptions<T>;
  private readonly searchInput: Input;
  private readonly tracker = new HitRegionTracker();
  private searchBounds?: ChildBounds;
  private filteredOptions: SelectRouteOption<T>[];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private lastListMaxRows = 8;
  private _focused = false;

  constructor(options: SelectRouteOptions<T>) {
    this.options = options;
    this.title = options.title;
    this.searchInput = new Input({
      prompt: options.theme.fg("accent", "/ "),
      placeholder: "Filter options...",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });

    this.filteredOptions = [...options.options];
    const currentIdx = this.filteredOptions.findIndex((o) => o.value === options.currentValue);
    this.selectedIndex = currentIdx >= 0 ? currentIdx : 0;
    this.scrollOffset = Math.max(0, this.selectedIndex - 2);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private applyFilter(): void {
    const query = this.searchInput.getValue().trim();
    const prevSelected = this.filteredOptions[this.selectedIndex]?.value;

    if (!query) {
      this.filteredOptions = [...this.options.options];
    } else {
      this.filteredOptions = fuzzyFilter(
        [...this.options.options],
        query,
        (opt) => `${opt.label} ${opt.value} ${opt.description ?? ""}`,
      );
    }

    if (this.filteredOptions.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }

    const retainedIdx = prevSelected
      ? this.filteredOptions.findIndex((o) => o.value === prevSelected)
      : -1;
    this.selectedIndex = retainedIdx >= 0 ? retainedIdx : 0;
    this.scrollOffset = ensureIndexInWindow(
      this.selectedIndex,
      0,
      this.filteredOptions.length,
      this.lastListMaxRows,
    );
  }

  private doesOptionDescriptionFitInline(opt: SelectRouteOption<T>, safeWidth: number): boolean {
    if (!opt.description) return true;
    if (safeWidth < 32) return false;
    const prefixW = 4; // `${cursor} ${mark} `
    const maxLabelW = Math.min(Math.floor(safeWidth * 0.55), Math.max(12, safeWidth - prefixW - 8));
    const clippedLabel = truncateToWidth(opt.label, maxLabelW, "…", false);
    const remaining = Math.max(0, safeWidth - prefixW - visibleWidth(clippedLabel) - 2);
    return remaining >= 4 && visibleWidth(opt.description) <= remaining;
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

    const showHint = maxHeight >= 6 ? 1 : 0;
    const searchHeight = 1;
    const baseRemaining = maxHeight - descLines.length - searchHeight - showHint;

    const highlightedOpt = this.filteredOptions[this.selectedIndex];
    let previewLines: string[] = [];
    if (
      maxHeight >= 10 &&
      highlightedOpt?.description &&
      !this.doesOptionDescriptionFitInline(highlightedOpt, safeWidth)
    ) {
      const previewCap = maxHeight >= 14 ? 2 : 1;
      const maxPreviewBudget = Math.max(0, baseRemaining - 2);
      const previewCount = Math.min(previewCap, maxPreviewBudget);
      if (previewCount > 0) {
        previewLines = wrapTextWithAnsi(highlightedOpt.description, safeWidth)
          .slice(0, previewCount)
          .map((l) => fitToWidth(theme.fg("muted", l), safeWidth));
      }
    }

    const listMaxRows = Math.max(1, baseRemaining - previewLines.length);
    this.lastListMaxRows = listMaxRows;

    const lines: string[] = [...descLines];

    const searchY = lines.length;
    this.searchBounds = { x: 0, y: searchY, width: safeWidth, height: 1 };
    this.tracker.add({ y: searchY, x0: 0, x1: safeWidth, kind: "input", id: "search" });
    const renderedSearch = this.searchInput.render(safeWidth)[0] ?? "";
    lines.push(fitToWidth(renderedSearch, safeWidth));

    if (this.filteredOptions.length === 0) {
      lines.push(fitToWidth(theme.fg("muted", "  No matching options."), safeWidth));
    } else {
      const win = computeListWindow(this.filteredOptions.length, this.scrollOffset, listMaxRows);
      this.scrollOffset = win.scrollOffset;

      if (win.aboveCount > 0) {
        lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
      }

      for (let idx = win.start; idx < win.end; idx++) {
        const opt = this.filteredOptions[idx]!;
        const isSelected = idx === this.selectedIndex;
        const isCurrent = opt.value === this.options.currentValue;
        const rowY = lines.length;

        this.tracker.add({
          y: rowY,
          x0: 0,
          x1: safeWidth,
          kind: "option",
          id: opt.value,
          index: idx,
        });

        const cursor = isSelected ? theme.fg("accent", "❯") : " ";
        const mark = isCurrent ? theme.fg("success", "●") : " ";
        const labelColor = isSelected ? "accent" : toneToThemeColor(opt.tone);
        const labelText = theme.fg(labelColor, opt.label);
        const prefix = `${cursor} ${mark} `;
        const prefixW = visibleWidth(prefix);

        let rowLine: string;
        if (opt.description && safeWidth >= 32) {
          const maxLabelW = Math.min(Math.floor(safeWidth * 0.55), Math.max(12, safeWidth - prefixW - 8));
          const clippedLabel = truncateToWidth(labelText, maxLabelW, "…", false);
          const remaining = Math.max(0, safeWidth - prefixW - visibleWidth(clippedLabel) - 2);
          const desc = remaining >= 4
            ? "  " + theme.fg("dim", truncateToWidth(opt.description, remaining, "…", false))
            : "";
          rowLine = `${prefix}${clippedLabel}${desc}`;
        } else {
          rowLine = `${prefix}${labelText}`;
        }

        const padded = fitToWidth(rowLine, safeWidth);
        lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
      }

      if (win.belowCount > 0) {
        lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
      }
    }

    for (const previewLine of previewLines) {
      if (lines.length + showHint < maxHeight) {
        lines.push(previewLine);
      }
    }

    if (showHint && lines.length < maxHeight) {
      lines.push(
        fitToWidth(
          theme.fg("dim", "↑/↓ move · PgUp/PgDn page · Type to filter · Enter select · Esc back"),
          safeWidth,
        ),
      );
    }

    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    const { keybindings, onSelect, onCancel } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      onCancel();
      return;
    }

    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const selected = this.filteredOptions[this.selectedIndex];
      if (selected) {
        onSelect(selected.value);
      }
      return;
    }

    const total = this.filteredOptions.length;
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      if (total > 0) {
        this.selectedIndex = this.selectedIndex > 0 ? this.selectedIndex - 1 : total - 1;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          total,
          this.lastListMaxRows,
        );
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      if (total > 0) {
        this.selectedIndex = this.selectedIndex < total - 1 ? this.selectedIndex + 1 : 0;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          total,
          this.lastListMaxRows,
        );
      }
      return;
    }

    const pageTarget = getSelectPageIndex(
      keybindings,
      data,
      this.selectedIndex,
      total,
      Math.max(1, this.lastListMaxRows - 2),
    );
    if (pageTarget !== undefined) {
      if (total > 0) {
        this.selectedIndex = pageTarget;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          total,
          this.lastListMaxRows,
        );
      }
      return;
    }

    const before = this.searchInput.getValue();
    this.searchInput.handleInput(data);
    if (this.searchInput.getValue() !== before) {
      this.applyFilter();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      if (delta !== 0 && this.filteredOptions.length > 0) {
        const maxOffset = Math.max(0, this.filteredOptions.length - 1);
        this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
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
      if (hit?.kind === "option" && hit.index !== undefined) {
        this.selectedIndex = hit.index;
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "option" && hit.index !== undefined) {
        const opt = this.filteredOptions[hit.index];
        if (opt) {
          this.selectedIndex = hit.index;
          this.options.onSelect(opt.value);
          return { handled: true, focus: true, render: true };
        }
      }
      return { handled: true, render: false };
    }

    return undefined;
  }
}
