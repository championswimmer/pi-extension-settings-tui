import {
  getSelectPageIndex,
  isFocusable,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  cloneValue,
  deepEqual,
  type AnyFieldDef,
  type EnumFieldDef,
  type FieldMap,
  type FieldProvenance,
  type InferSettingsValues,
  type ModelFieldDef,
  type ModelSelection,
  type MultiSelectFieldDef,
  type NumberFieldDef,
  type SaveMode,
  type SettingsScope,
  type StringFieldDef,
} from "../schema/index.js";
import { ConcurrencyConflictError, type LoadedSettings } from "../store/index.js";
import {
  computeListWindow,
  ensureIndexInWindow,
  fitToWidth,
  formatActionPill,
  getFrameInnerWidth,
  getFramePadding,
  joinLeftRight,
  renderBoxBottom,
  renderBoxDivider,
  renderBoxLine,
  renderBoxTop,
  renderScrollIndicator,
  toneToThemeColor,
} from "./frame.js";
import { HitRegionTracker, renderPillRow, type PillItem } from "./hit-test.js";
import { ConfirmRoute } from "./routes/confirm-route.js";
import { ModelPickerRoute } from "./routes/model-picker-route.js";
import { MultiSelectRoute } from "./routes/multi-select-route.js";
import { SelectRoute } from "./routes/select-route.js";
import { TextInputRoute } from "./routes/text-input-route.js";
import type {
  ChildBounds,
  DialogFrame,
  DialogRouteComponent,
  SettingsDialogOptions,
  SettingsDialogResult,
} from "./types.js";

type RootRow<TFields extends FieldMap> =
  | {
      readonly kind: "field";
      readonly key: keyof TFields & string;
      readonly def: AnyFieldDef;
      readonly disabled: boolean;
    }
  | { readonly kind: "divider" }
  | { readonly kind: "scope"; readonly disabled: false }
  | { readonly kind: "restore"; readonly disabled: false };

interface StatusBanner {
  readonly text: string;
  readonly tone: "info" | "warn" | "error" | "success";
}

/**
 * Single-overlay declarative settings dialog supporting tabs, provenance,
 * draft/immediate save modes, nested sub-routes, keyboard navigation, and
 * fullscreen mouse interaction.
 */
export class SettingsDialogComponent<TFields extends FieldMap>
  implements Component, Focusable
{
  readonly capturesViewportInput = true;

  private readonly options: SettingsDialogOptions<TFields>;
  private readonly saveMode: SaveMode;
  private readonly tracker = new HitRegionTracker();

  private loadedState: LoadedSettings<InferSettingsValues<TFields>>;
  private baselineValues: InferSettingsValues<TFields>;
  private draftValues: InferSettingsValues<TFields>;
  private activeScope: SettingsScope;
  private activeTabId: string;

  private selectedIndex = 0;
  private scrollOffset = 0;
  private lastBodyMaxRows = 10;
  private lastSubrouteBodyBudget = 14;
  private lastChildBounds: ChildBounds | undefined;
  private pressedRowAlreadySelected = false;

  private routeStack: DialogFrame[] = [];
  private statusBanner: StatusBanner | undefined;
  private conflictError = false;
  private isSaving = false;
  private pendingImmediateSave = false;
  private draftVersion = 0;
  private everSavedImmediate = false;
  private closed = false;
  private _focused = false;

  constructor(options: SettingsDialogOptions<TFields>) {
    this.options = options;
    this.saveMode = options.saveMode ?? options.schema.saveMode;
    this.loadedState = options.initialState;
    this.baselineValues = cloneValue(options.initialState.effective);
    this.draftValues = cloneValue(options.initialState.effective);

    this.activeScope = this.resolveInitialScope();
    this.activeTabId = this.resolveInitialTab(options.initialTab);

    if (options.initialState.warnings.length > 0) {
      this.statusBanner = {
        text: options.initialState.warnings[0]!,
        tone: "warn",
      };
    }

    this.navigateTo({
      tab: options.initialTab,
      field: options.initialField,
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    const active = this.routeStack[this.routeStack.length - 1];
    if (active && isFocusable(active.component)) {
      active.component.focused = value;
    }
  }

  private resolveInitialScope(): SettingsScope {
    const { schema, initialState } = this.options;
    if (!initialState.trustedProject && schema.scopes.includes("global")) {
      return "global";
    }
    if (schema.scopes.includes(schema.defaultScope)) {
      return schema.defaultScope;
    }
    return schema.scopes[0] ?? "global";
  }

  private resolveInitialTab(tabId?: string): string {
    const { tabs } = this.options.schema;
    if (tabId && tabs.some((t) => t.id === tabId)) {
      return tabId;
    }
    return tabs[0]?.id ?? "general";
  }

  private isFieldDirty(key: string): boolean {
    return !deepEqual(this.draftValues[key], this.baselineValues[key]);
  }

  private getDirtyFieldKeys(): string[] {
    return Object.keys(this.options.schema.fields).filter((key) => this.isFieldDirty(key));
  }

  private isDirty(): boolean {
    return this.getDirtyFieldKeys().length > 0;
  }

  /** Jump to a specific tab and/or field key cleanly. */
  navigateTo(target: { tab?: string; field?: string }): void {
    // Pop sub-routes if host re-invokes navigation onto an existing overlay.
    if (target.tab || target.field) {
      this.clearRoutes();
    }

    if (target.tab && this.options.schema.tabs.some((t) => t.id === target.tab)) {
      this.activeTabId = target.tab;
      this.scrollOffset = 0;
    }

    if (target.field) {
      // Find which tab contains the requested field if tab wasn't specified.
      if (!target.tab) {
        for (const tab of this.options.schema.tabs) {
          const found = this.options.schema
            .getFieldsForTab(tab.id)
            .some((entry) => entry.key === target.field);
          if (found) {
            this.activeTabId = tab.id;
            break;
          }
        }
      }
      const rows = this.buildRootRows();
      const idx = rows.findIndex(
        (r) => r.kind === "field" && r.key === target.field && !r.disabled,
      );
      if (idx >= 0) {
        this.selectedIndex = idx;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          rows.length,
          this.lastBodyMaxRows,
        );
        return;
      }
    }

    const rows = this.buildRootRows();
    const first = this.findSelectableIndex(rows, 0, 1);
    this.selectedIndex = first >= 0 ? first : 0;
    this.scrollOffset = 0;
  }

  /** Abort the dialog cleanly without saving (`closedBy: "abort"`). */
  abort(): void {
    this.finish({
      saved: this.saveMode === "immediate" ? this.everSavedImmediate : false,
      values: cloneValue(this.baselineValues),
      scope: this.activeScope,
      dirty: this.isDirty(),
      closedBy: "abort",
    });
  }

  /** Release any resources held by open sub-routes. */
  dispose(): void {
    this.clearRoutes();
  }

  invalidate(): void {
    for (const frame of this.routeStack) {
      frame.component.invalidate();
    }
  }

  private clearRoutes(): void {
    while (this.routeStack.length > 0) {
      const frame = this.routeStack.pop();
      frame?.component.dispose?.();
    }
  }

  private pushRoute(title: string, component: DialogRouteComponent): void {
    if (isFocusable(component)) {
      component.focused = this._focused;
    }
    this.routeStack.push({ title, component });
    this.options.tui.requestRender();
  }

  private popRoute(): void {
    const popped = this.routeStack.pop();
    popped?.component.dispose?.();
    const top = this.routeStack[this.routeStack.length - 1];
    if (top && isFocusable(top.component)) {
      top.component.focused = this._focused;
    }
    this.options.tui.requestRender();
  }

  private finish(result: SettingsDialogResult<InferSettingsValues<TFields>>): void {
    if (this.closed) return;
    this.closed = true;
    this.clearRoutes();
    this.options.done(result);
  }

  private buildRootRows(): RootRow<TFields>[] {
    const { schema } = this.options;
    const tabFields = schema.getFieldsForTab(this.activeTabId);
    const rows: RootRow<TFields>[] = [];

    for (const entry of tabFields) {
      if (entry.def.visibleWhen && !entry.def.visibleWhen(this.draftValues)) {
        continue;
      }
      const disabled =
        typeof entry.def.disabled === "function"
          ? entry.def.disabled(this.draftValues)
          : Boolean(entry.def.disabled);
      rows.push({
        kind: "field",
        key: entry.key,
        def: entry.def,
        disabled,
      });
    }

    if (rows.length > 0) {
      rows.push({ kind: "divider" });
    }

    if (schema.scopes.length > 1) {
      rows.push({ kind: "scope", disabled: false });
    }
    rows.push({ kind: "restore", disabled: false });

    return rows;
  }

  private isRowSelectable(row: RootRow<TFields> | undefined): boolean {
    if (!row || row.kind === "divider") return false;
    return !row.disabled;
  }

  private findSelectableIndex(
    rows: readonly RootRow<TFields>[],
    startIndex: number,
    direction: 1 | -1,
    wrap = false,
  ): number {
    if (rows.length === 0) return -1;
    let idx = Math.max(0, Math.min(startIndex, rows.length - 1));
    for (let step = 0; step < rows.length; step++) {
      if (this.isRowSelectable(rows[idx])) {
        return idx;
      }
      idx += direction;
      if (idx < 0 || idx >= rows.length) {
        if (!wrap) return -1;
        idx = (idx + rows.length) % rows.length;
      }
    }
    return -1;
  }

  private alignSelection(rows: readonly RootRow<TFields>[], preferredKey?: string): void {
    if (preferredKey) {
      const match = rows.findIndex(
        (r) => r.kind === "field" && r.key === preferredKey && !r.disabled,
      );
      if (match >= 0) {
        this.selectedIndex = match;
        return;
      }
    }
    if (this.isRowSelectable(rows[this.selectedIndex])) {
      return;
    }
    const forward = this.findSelectableIndex(rows, this.selectedIndex, 1);
    if (forward >= 0) {
      this.selectedIndex = forward;
      return;
    }
    const backward = this.findSelectableIndex(rows, this.selectedIndex, -1);
    this.selectedIndex = backward >= 0 ? backward : 0;
  }

  private getActiveTabLabel(): string {
    const tab = this.options.schema.tabs.find((t) => t.id === this.activeTabId);
    return tab?.label ?? this.activeTabId;
  }

  private renderProvenanceCells(provenance: FieldProvenance, theme: Theme): string {
    switch (provenance) {
      case "global":
        return `${theme.fg("accent", "●")}  `;
      case "project":
        return `  ${theme.fg("success", "●")}`;
      case "both":
        return `${theme.fg("accent", "●")} ${theme.fg("success", "●")}`;
      case "default":
      default:
        return "   ";
    }
  }

  private getHeightBudget(): number {
    const rows = this.options.tui.terminal?.rows ?? 24;
    return Math.max(8, rows - 4);
  }

  render(width: number): string[] {
    this.tracker.clear();
    this.lastChildBounds = undefined;

    const safeWidth = Math.max(16, width);
    const innerWidth = getFrameInnerWidth(safeWidth);
    const pad = getFramePadding(safeWidth);
    const startX = 1 + pad;
    const maxLines = this.getHeightBudget();
    const activeFrame = this.routeStack[this.routeStack.length - 1];

    if (activeFrame) {
      return this.renderSubrouteFrame(safeWidth, innerWidth, startX, maxLines, activeFrame);
    }

    return this.renderRootFrame(safeWidth, innerWidth, startX, maxLines);
  }

  private renderHeaderLine(innerWidth: number, breadcrumb?: string): string {
    const { schema, theme } = this.options;
    let left = theme.fg("accent", theme.bold(schema.title));
    if (breadcrumb) {
      left += theme.fg("muted", ` › ${breadcrumb}`);
    }

    const rightParts: string[] = [];
    if (this.saveMode === "draft") {
      const dirtyCount = this.getDirtyFieldKeys().length;
      if (dirtyCount > 0) {
        rightParts.push(
          theme.fg("warning", dirtyCount > 1 ? `● Unsaved (${dirtyCount})` : "● Unsaved"),
        );
      }
    }
    const scopeLabel = this.activeScope === "project" ? "Project" : "Global";
    const scopeColor = this.activeScope === "project" ? "success" : "accent";
    rightParts.push(theme.fg(scopeColor, `[${scopeLabel}]`));

    const right = rightParts.join(" ");
    return joinLeftRight(left, right, innerWidth);
  }

  private renderSubrouteFrame(
    safeWidth: number,
    innerWidth: number,
    startX: number,
    maxLines: number,
    frame: DialogFrame,
  ): string[] {
    const { schema, theme } = this.options;
    const showDivider = maxLines >= 9;
    // Chrome: top border (1) + header (1) + optional divider + footer (1) + bottom border (1)
    const chromeCount = 4 + (showDivider ? 1 : 0);
    const bodyBudget = Math.max(1, maxLines - chromeCount);
    this.lastSubrouteBodyBudget = bodyBudget;

    const tabPart = schema.hasExplicitTabs ? `${this.getActiveTabLabel()} › ` : "";
    const breadcrumb = `${tabPart}${frame.title}`;

    const lines: string[] = [];
    lines.push(renderBoxTop(safeWidth, theme));
    lines.push(renderBoxLine(this.renderHeaderLine(innerWidth, breadcrumb), safeWidth, theme));
    if (showDivider) {
      lines.push(renderBoxDivider(safeWidth, theme));
    }

    const bodyStartY = lines.length;
    const childLines = frame.component.render(innerWidth).slice(0, bodyBudget);
    if (childLines.length === 0) {
      childLines.push("");
    }

    this.lastChildBounds = {
      x: startX,
      y: bodyStartY,
      width: innerWidth,
      height: childLines.length,
    };

    for (const childLine of childLines) {
      lines.push(renderBoxLine(childLine, safeWidth, theme));
    }

    const footerY = lines.length;
    const backPill = formatActionPill("Esc Back", theme, { tone: "muted" });
    const backPillW = visibleWidth(backPill);
    const modeHintRaw =
      this.options.tui.mode === "fullscreen"
        ? "Click or use keys inside view"
        : "Esc returns to settings";
    const hintBudget = Math.max(0, innerWidth - backPillW - 1);
    const clippedHint =
      hintBudget >= 8
        ? truncateToWidth(theme.fg("dim", modeHintRaw), hintBudget, "…", false)
        : "";
    const hintW = visibleWidth(clippedHint);
    const gap = Math.max(clippedHint ? 1 : 0, innerWidth - hintW - backPillW);
    const pillText = renderPillRow([{ kind: "action", id: "back", text: backPill }], {
      tracker: this.tracker,
      y: footerY,
      startX: startX + hintW + gap,
      maxWidth: innerWidth - hintW,
    });
    lines.push(renderBoxLine(`${clippedHint}${" ".repeat(gap)}${pillText}`, safeWidth, theme));
    lines.push(renderBoxBottom(safeWidth, theme));

    return lines.slice(0, maxLines);
  }

  private renderRootFrame(
    safeWidth: number,
    innerWidth: number,
    startX: number,
    maxLines: number,
  ): string[] {
    const { schema, theme } = this.options;
    const rows = this.buildRootRows();
    this.alignSelection(rows);

    const hasTabs = schema.tabs.length > 1;
    const isMultiScope = schema.scopes.length > 1;
    const showDivider = maxLines >= 10;
    const showLegend = isMultiScope && maxLines >= 12;

    const selectedRow = rows[this.selectedIndex];
    const helpInfo = this.getHelpText(selectedRow);
    const maxHelpLines = maxLines >= 15 && helpInfo.lines > 1 ? 2 : maxLines >= 10 ? 1 : 0;

    // Chrome: top(1) + header(1) + tabs(0|1) + divider(0|1) + help(0..2) + legend(0|1) + footer(1) + bottom(1)
    let fixedChrome = 4 + (hasTabs ? 1 : 0) + (showDivider ? 1 : 0) + (showLegend ? 1 : 0) + maxHelpLines;
    // Guarantee at least 2 body rows when possible.
    while (maxLines - fixedChrome < 2 && maxHelpLines > 0) {
      fixedChrome--;
      break;
    }
    const bodyMaxRows = Math.max(1, maxLines - fixedChrome);
    this.lastBodyMaxRows = bodyMaxRows;

    const lines: string[] = [];
    lines.push(renderBoxTop(safeWidth, theme));
    lines.push(renderBoxLine(this.renderHeaderLine(innerWidth), safeWidth, theme));

    if (hasTabs) {
      const tabY = lines.length;
      const tabItems: PillItem[] = schema.tabs.map((tab, idx) => {
        const active = tab.id === this.activeTabId;
        const chip = active
          ? theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${tab.label} `)))
          : theme.fg("muted", ` ${tab.label} `);
        return { kind: "tab", id: tab.id, text: chip, index: idx };
      });
      const tabBar = renderPillRow(tabItems, {
        tracker: this.tracker,
        y: tabY,
        startX,
        separator: " ",
        maxWidth: innerWidth,
      });
      lines.push(renderBoxLine(tabBar, safeWidth, theme));
    }

    if (showDivider) {
      lines.push(renderBoxDivider(safeWidth, theme));
    }

    // Scrollable body
    const win = computeListWindow(rows.length, this.scrollOffset, bodyMaxRows);
    this.scrollOffset = win.scrollOffset;

    if (win.aboveCount > 0) {
      lines.push(
        renderBoxLine(
          renderScrollIndicator("up", win.aboveCount, innerWidth, theme),
          safeWidth,
          theme,
        ),
      );
    }

    for (let idx = win.start; idx < win.end; idx++) {
      const row = rows[idx]!;
      const rowY = lines.length;
      const isSelected = idx === this.selectedIndex;

      if (row.kind === "divider") {
        lines.push(
          renderBoxLine(theme.fg("borderMuted", "─".repeat(innerWidth)), safeWidth, theme),
        );
        continue;
      }

      if (!row.disabled) {
        this.tracker.add({
          y: rowY,
          x0: startX,
          x1: startX + innerWidth,
          kind: "row",
          id: row.kind === "field" ? row.key : `__${row.kind}__`,
          index: idx,
        });
      }

      const renderedRow = this.renderRootRow(row, isSelected, innerWidth, isMultiScope);
      const padded = fitToWidth(renderedRow, innerWidth);
      lines.push(
        renderBoxLine(isSelected ? theme.bg("selectedBg", padded) : padded, safeWidth, theme),
      );
    }

    if (win.belowCount > 0) {
      lines.push(
        renderBoxLine(
          renderScrollIndicator("down", win.belowCount, innerWidth, theme),
          safeWidth,
          theme,
        ),
      );
    }

    // Help / status banner (respecting remaining budget)
    const remainingForHelpAndFooter = Math.max(2, maxLines - lines.length);
    const reserveFooterAndLegend = 2 + (showLegend ? 1 : 0);
    const actualHelpBudget = Math.max(
      0,
      Math.min(maxHelpLines, remainingForHelpAndFooter - reserveFooterAndLegend),
    );
    if (actualHelpBudget > 0) {
      const renderedHelp = helpInfo.render(innerWidth, actualHelpBudget);
      for (const hLine of renderedHelp) {
        lines.push(renderBoxLine(hLine, safeWidth, theme));
      }
    }

    if (showLegend && lines.length + 2 < maxLines) {
      const legend = `${theme.fg("dim", "Saved:")} ${theme.fg("accent", "●")} ${theme.fg("muted", "Global")} ${theme.fg("dim", "·")} ${theme.fg("success", "●")} ${theme.fg("muted", "Project")} ${theme.fg("dim", "·")} ${theme.fg("accent", "●")} ${theme.fg("success", "●")} ${theme.fg("muted", "Both")}`;
      lines.push(renderBoxLine(legend, safeWidth, theme));
    }

    // Footer bar (hints + clickable action pills)
    const footerY = lines.length;
    lines.push(renderBoxLine(this.renderFooterBar(innerWidth, footerY, startX), safeWidth, theme));
    lines.push(renderBoxBottom(safeWidth, theme));

    return lines.slice(0, maxLines);
  }

  private renderRootRow(
    row: Exclude<RootRow<TFields>, { kind: "divider" }>,
    isSelected: boolean,
    innerWidth: number,
    isMultiScope: boolean,
  ): string {
    const { schema, theme } = this.options;
    const cursor = isSelected ? theme.fg("accent", "❯") : " ";

    if (row.kind === "scope") {
      const label = theme.fg(isSelected ? "accent" : "text", "Save scope");
      let valueText: string;
      if (this.activeScope === "project") {
        valueText = theme.fg("success", "Project");
      } else if (!this.loadedState.trustedProject && schema.scopes.includes("project")) {
        valueText = `${theme.fg("accent", "Global")} ${theme.fg("dim", "(Project untrusted)")}`;
      } else {
        valueText = theme.fg("accent", "Global");
      }
      return this.formatColumns(cursor, label, "   ", valueText, innerWidth, isMultiScope);
    }

    if (row.kind === "restore") {
      const label = theme.fg(isSelected ? "accent" : "text", "Restore defaults");
      const scopeName = this.activeScope === "project" ? "project" : "global";
      const valueText = theme.fg("warning", `Reset ${scopeName}…`);
      return this.formatColumns(cursor, label, "   ", valueText, innerWidth, isMultiScope);
    }

    const { key, def, disabled } = row;
    const value = this.draftValues[key];
    const formatted = schema.formatFieldValue(key, value);
    const tone = schema.getFieldTone(key, value);

    const labBadge = def.experimental ? ` ${theme.fg("warning", "[lab]")}` : "";
    const dirtyMarker =
      this.saveMode === "draft" && this.isFieldDirty(key) ? ` ${theme.fg("warning", "*")}` : "";
    const labelText = disabled
      ? theme.fg("dim", def.label) + labBadge + dirtyMarker
      : theme.fg(isSelected ? "accent" : "text", def.label) + labBadge + dirtyMarker;

    const provenance = this.loadedState.provenance[key] ?? "default";
    const provCells = isMultiScope ? this.renderProvenanceCells(provenance, theme) : "";
    const valueText = disabled
      ? theme.fg("dim", formatted)
      : theme.fg(toneToThemeColor(tone), formatted);

    return this.formatColumns(cursor, labelText, provCells, valueText, innerWidth, isMultiScope);
  }

  private formatColumns(
    cursor: string,
    label: string,
    provCells: string,
    valueText: string,
    innerWidth: number,
    isMultiScope: boolean,
  ): string {
    const provPart = isMultiScope ? ` ${provCells} ` : " ";
    const provW = visibleWidth(provPart);
    const prefix = `${cursor} `;
    const prefixW = visibleWidth(prefix);

    const avail = Math.max(4, innerWidth - prefixW - provW);
    const labelTarget = Math.max(8, Math.floor(avail * 0.54));
    const clippedLabel = truncateToWidth(label, labelTarget, "…", true);
    const valueBudget = Math.max(4, avail - visibleWidth(clippedLabel));
    const clippedValue = truncateToWidth(valueText, valueBudget, "…", false);
    const padRight = Math.max(0, valueBudget - visibleWidth(clippedValue));

    return `${prefix}${clippedLabel}${provPart}${" ".repeat(padRight)}${clippedValue}`;
  }

  private getHelpText(selectedRow: RootRow<TFields> | undefined): {
    lines: number;
    render: (innerWidth: number, maxRows: number) => string[];
  } {
    const { theme } = this.options;
    let text = "";
    let color: "error" | "warning" | "success" | "muted" = "muted";

    if (this.statusBanner) {
      text = this.statusBanner.text;
      color =
        this.statusBanner.tone === "error"
          ? "error"
          : this.statusBanner.tone === "warn"
            ? "warning"
            : this.statusBanner.tone === "success"
              ? "success"
              : "muted";
    } else if (selectedRow?.kind === "field") {
      text = selectedRow.def.description ?? "";
    } else if (selectedRow?.kind === "scope") {
      text = this.loadedState.trustedProject
        ? "Choose whether edits write to your user-global file or this project."
        : "Project scope is locked because this project is not trusted.";
    } else if (selectedRow?.kind === "restore") {
      text = `Remove all saved overrides in ${this.activeScope} scope.`;
    }

    if (!text) {
      return { lines: 0, render: () => [] };
    }

    const approxLines = text.length > 60 ? 2 : 1;
    return {
      lines: approxLines,
      render: (innerWidth: number, maxRows: number) => {
        const wrapped = wrapTextWithAnsi(text, innerWidth).slice(0, maxRows);
        return wrapped.map((line) => fitToWidth(theme.fg(color, line), innerWidth));
      },
    };
  }

  private renderFooterBar(innerWidth: number, footerY: number, startX: number): string {
    const { schema, theme, tui } = this.options;
    const pills: PillItem[] = [];

    if (this.conflictError) {
      pills.push({
        kind: "action",
        id: "reload",
        text: formatActionPill("R Reload", theme, { highlighted: true, tone: "warning" }),
      });
    }

    if (this.saveMode === "draft") {
      const dirty = this.isDirty();
      pills.push({
        kind: "action",
        id: "save",
        text: formatActionPill("Ctrl+S Save", theme, {
          highlighted: dirty,
          tone: dirty ? "accent" : "muted",
        }),
      });
      pills.push({
        kind: "action",
        id: "discard",
        text: formatActionPill(dirty ? "Esc Discard" : "Esc Close", theme, { tone: "muted" }),
      });
    } else {
      pills.push({
        kind: "action",
        id: "close",
        text: formatActionPill("Esc Close", theme, { tone: "muted" }),
      });
    }

    const totalPillW = pills.reduce((sum, p, i) => sum + visibleWidth(p.text) + (i > 0 ? 1 : 0), 0);
    const hintBudget = Math.max(0, innerWidth - totalPillW - 1);

    const baseHintStr =
      tui.mode === "fullscreen"
        ? schema.tabs.length > 1
          ? "Click/Enter edit · Tab tabs · Wheel scroll"
          : "Click/Enter edit · Wheel scroll"
        : schema.tabs.length > 1
          ? "↑/↓ move · Enter edit · Tab tabs"
          : "↑/↓ move · Enter edit";

    const hintStr =
      this.saveMode === "immediate" ? `Auto-save · ${baseHintStr}` : baseHintStr;

    const clippedHint =
      hintBudget >= 10
        ? truncateToWidth(theme.fg("dim", hintStr), hintBudget, "…", false)
        : "";
    const hintW = visibleWidth(clippedHint);
    const gap = Math.max(clippedHint ? 1 : 0, innerWidth - hintW - totalPillW);
    const pillStartX = startX + hintW + gap;

    const pillRow = renderPillRow(pills, {
      tracker: this.tracker,
      y: footerY,
      startX: pillStartX,
      separator: " ",
      maxWidth: innerWidth - hintW,
    });

    return `${clippedHint}${" ".repeat(gap)}${pillRow}`;
  }

  handleInput(data: string): void {
    const activeFrame = this.routeStack[this.routeStack.length - 1];
    if (activeFrame) {
      activeFrame.component.handleInput?.(data);
      return;
    }

    const { schema, keybindings } = this.options;

    // Conflict reload shortcut
    if (this.conflictError && (data === "r" || data === "R")) {
      void this.reloadFromDisk();
      return;
    }

    // Save shortcut in draft mode
    if (this.saveMode === "draft" && matchesKey(data, Key.ctrl("s"))) {
      void this.persistDraft(this.draftValues, true);
      return;
    }

    // Escape / Cancel
    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      this.closeFromRoot("escape");
      return;
    }

    // Tab switching
    if (schema.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.cycleTab(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.cycleTab(-1);
        return;
      }
    }

    const rows = this.buildRootRows();
    if (rows.length === 0) return;

    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      const prev = this.findSelectableIndex(rows, this.selectedIndex - 1, -1, true);
      if (prev >= 0) {
        this.selectedIndex = prev;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          rows.length,
          this.lastBodyMaxRows,
        );
      }
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      const next = this.findSelectableIndex(rows, this.selectedIndex + 1, 1, true);
      if (next >= 0) {
        this.selectedIndex = next;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          rows.length,
          this.lastBodyMaxRows,
        );
      }
      return;
    }

    const pageTarget = getSelectPageIndex(
      keybindings,
      data,
      this.selectedIndex,
      rows.length,
      Math.max(1, this.lastBodyMaxRows - 2),
    );
    if (pageTarget !== undefined) {
      const direction: 1 | -1 = pageTarget >= this.selectedIndex ? 1 : -1;
      const landed =
        this.findSelectableIndex(rows, pageTarget, direction) >= 0
          ? this.findSelectableIndex(rows, pageTarget, direction)
          : this.findSelectableIndex(rows, pageTarget, direction === 1 ? -1 : 1);
      if (landed >= 0) {
        this.selectedIndex = landed;
        this.scrollOffset = ensureIndexInWindow(
          this.selectedIndex,
          this.scrollOffset,
          rows.length,
          this.lastBodyMaxRows,
        );
      }
      return;
    }

    // Inline left/right stepping for scope, enums, numbers, booleans
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      const dir = matchesKey(data, Key.right) ? 1 : -1;
      this.handleInlineStep(rows[this.selectedIndex], dir);
      return;
    }

    // Activate selected row
    if (
      keybindings.matches(data, "tui.select.confirm") ||
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.space) ||
      data === " "
    ) {
      this.activateRow(rows[this.selectedIndex]);
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const activeFrame = this.routeStack[this.routeStack.length - 1];
    if (activeFrame) {
      return this.handleSubrouteMouse(event, activeFrame);
    }

    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      const rows = this.buildRootRows();
      if (delta !== 0 && rows.length > 0) {
        const maxOffset = Math.max(0, rows.length - 1);
        this.scrollOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
      }
      return { handled: true, render: true };
    }

    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      this.pressedRowAlreadySelected = false;
      if (hit?.kind === "row" && hit.index !== undefined) {
        const rows = this.buildRootRows();
        const target = rows[hit.index];
        if (this.isRowSelectable(target)) {
          this.pressedRowAlreadySelected = hit.index === this.selectedIndex;
          this.selectedIndex = hit.index;
          return { handled: true, focus: true, render: true };
        }
      }
      if (hit?.kind === "tab" || hit?.kind === "action") {
        return { handled: true, focus: true, render: true };
      }
      // Claim dead space inside dialog so TuiAltScreen suppresses text selection and synthesizes click.
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "tab") {
        this.switchTab(hit.id);
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "action") {
        this.handleActionPill(hit.id);
        return { handled: true, focus: true, render: true };
      }
      if (hit?.kind === "row" && hit.index !== undefined) {
        const rows = this.buildRootRows();
        const target = rows[hit.index];
        if (this.isRowSelectable(target)) {
          this.selectedIndex = hit.index;
          const isImmediateClickRow =
            target?.kind === "scope" ||
            target?.kind === "restore" ||
            (target?.kind === "field" && target.def.kind === "boolean");
          const shouldActivate =
            isImmediateClickRow || event.clickCount === 2 || this.pressedRowAlreadySelected;
          this.pressedRowAlreadySelected = false;
          if (shouldActivate) {
            this.activateRow(target);
          }
          return { handled: true, focus: true, render: true };
        }
      }
      this.pressedRowAlreadySelected = false;
      return { handled: true, render: false };
    }

    return undefined;
  }

  private handleSubrouteMouse(
    event: TuiMouseEvent,
    frame: DialogFrame,
  ): TuiMouseEventResult | undefined {
    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "action") {
        return { handled: true, focus: true, render: false };
      }
    }
    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "action" && hit.id === "back") {
        this.popRoute();
        return { handled: true, focus: true, render: true };
      }
    }

    const bounds = this.lastChildBounds;
    if (
      bounds &&
      event.x >= bounds.x &&
      event.x < bounds.x + bounds.width &&
      event.y >= bounds.y &&
      event.y < bounds.y + bounds.height
    ) {
      const localEvent: TuiMouseEvent = {
        ...event,
        x: event.x - bounds.x,
        y: event.y - bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      const childResult = frame.component.handleMouse?.(localEvent);
      if (event.type === "press" && event.button === "left") {
        return childResult
          ? { ...childResult, handled: true, focus: true }
          : { handled: true, focus: true, render: false };
      }
      if (childResult) {
        return childResult;
      }
    }

    if (event.type === "press" && event.button === "left") {
      return { handled: true, render: false };
    }
    if (event.type === "wheel") {
      return { handled: true, render: false };
    }
    return undefined;
  }

  private handleActionPill(actionId: string): void {
    switch (actionId) {
      case "save":
        void this.persistDraft(this.draftValues, true);
        break;
      case "discard":
        this.closeFromRoot(this.isDirty() ? "cancel" : "escape");
        break;
      case "close":
        this.closeFromRoot("immediate");
        break;
      case "reload":
        void this.reloadFromDisk();
        break;
      case "back":
        this.popRoute();
        break;
    }
  }

  private closeFromRoot(reason: "escape" | "cancel" | "immediate"): void {
    if (this.saveMode === "immediate") {
      this.finish({
        saved: this.everSavedImmediate,
        values: cloneValue(this.baselineValues),
        scope: this.activeScope,
        dirty: false,
        closedBy: "immediate",
      });
      return;
    }

    this.finish({
      saved: false,
      values: cloneValue(this.baselineValues),
      scope: this.activeScope,
      dirty: this.isDirty(),
      closedBy: reason,
    });
  }

  private switchTab(tabId: string): void {
    if (tabId === this.activeTabId) return;
    if (!this.options.schema.tabs.some((t) => t.id === tabId)) return;
    this.activeTabId = tabId;
    this.scrollOffset = 0;
    const rows = this.buildRootRows();
    const first = this.findSelectableIndex(rows, 0, 1);
    this.selectedIndex = first >= 0 ? first : 0;
    this.statusBanner = undefined;
  }

  private cycleTab(delta: 1 | -1): void {
    const { tabs } = this.options.schema;
    if (tabs.length <= 1) return;
    const currentIdx = Math.max(0, tabs.findIndex((t) => t.id === this.activeTabId));
    const nextIdx = (currentIdx + delta + tabs.length) % tabs.length;
    this.switchTab(tabs[nextIdx]!.id);
  }

  private cycleScope(): void {
    const { schema } = this.options;
    if (schema.scopes.length <= 1) return;

    const currentIdx = Math.max(0, schema.scopes.indexOf(this.activeScope));
    const nextScope = schema.scopes[(currentIdx + 1) % schema.scopes.length]!;

    if (nextScope === "project" && !this.loadedState.trustedProject) {
      this.statusBanner = {
        text: "Cannot switch to Project scope: this project is untrusted.",
        tone: "warn",
      };
      return;
    }

    this.activeScope = nextScope;
    this.statusBanner = {
      text: `Saving target set to ${nextScope === "project" ? "Project" : "Global"} scope.`,
      tone: "info",
    };
  }

  private handleInlineStep(row: RootRow<TFields> | undefined, direction: 1 | -1): void {
    if (!this.isRowSelectable(row) || !row || row.kind === "divider") return;

    if (row.kind === "scope") {
      this.cycleScope();
      return;
    }
    if (row.kind !== "field") return;

    const { key, def } = row;
    if (def.kind === "boolean") {
      this.commitFieldValue(key, !this.draftValues[key]);
      return;
    }
    if (def.kind === "enum") {
      const current = this.draftValues[key] as string;
      const idx = def.options.findIndex((o) => o.value === current);
      if (def.options.length > 0) {
        const nextIdx =
          idx < 0 ? 0 : (idx + direction + def.options.length) % def.options.length;
        this.commitFieldValue(key, def.options[nextIdx]!.value);
      }
      return;
    }
    if (def.kind === "number") {
      const numDef = def as NumberFieldDef<Record<string, unknown>>;
      const step = numDef.step ?? 1;
      const current = Number(this.draftValues[key]);
      if (Number.isFinite(current)) {
        const rawNext = current + direction * step;
        const checked = this.options.schema.validateField(key, rawNext);
        if (checked.ok) {
          this.commitFieldValue(key, checked.value);
        } else {
          this.statusBanner = { text: checked.error, tone: "warn" };
        }
      }
    }
  }

  private activateRow(row: RootRow<TFields> | undefined): void {
    if (!this.isRowSelectable(row) || !row || row.kind === "divider") return;

    if (row.kind === "scope") {
      this.cycleScope();
      return;
    }

    if (row.kind === "restore") {
      this.openRestoreDefaultsConfirm();
      return;
    }

    const { key, def } = row;
    const currentValue = this.draftValues[key];

    switch (def.kind) {
      case "boolean":
        this.commitFieldValue(key, !currentValue);
        break;
      case "enum":
        this.activateEnumField(key, def, currentValue as string);
        break;
      case "multiSelect":
        this.openMultiSelectRoute(key, def, currentValue as string[]);
        break;
      case "string":
        this.openStringRoute(key, def, String(currentValue ?? ""));
        break;
      case "number":
        this.openNumberRoute(key, def, Number(currentValue));
        break;
      case "model":
        this.openModelRoute(key, def, (currentValue as ModelSelection | null) ?? null);
        break;
      case "custom":
        this.openCustomRoute(key, def, currentValue);
        break;
    }
  }

  private activateEnumField(
    key: keyof TFields & string,
    def: EnumFieldDef<string, Record<string, unknown>>,
    currentValue: string,
  ): void {
    const useCycle =
      def.display === "cycle" || (def.display !== "picker" && def.options.length <= 3);

    if (useCycle && def.options.length > 0) {
      const idx = def.options.findIndex((o) => o.value === currentValue);
      const next = def.options[(idx + 1) % def.options.length]!;
      this.commitFieldValue(key, next.value);
      return;
    }

    const route = new SelectRoute({
      title: def.label,
      description: def.description,
      options: def.options,
      currentValue,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      onSelect: (next) => {
        this.popRoute();
        this.commitFieldValue(key, next);
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute(def.label, route);
  }

  private openMultiSelectRoute(
    key: keyof TFields & string,
    def: MultiSelectFieldDef<string, Record<string, unknown>>,
    currentValues: readonly string[],
  ): void {
    const resolvedOptions = typeof def.options === "function" ? def.options() : def.options;
    const route = new MultiSelectRoute({
      title: def.label,
      description: def.description,
      options: resolvedOptions,
      initialValues: currentValues,
      minItems: def.minItems,
      maxItems: def.maxItems,
      collapsibleGroups: def.collapsibleGroups,
      allowCustom: def.allowCustom,
      maxItemLength: def.maxItemLength,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      onSubmit: (nextValues) => {
        const checked = this.options.schema.validateField(key, nextValues);
        if (!checked.ok) {
          this.statusBanner = { text: checked.error, tone: "error" };
          return;
        }
        this.popRoute();
        this.commitFieldValue(key, checked.value);
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute(def.label, route);
  }

  private openStringRoute(
    key: keyof TFields & string,
    def: StringFieldDef<Record<string, unknown>>,
    currentValue: string,
  ): void {
    const route = new TextInputRoute({
      title: def.label,
      description: def.description,
      initialValue: currentValue,
      placeholder: def.placeholder,
      multiline: def.multiline,
      tui: this.options.tui,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      validate: (raw) => {
        const checked = this.options.schema.validateField(key, raw);
        return checked.ok ? { ok: true, value: String(checked.value) } : { ok: false, error: checked.error };
      },
      onSubmit: (next) => {
        const checked = this.options.schema.validateField(key, next);
        if (!checked.ok) return;
        this.popRoute();
        this.commitFieldValue(key, checked.value);
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute(def.label, route);
  }

  private openNumberRoute(
    key: keyof TFields & string,
    def: NumberFieldDef<Record<string, unknown>>,
    currentValue: number,
  ): void {
    const unitSuffix = def.unit ? ` (${def.unit})` : "";
    const route = new TextInputRoute({
      title: `${def.label}${unitSuffix}`,
      description: def.description,
      initialValue: Number.isFinite(currentValue) ? String(currentValue) : "",
      placeholder: def.placeholder ?? "Enter a number",
      multiline: false,
      tui: this.options.tui,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      validate: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return { ok: false, error: "Please enter a numeric value." };
        }
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed)) {
          return { ok: false, error: `"${trimmed}" is not a valid number.` };
        }
        const checked = this.options.schema.validateField(key, parsed);
        return checked.ok ? { ok: true, value: String(checked.value) } : { ok: false, error: checked.error };
      },
      onSubmit: (next) => {
        const parsed = Number(next.trim());
        const checked = this.options.schema.validateField(key, parsed);
        if (!checked.ok) return;
        this.popRoute();
        this.commitFieldValue(key, checked.value);
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute(def.label, route);
  }

  private openModelRoute(
    key: keyof TFields & string,
    def: ModelFieldDef<boolean, Record<string, unknown>>,
    currentValue: ModelSelection | null,
  ): void {
    const resolvedAvailable =
      def.models !== undefined
        ? typeof def.models === "function"
          ? def.models()
          : def.models
        : typeof this.options.availableModels === "function"
          ? this.options.availableModels()
          : (this.options.availableModels ?? []);

    const resolvedScoped =
      def.scopedModels !== undefined
        ? typeof def.scopedModels === "function"
          ? def.scopedModels()
          : def.scopedModels
        : typeof this.options.scopedModels === "function"
          ? this.options.scopedModels()
          : (this.options.scopedModels ?? []);

    const route = new ModelPickerRoute({
      title: def.label,
      description: def.description,
      availableModels: resolvedAvailable,
      scopedModels: resolvedScoped,
      currentValue: currentValue ? cloneValue(currentValue) : null,
      allowClear: def.allowClear,
      emptyLabel: def.emptyLabel,
      emptyDescription: def.emptyDescription,
      defaultScope: def.defaultModelScope,
      thinkingLevels: def.thinkingLevels,
      defaultThinkingLevel: def.defaultThinkingLevel,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      onSelect: (next) => {
        const checked = this.options.schema.validateField(key, next);
        if (!checked.ok) {
          this.statusBanner = { text: checked.error, tone: "error" };
          this.popRoute();
          return;
        }
        this.popRoute();
        this.commitFieldValue(key, checked.value);
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute(def.label, route);
  }

  private openCustomRoute(
    key: keyof TFields & string,
    def: Extract<AnyFieldDef, { kind: "custom" }>,
    currentValue: unknown,
  ): void {
    if (!def.openSubroute) {
      this.statusBanner = {
        text: `${def.label} does not provide an interactive editor.`,
        tone: "warn",
      };
      return;
    }

    const customComp = def.openSubroute({
      fieldKey: key,
      field: def,
      value: cloneValue(currentValue),
      draft: cloneValue(this.draftValues),
      tui: this.options.tui,
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      commit: (next) => {
        const checked = this.options.schema.validateField(key, next);
        if (!checked.ok) {
          this.statusBanner = { text: checked.error, tone: "error" };
          this.popRoute();
          return;
        }
        this.popRoute();
        this.commitFieldValue(key, checked.value);
      },
      cancel: () => {
        this.popRoute();
      },
    });

    if (customComp && typeof (customComp as Component).render === "function") {
      const routeComp = customComp as DialogRouteComponent;
      this.pushRoute(routeComp.title ?? def.label, routeComp);
    } else {
      this.statusBanner = {
        text: `${def.label} did not return a valid sub-route component.`,
        tone: "warn",
      };
    }
  }

  private openRestoreDefaultsConfirm(): void {
    const scopeName = this.activeScope === "project" ? "Project" : "Global";
    const route = new ConfirmRoute({
      title: "Restore defaults",
      message: `Restore defaults for ${scopeName} scope?`,
      detail: `This removes saved ${scopeName.toLowerCase()} overrides and reverts to ${
        this.activeScope === "project" ? "global/default" : "built-in default"
      } values.`,
      confirmLabel: "Restore",
      cancelLabel: "Cancel",
      destructive: true,
      defaultAction: "cancel",
      theme: this.options.theme,
      keybindings: this.options.keybindings,
      getMaxHeight: () => this.lastSubrouteBodyBudget,
      onConfirm: () => {
        this.popRoute();
        void this.performRestoreDefaults();
      },
      onCancel: () => {
        this.popRoute();
      },
    });
    this.pushRoute("Restore defaults", route);
  }

  private commitFieldValue(key: keyof TFields & string, nextValue: unknown): void {
    const checked = this.options.schema.validateField(key, nextValue);
    if (!checked.ok) {
      this.statusBanner = { text: checked.error, tone: "error" };
      return;
    }

    const updated = {
      ...this.draftValues,
      [key]: checked.value,
    } as InferSettingsValues<TFields>;

    this.draftValues = updated;
    this.draftVersion++;
    this.statusBanner = undefined;

    const rows = this.buildRootRows();
    this.alignSelection(rows, key);

    if (this.saveMode === "immediate") {
      void this.persistDraft(updated, false);
    }
  }

  private async persistDraft(
    nextValues: InferSettingsValues<TFields>,
    closeAfterSave: boolean,
  ): Promise<void> {
    if (this.closed) return;
    if (this.isSaving) {
      if (this.saveMode === "immediate" && !closeAfterSave) {
        this.pendingImmediateSave = true;
      }
      return;
    }
    if (this.activeScope === "project" && !this.loadedState.trustedProject) {
      this.statusBanner = {
        text: "Cannot save to Project scope: project is untrusted.",
        tone: "error",
      };
      this.options.tui.requestRender();
      return;
    }

    this.isSaving = true;
    const versionAtSaveStart = this.draftVersion;
    try {
      const result = await this.options.store.save(nextValues, {
        scope: this.activeScope,
        trustedProject: this.loadedState.trustedProject,
        expectedSnapshot: this.loadedState.snapshot,
      });

      this.loadedState = result.loaded;
      this.baselineValues = cloneValue(result.loaded.effective);
      if (this.draftVersion === versionAtSaveStart) {
        this.draftValues = cloneValue(result.loaded.effective);
      }
      this.conflictError = false;
      this.statusBanner = undefined;

      if (this.saveMode === "immediate") {
        this.everSavedImmediate = true;
      }

      await this.options.onApply?.(cloneValue(result.loaded.effective), {
        scope: this.activeScope,
        provenance: result.loaded.provenance,
        writtenKeys: result.writtenKeys,
      });

      if (closeAfterSave) {
        this.finish({
          saved: true,
          values: cloneValue(result.loaded.effective),
          scope: this.activeScope,
          dirty: false,
          closedBy: "save",
        });
      } else {
        this.options.tui.requestRender();
      }
    } catch (error) {
      if (error instanceof ConcurrencyConflictError) {
        this.conflictError = true;
        this.statusBanner = {
          text: "Settings changed on disk. Press R or click Reload below to refresh.",
          tone: "error",
        };
      } else {
        this.statusBanner = {
          text: error instanceof Error ? error.message : String(error),
          tone: "error",
        };
      }
      this.options.tui.requestRender();
    } finally {
      this.isSaving = false;
      if (this.pendingImmediateSave) {
        this.pendingImmediateSave = false;
        if (!this.closed && !this.conflictError && this.saveMode === "immediate") {
          void this.persistDraft(this.draftValues, false);
        }
      }
    }
  }

  private async performRestoreDefaults(): Promise<void> {
    if (this.isSaving || this.closed) return;
    this.isSaving = true;
    try {
      const result = await this.options.store.restoreDefaults({
        scope: this.activeScope,
        trustedProject: this.loadedState.trustedProject,
        expectedSnapshot: this.loadedState.snapshot,
      });

      this.loadedState = result.loaded;
      this.baselineValues = cloneValue(result.loaded.effective);
      this.draftValues = cloneValue(result.loaded.effective);
      this.draftVersion++;
      this.pendingImmediateSave = false;
      this.conflictError = false;
      if (this.saveMode === "immediate") {
        this.everSavedImmediate = true;
      }
      this.statusBanner = {
        text: `Restored ${this.activeScope} defaults.`,
        tone: "success",
      };

      await this.options.onApply?.(cloneValue(result.loaded.effective), {
        scope: this.activeScope,
        provenance: result.loaded.provenance,
        writtenKeys: result.writtenKeys,
      });

      const rows = this.buildRootRows();
      this.alignSelection(rows);
      this.options.tui.requestRender();
    } catch (error) {
      if (error instanceof ConcurrencyConflictError) {
        this.conflictError = true;
        this.statusBanner = {
          text: "Settings changed on disk. Press R or click Reload below to refresh.",
          tone: "error",
        };
      } else {
        this.statusBanner = {
          text: error instanceof Error ? error.message : String(error),
          tone: "error",
        };
      }
      this.options.tui.requestRender();
    } finally {
      this.isSaving = false;
    }
  }

  private async reloadFromDisk(): Promise<void> {
    if (this.isSaving || this.closed) return;
    this.isSaving = true;
    try {
      const loaded = await this.options.store.load({
        trustedProject: this.loadedState.trustedProject,
      });
      this.loadedState = loaded;
      this.baselineValues = cloneValue(loaded.effective);
      this.draftValues = cloneValue(loaded.effective);
      this.draftVersion++;
      this.pendingImmediateSave = false;
      this.conflictError = false;
      this.statusBanner = {
        text: "Reloaded settings from disk.",
        tone: "info",
      };
      const rows = this.buildRootRows();
      this.alignSelection(rows);
      this.options.tui.requestRender();
    } catch (error) {
      this.statusBanner = {
        text: error instanceof Error ? error.message : String(error),
        tone: "error",
      };
      this.options.tui.requestRender();
    } finally {
      this.isSaving = false;
    }
  }
}
