import {
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
import { stripControlChars } from "../../schema/index.js";
import {
  computeListWindow,
  fitToWidth,
  formatActionPill,
  joinLeftRight,
  renderScrollIndicator,
} from "../frame.js";
import { HitRegionTracker, renderPillRow, type PillItem } from "../hit-test.js";
import type { DialogRouteComponent } from "../types.js";

/** Configuration for `TextViewerRoute`. */
export interface TextViewerRouteOptions {
  readonly title: string;
  readonly description?: string;
  readonly format?: "markdown" | "plain";
  readonly content: string | ((signal: AbortSignal) => string | Promise<string>);
  readonly refreshable?: boolean;
  readonly tui?: { requestRender(): void };
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

function findClosingInlineDelimiter(
  text: string,
  start: number,
  delimiter: string,
  requireWordBoundary: boolean,
): number {
  const dLen = delimiter.length;
  for (let i = start; i <= text.length - dLen; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text.startsWith(delimiter, i)) {
      if (i === start) continue;
      if (/\s/.test(text[i - 1]!)) continue;
      if (delimiter === "*" && text.startsWith("**", i)) continue;
      if (requireWordBoundary && isWordChar(text[i + dLen])) continue;
      return i;
    }
  }
  return -1;
}

function formatInlineMarkdown(text: string, theme: Theme, allowLinks = true): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    // Escaped punctuation
    if (ch === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!]/.test(text[i + 1]!)) {
      out += text[i + 1]!;
      i += 2;
      continue;
    }

    // Inline code: `code`
    if (ch === "`") {
      const closeIdx = text.indexOf("`", i + 1);
      if (closeIdx > i + 1) {
        const code = text.slice(i + 1, closeIdx);
        out += theme.fg("accent", code);
        i = closeIdx + 1;
        continue;
      }
    }

    // Links: [label](url)
    if (allowLinks && ch === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (closeBracket > i + 1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 2) {
          const label = text.slice(i + 1, closeBracket);
          const url = text.slice(closeBracket + 2, closeParen).trim();
          const styledLabel = theme.fg("accent", formatInlineMarkdown(label, theme, false));
          out += url ? `${styledLabel} ${theme.fg("dim", `(${url})`)}` : styledLabel;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Bold: **text**
    if (text.startsWith("**", i) && i + 2 < text.length && !/\s/.test(text[i + 2]!)) {
      const closeIdx = findClosingInlineDelimiter(text, i + 2, "**", false);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 2, closeIdx);
        out += theme.bold(formatInlineMarkdown(inner, theme, allowLinks));
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text*
    if (ch === "*" && text[i + 1] !== "*" && i + 1 < text.length && !/\s/.test(text[i + 1]!)) {
      const closeIdx = findClosingInlineDelimiter(text, i + 1, "*", false);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 1, closeIdx);
        out += theme.fg("muted", formatInlineMarkdown(inner, theme, allowLinks));
        i = closeIdx + 1;
        continue;
      }
    }

    // Italic: _text_ (word-bounded so snake_case is preserved)
    if (
      ch === "_" &&
      text[i + 1] !== "_" &&
      !isWordChar(text[i - 1]) &&
      i + 1 < text.length &&
      !/\s/.test(text[i + 1]!)
    ) {
      const closeIdx = findClosingInlineDelimiter(text, i + 1, "_", true);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 1, closeIdx);
        out += theme.fg("muted", formatInlineMarkdown(inner, theme, allowLinks));
        i = closeIdx + 1;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function normalizeTextInput(raw: string): string {
  const normalizedNewlines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return stripControlChars(normalizedNewlines, true).replace(/\t/g, "  ");
}

function clampLineWidth(line: string, width: number): string {
  return truncateToWidth(line, width, "", false);
}

/** Render sanitized Markdown into ANSI-styled terminal lines wrapped to `width`. */
export function renderMarkdownToAnsi(markdown: string, width: number, theme: Theme): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const clean = normalizeTextInput(markdown);
  if (clean.length === 0) {
    return [];
  }

  const rawLines = clean.split("\n");
  const out: string[] = [];

  let inCodeBlock = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const rawLine of rawLines) {
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!inCodeBlock && fenceMatch) {
      inCodeBlock = true;
      fenceChar = fenceMatch[1]![0]!;
      fenceLen = fenceMatch[1]!.length;
      continue;
    }

    if (inCodeBlock) {
      const trimmed = rawLine.trim();
      if (
        trimmed.length >= fenceLen &&
        [...trimmed].every((c) => c === fenceChar)
      ) {
        inCodeBlock = false;
        fenceChar = "";
        fenceLen = 0;
        continue;
      }

      if (rawLine.length === 0) {
        out.push("");
        continue;
      }

      const codeWrapWidth = Math.max(1, safeWidth - 2);
      const wrapped = wrapTextWithAnsi(rawLine, codeWrapWidth);
      for (const segment of wrapped) {
        out.push(clampLineWidth(`  ${theme.fg("muted", segment)}`, safeWidth));
      }
      continue;
    }

    if (rawLine.trim().length === 0) {
      out.push("");
      continue;
    }

    // Horizontal rule
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(rawLine)) {
      out.push(clampLineWidth(theme.fg("borderMuted", "─".repeat(Math.min(safeWidth, 40))), safeWidth));
      continue;
    }

    // Headings (#, ##, ###, ...)
    const headingMatch = rawLine.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const headingContent = formatInlineMarkdown(headingMatch[2]!.trim(), theme);
      const color = level <= 2 ? "accent" : "text";
      const wrapped = wrapTextWithAnsi(headingContent, safeWidth);
      for (const segment of wrapped) {
        out.push(clampLineWidth(theme.fg(color, theme.bold(segment)), safeWidth));
      }
      continue;
    }

    // Blockquotes (> ...)
    const quoteMatch = rawLine.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      const quoteContent = formatInlineMarkdown(quoteMatch[1]!, theme);
      if (safeWidth <= 2) {
        out.push(clampLineWidth(theme.fg("muted", quoteContent), safeWidth));
        continue;
      }
      const wrapped = wrapTextWithAnsi(quoteContent, Math.max(1, safeWidth - 2));
      if (wrapped.length === 0) {
        out.push(clampLineWidth(theme.fg("borderMuted", "│ "), safeWidth));
      } else {
        for (const segment of wrapped) {
          const border = theme.fg("borderMuted", "│ ");
          const body = theme.fg("muted", segment);
          out.push(clampLineWidth(`${border}${body}`, safeWidth));
        }
      }
      continue;
    }

    // Unordered lists (- , * , + )
    const ulMatch = rawLine.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ulMatch) {
      const indentSpaces = Math.min(
        Math.floor(ulMatch[1]!.length / 2) * 2,
        Math.max(0, safeWidth - 6),
      );
      const prefixPlainWidth = indentSpaces + 2;
      const bodyWidth = Math.max(1, safeWidth - prefixPlainWidth);
      const formatted = formatInlineMarkdown(ulMatch[2]!, theme);
      const wrapped = wrapTextWithAnsi(formatted, bodyWidth);
      const bulletPrefix = `${" ".repeat(indentSpaces)}${theme.fg("accent", "•")} `;
      const contPrefix = " ".repeat(prefixPlainWidth);
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? bulletPrefix : contPrefix;
        out.push(clampLineWidth(`${prefix}${wrapped[i]!}`, safeWidth));
      }
      continue;
    }

    // Ordered lists (1. )
    const olMatch = rawLine.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (olMatch) {
      const num = olMatch[2]!;
      const indentSpaces = Math.min(
        Math.floor(olMatch[1]!.length / 2) * 2,
        Math.max(0, safeWidth - 8),
      );
      const prefixPlainWidth = indentSpaces + num.length + 2;
      const bodyWidth = Math.max(1, safeWidth - prefixPlainWidth);
      const formatted = formatInlineMarkdown(olMatch[3]!, theme);
      const wrapped = wrapTextWithAnsi(formatted, bodyWidth);
      const numPrefix = `${" ".repeat(indentSpaces)}${theme.fg("accent", `${num}.`)} `;
      const contPrefix = " ".repeat(prefixPlainWidth);
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? numPrefix : contPrefix;
        out.push(clampLineWidth(`${prefix}${wrapped[i]!}`, safeWidth));
      }
      continue;
    }

    // Paragraph line
    const formatted = formatInlineMarkdown(rawLine, theme);
    const wrapped = wrapTextWithAnsi(formatted, safeWidth);
    for (const segment of wrapped) {
      out.push(clampLineWidth(theme.fg("text", segment), safeWidth));
    }
  }

  return out;
}

function renderPlainTextToAnsi(text: string, width: number, theme: Theme): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  const clean = normalizeTextInput(text);
  if (clean.length === 0) {
    return [];
  }
  const rawLines = clean.split("\n");
  const out: string[] = [];
  for (const rawLine of rawLines) {
    if (rawLine.length === 0) {
      out.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(rawLine, safeWidth);
    for (const segment of wrapped) {
      out.push(clampLineWidth(theme.fg("text", segment), safeWidth));
    }
  }
  return out;
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Scrollable read-only viewer sub-route for static or async-loaded Markdown and plain text.
 */
export class TextViewerRoute implements DialogRouteComponent {
  readonly title: string;
  private readonly options: TextViewerRouteOptions;
  private readonly tracker = new HitRegionTracker();

  private rawContent = "";
  private loading = false;
  private errorMessage: string | undefined;
  private loadAbortController: AbortController | undefined;
  private loadSeq = 0;
  private disposed = false;

  private scrollOffset = 0;
  private lastBodyMaxRows = 10;
  private lastWidth = 80;
  private cachedWidth: number | undefined;
  private cachedContentKey: string | undefined;
  private cachedLines: string[] = [];
  private _focused = false;

  constructor(options: TextViewerRouteOptions) {
    this.options = options;
    this.title = options.title;

    if (typeof options.content === "string") {
      this.rawContent = options.content;
    } else {
      this.startLoad();
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedContentKey = undefined;
    this.cachedLines = [];
  }

  dispose(): void {
    this.disposed = true;
    this.loadAbortController?.abort();
    this.loadAbortController = undefined;
  }

  private isRefreshable(): boolean {
    return this.options.refreshable !== false && typeof this.options.content === "function";
  }

  private startLoad(): void {
    if (this.disposed || typeof this.options.content !== "function") {
      return;
    }

    this.loadAbortController?.abort();
    const controller = new AbortController();
    this.loadAbortController = controller;
    const seq = ++this.loadSeq;

    this.loading = true;
    this.errorMessage = undefined;
    this.invalidate();

    let result: string | Promise<string>;
    try {
      result = this.options.content(controller.signal);
    } catch (err) {
      if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
        return;
      }
      this.loading = false;
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.invalidate();
      return;
    }

    if (!isPromiseLike<string>(result)) {
      if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
        return;
      }
      this.rawContent = typeof result === "string" ? result : String(result ?? "");
      this.loading = false;
      this.errorMessage = undefined;
      this.scrollOffset = 0;
      this.invalidate();
      return;
    }

    Promise.resolve(result).then(
      (text) => {
        if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
          return;
        }
        this.rawContent = typeof text === "string" ? text : String(text ?? "");
        this.loading = false;
        this.errorMessage = undefined;
        this.scrollOffset = 0;
        this.invalidate();
        this.options.tui?.requestRender();
      },
      (err: unknown) => {
        if (this.disposed || controller.signal.aborted || seq !== this.loadSeq) {
          return;
        }
        this.loading = false;
        this.errorMessage = err instanceof Error ? err.message : String(err);
        this.invalidate();
        this.options.tui?.requestRender();
      },
    );
  }

  private getRenderedLines(safeWidth: number): string[] {
    const format = this.options.format ?? "markdown";
    const key = `${format}:${this.rawContent}`;
    if (this.cachedWidth === safeWidth && this.cachedContentKey === key) {
      return this.cachedLines;
    }

    const rendered =
      format === "plain"
        ? renderPlainTextToAnsi(this.rawContent, safeWidth, this.options.theme)
        : renderMarkdownToAnsi(this.rawContent, safeWidth, this.options.theme);

    this.cachedWidth = safeWidth;
    this.cachedContentKey = key;
    this.cachedLines =
      rendered.length > 0 ? rendered : [fitToWidth(this.options.theme.fg("muted", "(Empty)"), safeWidth)];
    return this.cachedLines;
  }

  private scrollBy(delta: number): void {
    if (this.loading || this.errorMessage !== undefined) {
      return;
    }
    const total = this.getRenderedLines(this.lastWidth).length;
    if (total === 0) {
      this.scrollOffset = 0;
      return;
    }
    const maxStart = computeListWindow(total, total - 1, this.lastBodyMaxRows).scrollOffset;
    const next = Math.max(0, Math.min(maxStart, this.scrollOffset + delta));
    this.scrollOffset = next;
  }

  render(width: number): string[] {
    this.tracker.clear();
    const safeWidth = Math.max(8, width);
    this.lastWidth = safeWidth;
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 18);
    const { theme } = this.options;

    const descLines =
      this.options.description && maxHeight >= 8
        ? wrapTextWithAnsi(this.options.description, safeWidth)
            .slice(0, 1)
            .map((l) => fitToWidth(theme.fg("muted", l), safeWidth))
        : [];

    const footerLinesCount = maxHeight >= 6 ? 2 : maxHeight >= 4 ? 1 : 0;
    const bodyBudget = Math.max(1, maxHeight - descLines.length - footerLinesCount);
    this.lastBodyMaxRows = bodyBudget;

    const lines: string[] = [...descLines];
    let positionLabel = "";

    if (this.loading) {
      lines.push(fitToWidth(theme.fg("muted", "  Loading…"), safeWidth));
    } else if (this.errorMessage !== undefined) {
      const errLines = wrapTextWithAnsi(`⚠ ${this.errorMessage}`, safeWidth)
        .slice(0, bodyBudget)
        .map((l) => fitToWidth(theme.fg("error", l), safeWidth));
      lines.push(...errLines);
    } else {
      const contentLines = this.getRenderedLines(safeWidth);
      const win = computeListWindow(contentLines.length, this.scrollOffset, bodyBudget);
      this.scrollOffset = win.scrollOffset;

      if (win.aboveCount > 0) {
        lines.push(renderScrollIndicator("up", win.aboveCount, safeWidth, theme));
      }

      for (let i = win.start; i < win.end; i++) {
        lines.push(fitToWidth(contentLines[i]!, safeWidth));
      }

      if (win.belowCount > 0) {
        lines.push(renderScrollIndicator("down", win.belowCount, safeWidth, theme));
      }

      if (contentLines.length > 0) {
        positionLabel = theme.fg("dim", `${win.start + 1}-${win.end}/${contentLines.length}`);
      }
    }

    // Keep footer anchored below body (or immediately after content if tight)
    while (lines.length + footerLinesCount < maxHeight && lines.length < descLines.length + bodyBudget) {
      lines.push("");
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
        text: formatActionPill("Esc Back", theme, { tone: "muted" }),
      });

      const posW = positionLabel ? visibleWidth(positionLabel) : 0;
      const pillMaxW = posW > 0 ? Math.max(8, safeWidth - posW - 2) : safeWidth;
      const pillRow = renderPillRow(pills, {
        tracker: this.tracker,
        y: pillY,
        startX: 0,
        separator: "  ",
        maxWidth: pillMaxW,
      });
      const row = posW > 0 ? joinLeftRight(pillRow, positionLabel, safeWidth) : pillRow;
      lines.push(fitToWidth(row, safeWidth));
    }

    if (footerLinesCount >= 2 && lines.length < maxHeight) {
      const hint = this.isRefreshable()
        ? "↑/↓ scroll · PgUp/PgDn page · Home/End · Ctrl+R refresh · Esc back"
        : "↑/↓ scroll · PgUp/PgDn page · Home/End · Esc back";
      lines.push(fitToWidth(theme.fg("dim", hint), safeWidth));
    }

    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    const { keybindings, onCancel } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      onCancel();
      return;
    }

    if (
      this.isRefreshable() &&
      (matchesKey(data, Key.ctrl("r")) ||
        keybindings.matches(data, "tui.select.confirm") ||
        matchesKey(data, Key.enter))
    ) {
      this.startLoad();
      this.options.tui?.requestRender();
      return;
    }

    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      this.scrollBy(-1);
      return;
    }

    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      this.scrollBy(1);
      return;
    }

    const pageStep = Math.max(1, this.lastBodyMaxRows - 2);
    if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) {
      this.scrollBy(-pageStep);
      return;
    }

    if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) {
      this.scrollBy(pageStep);
      return;
    }

    if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      return;
    }

    if (matchesKey(data, Key.end)) {
      if (this.loading || this.errorMessage !== undefined) {
        return;
      }
      const total = this.getRenderedLines(this.lastWidth).length;
      this.scrollOffset =
        total > 0 ? computeListWindow(total, total - 1, this.lastBodyMaxRows).scrollOffset : 0;
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      const delta = Math.trunc(event.wheelDelta ?? 0);
      if (delta !== 0) {
        this.scrollBy(delta);
      }
      return { handled: true, render: true };
    }

    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "action") {
        return { handled: true, focus: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "action") {
        if (hit.id === "refresh" && this.isRefreshable()) {
          this.startLoad();
          return { handled: true, focus: true, render: true };
        }
        if (hit.id === "cancel") {
          this.options.onCancel();
          return { handled: true, focus: true, render: true };
        }
      }
      return { handled: true, render: false };
    }

    return undefined;
  }
}
