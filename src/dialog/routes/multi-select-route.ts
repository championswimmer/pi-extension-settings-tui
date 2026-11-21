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
  computeListWindow,
  ensureIndexInWindow,
  fitToWidth,
  formatActionPill,
  renderScrollIndicator,
} from "../frame.js";
import { HitRegionTracker, renderPillRow } from "../hit-test.js";
import type { ChildBounds, DialogRouteComponent } from "../types.js";

/** Option descriptor for `MultiSelectRoute`. */
export interface MultiSelectRouteOption<T extends string = string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
}

/** Configuration for `MultiSelectRoute`. */
export interface MultiSelectRouteOptions<T extends string = string> {
  readonly title: string;
  readonly description?: string;
  readonly options: readonly MultiSelectRouteOption<T>[];
  readonly initialValues: readonly T[];
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly collapsibleGroups?: boolean;
  readonly allowCustom?: boolean;
  readonly maxItemLength?: number;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onSubmit: (values: T[]) => void;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

type MultiRow<T extends string> =
  | {
      readonly kind: "group";
      readonly group: string;
      readonly collapsed: boolean;
      readonly selectedCount: number;
      readonly totalCount: number;
    }
  | {
      readonly kind: "option";
      readonly option: MultiSelectRouteOption<T>;
    }
  | {
      readonly kind: "addCustom";
      readonly value: T;
    };

/** Searchable checklist sub-route with optional collapsible groups and count validation. */
export class MultiSelectRoute<T extends string = string> implements DialogRouteComponent {
  readonly title: string;
  private readonly options: MultiSelectRouteOptions<T>;
  private readonly searchInput: Input;
  private readonly tracker = new HitRegionTracker();
  private searchBounds?: ChildBounds;
  private allOptions: MultiSelectRouteOption<T>[];
  private selectedSet: Set<T>;
  private collapsedGroups = new Set<string>();
  private rows: MultiRow<T>[] = [];
  private selectedIndex = 0;
  private scrollOffset = 0;
  private lastListMaxRows = 8;
  private errorMessage: string | undefined;
  private _focused = false;

  constructor(options: MultiSelectRouteOptions<T>) {
    this.options = options;
    this.title = options.title;
    this.searchInput = new Input({
      prompt: options.theme.fg("accent", "/ "),
      placeholder: "Filter items...",
      placeholderStyle: (text) => options.theme.fg("dim", text),
    });

    this.selectedSet = new Set(options.initialValues);
    this.allOptions = [...options.options];

    // Preserve any initial custom values not listed in static options.
    const known = new Set(this.allOptions.map((o) => o.value));
    for (const val of options.initialValues) {
      if (!known.has(val)) {
        this.allOptions.push({ value: val, label: val });
        known.add(val);
      }
    }

    this.rebuildRows();
    this.validateSelection();
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

  private getFilteredOptions(): MultiSelectRouteOption<T>[] {
    const query = this.searchInput.getValue().trim();
    if (!query) {
      return [...this.allOptions];
    }
    return fuzzyFilter(
      [...this.allOptions],
      query,
      (opt) => `${opt.label} ${opt.value} ${opt.group ?? ""} ${opt.description ?? ""}`,
    );
  }

  private rebuildRows(): void {
    const query = this.searchInput.getValue().trim();
    const filtered = this.getFilteredOptions();
    const hasGroups = filtered.some((o) => o.group !== undefined);
    const nextRows: MultiRow<T>[] = [];

    if (!hasGroups) {
      for (const option of filtered) {
        nextRows.push({ kind: "option", option });
      }
    } else {
      const grouped = new Map<string, MultiSelectRouteOption<T>[]>();
      const ungrouped: MultiSelectRouteOption<T>[] = [];

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
        nextRows.push({ kind: "option", option });
      }

      for (const [group, items] of grouped.entries()) {
        const collapsed = !query && this.options.collapsibleGroups !== false && this.collapsedGroups.has(group);
        let selectedCount = 0;
        for (const item of items) {
          if (this.selectedSet.has(item.value)) selectedCount++;
        }
        nextRows.push({
          kind: "group",
          group,
          collapsed,
          selectedCount,
          totalCount: items.length,
        });
        if (!collapsed) {
          for (const option of items) {
            nextRows.push({ kind: "option", option });
          }
        }
      }
    }

    if (
      this.options.allowCustom &&
      query.length > 0 &&
      !this.allOptions.some((o) => o.value === (query as T))
    ) {
      nextRows.push({ kind: "addCustom", value: query as T });
    }

    this.rows = nextRows;
    if (this.rows.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.rows.length - 1));
      this.scrollOffset = ensureIndexInWindow(
        this.selectedIndex,
        this.scrollOffset,
        this.rows.length,
        this.lastListMaxRows,
      );
    }
  }

  private validateSelection(): boolean {
    const count = this.selectedSet.size;
    if (this.options.minItems !== undefined && count < this.options.minItems) {
      this.errorMessage = `Select at least ${this.options.minItems} item(s) (${count} selected).`;
      return false;
    }
    if (this.options.maxItems !== undefined && count > this.options.maxItems) {
      this.errorMessage = `Select at most ${this.options.maxItems} item(s) (${count} selected).`;
      return false;
    }
    if (this.options.maxItemLength !== undefined) {
      for (const val of this.selectedSet) {
        if (val.length > this.options.maxItemLength) {
          this.errorMessage = `Item "${val}" exceeds max length of ${this.options.maxItemLength}.`;
          return false;
        }
      }
    }
    this.errorMessage = undefined;
    return true;
  }

  private getOrderedSelectedValues(): T[] {
    const ordered: T[] = [];
    for (const opt of this.allOptions) {
      if (this.selectedSet.has(opt.value)) {
        ordered.push(opt.value);
      }
    }
    return ordered;
  }

  private toggleOptionValue(value: T): void {
    if (this.selectedSet.has(value)) {
      this.selectedSet.delete(value);
    } else {
      if (this.options.maxItemLength !== undefined && value.length > this.options.maxItemLength) {
        this.errorMessage = `Item exceeds max length of ${this.options.maxItemLength}.`;
        return;
      }
      this.selectedSet.add(value);
    }
    this.validateSelection();
    this.rebuildRows();
  }

  private addCustomValue(value: T): void {
    if (this.options.maxItemLength !== undefined && value.length > this.options.maxItemLength) {
      this.errorMessage = `Item exceeds max length of ${this.options.maxItemLength}.`;
      return;
    }
    if (!this.allOptions.some((o) => o.value === value)) {
      this.allOptions.push({ value, label: value });
    }
    this.selectedSet.add(value);
    this.searchInput.setValue("");
    this.validateSelection();
    this.rebuildRows();
  }

  private toggleGroup(group: string): void {
    if (this.options.collapsibleGroups === false) return;
    if (this.collapsedGroups.has(group)) {
      this.collapsedGroups.delete(group);
    } else {
      this.collapsedGroups.add(group);
    }
    this.rebuildRows();
  }

  private toggleAllFiltered(): void {
    const filtered = this.getFilteredOptions();
    if (filtered.length === 0) return;

    const allSelected = filtered.every((o) => this.selectedSet.has(o.value));
    if (allSelected) {
      for (const o of filtered) {
        this.selectedSet.delete(o.value);
      }
    } else {
      for (const o of filtered) {
        this.selectedSet.add(o.value);
      }
    }
    this.validateSelection();
    this.rebuildRows();
  }

  private tryCommit(): void {
    if (!this.validateSelection()) {
      return;
    }
    this.options.onSubmit(this.getOrderedSelectedValues());
  }

  render(width: number): string[] {
    this.tracker.clear();
    this.searchBounds = undefined;

    const safeWidth = Math.max(8, width);
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 18);
    const { theme } = this.options;

    const descLines =
      this.options.description && maxHeight >= 9
        ? wrapTextWithAnsi(this.options.description, safeWidth)
            .slice(0, 1)
            .map((l) => fitToWidth(theme.fg("muted", l), safeWidth))
        : [];

    const errorLines = this.errorMessage
      ? [fitToWidth(theme.fg("error", `⚠ ${this.errorMessage}`), safeWidth)]
      : [];

    const footerLinesCount = maxHeight >= 7 ? 2 : 1;
    const searchHeight = 1;
    const listMaxRows = Math.max(
      1,
      maxHeight - descLines.length - searchHeight - errorLines.length - footerLinesCount,
    );
    this.lastListMaxRows = listMaxRows;

    const lines: string[] = [...descLines];

    const searchY = lines.length;
    this.searchBounds = { x: 0, y: searchY, width: safeWidth, height: 1 };
    this.tracker.add({ y: searchY, x0: 0, x1: safeWidth, kind: "input", id: "search" });
    lines.push(fitToWidth(this.searchInput.render(safeWidth)[0] ?? "", safeWidth));

    if (this.rows.length === 0) {
      lines.push(fitToWidth(theme.fg("muted", "  No matching items."), safeWidth));
    } else {
      const win = computeListWindow(this.rows.length, this.scrollOffset, listMaxRows);
      this.scrollOffset = win.scrollOffset;

      if (win.aboveCount > 0) {
        lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
      }

      for (let idx = win.start; idx < win.end; idx++) {
        const row = this.rows[idx]!;
        const isSelected = idx === this.selectedIndex;
        const rowY = lines.length;
        const cursor = isSelected ? theme.fg("accent", "❯") : " ";

        if (row.kind === "group") {
          this.tracker.add({
            y: rowY,
            x0: 0,
            x1: safeWidth,
            kind: "group",
            id: row.group,
            index: idx,
          });
          const glyph = row.collapsed ? "[+]" : "[-]";
          const countBadge = theme.fg("dim", `(${row.selectedCount}/${row.totalCount})`);
          const text = `${cursor} ${theme.fg("accent", glyph)} ${theme.bold(row.group)} ${countBadge}`;
          const padded = fitToWidth(text, safeWidth);
          lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
        } else if (row.kind === "addCustom") {
          this.tracker.add({
            y: rowY,
            x0: 0,
            x1: safeWidth,
            kind: "option",
            id: `__add__:${row.value}`,
            index: idx,
          });
          const text = `${cursor} ${theme.fg("accent", "+")} Add custom "${row.value}"`;
          const padded = fitToWidth(text, safeWidth);
          lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
        } else {
          const opt = row.option;
          this.tracker.add({
            y: rowY,
            x0: 0,
            x1: safeWidth,
            kind: "option",
            id: opt.value,
            index: idx,
          });
          const checked = this.selectedSet.has(opt.value);
          const box = checked ? theme.fg("success", "[x]") : theme.fg("muted", "[ ]");
          const indent = opt.group ? "  " : "";
          const label = theme.fg(isSelected ? "accent" : "text", opt.label);
          const prefix = `${cursor} ${indent}${box} `;
          const prefixW = visibleWidth(prefix);

          let rowLine: string;
          if (opt.description && safeWidth >= 34) {
            const maxLabelW = Math.min(Math.floor(safeWidth * 0.55), Math.max(10, safeWidth - prefixW - 8));
            const clippedLabel = truncateToWidth(label, maxLabelW, "…", false);
            const remaining = Math.max(0, safeWidth - prefixW - visibleWidth(clippedLabel) - 2);
            const desc = remaining >= 4
              ? "  " + theme.fg("dim", truncateToWidth(opt.description, remaining, "…", false))
              : "";
            rowLine = `${prefix}${clippedLabel}${desc}`;
          } else {
            rowLine = `${prefix}${label}`;
          }
          const padded = fitToWidth(rowLine, safeWidth);
          lines.push(isSelected ? theme.bg("selectedBg", padded) : padded);
        }
      }

      if (win.belowCount > 0) {
        lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
      }
    }

    lines.push(...errorLines);

    if (lines.length < maxHeight) {
      const buttonY = lines.length;
      const applyPill = formatActionPill("Enter Apply", theme, {
        highlighted: !this.errorMessage,
        tone: this.errorMessage ? "muted" : "accent",
      });
      const cancelPill = formatActionPill("Esc Cancel", theme, { tone: "muted" });
      const countSummary = theme.fg("muted", ` ${this.selectedSet.size} selected`);
      const pillRow = renderPillRow(
        [
          { kind: "action", id: "apply", text: applyPill },
          { kind: "action", id: "cancel", text: cancelPill },
        ],
        {
          tracker: this.tracker,
          y: buttonY,
          startX: 0,
          separator: "  ",
          maxWidth: safeWidth,
        },
      );
      lines.push(fitToWidth(`${pillRow}${countSummary}`, safeWidth));
    }

    if (lines.length < maxHeight) {
      lines.push(
        fitToWidth(
          theme.fg("dim", "Space toggle · Ctrl+A all · Enter apply/fold · Esc cancel"),
          safeWidth,
        ),
      );
    }

    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    const { keybindings, onCancel } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      onCancel();
      return;
    }

    if (matchesKey(data, Key.ctrl("a"))) {
      this.toggleAllFiltered();
      return;
    }

    if (matchesKey(data, Key.space) || data === " ") {
      const row = this.rows[this.selectedIndex];
      if (!row) return;
      if (row.kind === "group") {
        this.toggleGroup(row.group);
      } else if (row.kind === "addCustom") {
        this.addCustomValue(row.value);
      } else {
        this.toggleOptionValue(row.option.value);
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      const row = this.rows[this.selectedIndex];
      if (row?.kind === "group") {
        this.toggleGroup(row.group);
        return;
      }
      if (row?.kind === "addCustom") {
        this.addCustomValue(row.value);
        return;
      }
      this.tryCommit();
      return;
    }

    const total = this.rows.length;
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
      this.rebuildRows();
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
      if ((hit?.kind === "option" || hit?.kind === "group") && hit.index !== undefined) {
        this.selectedIndex = hit.index;
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "action") {
        return { handled: true, focus: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "action") {
        if (hit.id === "apply") {
          this.tryCommit();
        } else if (hit.id === "cancel") {
          this.options.onCancel();
        }
        return { handled: true, focus: true, render: true };
      }

      if ((hit?.kind === "option" || hit?.kind === "group") && hit.index !== undefined) {
        const row = this.rows[hit.index];
        if (row) {
          this.selectedIndex = hit.index;
          if (row.kind === "group") {
            this.toggleGroup(row.group);
          } else if (row.kind === "addCustom") {
            this.addCustomValue(row.value);
          } else {
            this.toggleOptionValue(row.option.value);
          }
          return { handled: true, focus: true, render: true };
        }
      }

      return { handled: true, render: false };
    }

    return undefined;
  }
}
