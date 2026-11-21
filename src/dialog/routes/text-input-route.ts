import {
  Editor,
  Input,
  Key,
  matchesKey,
  wrapTextWithAnsi,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fitToWidth, formatActionPill } from "../frame.js";
import { HitRegionTracker, renderPillRow } from "../hit-test.js";
import type { ChildBounds, DialogRouteComponent } from "../types.js";

/** Validation result accepted by `TextInputRoute`. */
export type TextInputValidationResult =
  | boolean
  | string
  | undefined
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly error: string };

/** Configuration for `TextInputRoute`. */
export interface TextInputRouteOptions {
  readonly title: string;
  readonly description?: string;
  readonly initialValue: string;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly validate?: (value: string) => TextInputValidationResult;
  readonly onSubmit: (value: string) => void;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

/** Single-line (`Input`) or multi-line (`Editor`) text entry sub-route with live validation. */
export class TextInputRoute implements DialogRouteComponent {
  readonly title: string;
  private readonly options: TextInputRouteOptions;
  private readonly input?: Input;
  private readonly editor?: Editor;
  private readonly tracker = new HitRegionTracker();
  private widgetBounds?: ChildBounds;
  private errorMessage: string | undefined;
  private _focused = false;

  constructor(options: TextInputRouteOptions) {
    this.options = options;
    this.title = options.title;

    if (options.multiline) {
      const editorTheme: EditorTheme = {
        borderColor: (text) => options.theme.fg("borderMuted", text),
        selectList: {
          selectedPrefix: (text) => options.theme.fg("accent", text),
          selectedText: (text) => options.theme.fg("accent", text),
          description: (text) => options.theme.fg("muted", text),
          scrollInfo: (text) => options.theme.fg("muted", text),
          noMatch: (text) => options.theme.fg("muted", text),
        },
      };
      this.editor = new Editor(options.tui, editorTheme, { paddingX: 0 });
      this.editor.disableSubmit = true;
      this.editor.setText(options.initialValue);
      this.editor.onChange = () => {
        this.runValidation();
      };
    } else {
      this.input = new Input({
        prompt: options.theme.fg("accent", "❯ "),
        placeholder: options.placeholder ?? "",
        placeholderStyle: (text) => options.theme.fg("dim", text),
      });
      this.input.setValue(options.initialValue);
      // Input.setValue clamps cursor to min(cursor, len); explicitly position at end.
      (this.input as unknown as { cursor: number }).cursor = options.initialValue.length;
    }

    this.runValidation();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.input) {
      this.input.focused = value;
    }
    if (this.editor) {
      this.editor.focused = value;
    }
  }

  invalidate(): void {
    this.input?.invalidate();
    this.editor?.invalidate();
  }

  private getCurrentValue(): string {
    if (this.editor) {
      return this.editor.getExpandedText();
    }
    return this.input?.getValue() ?? "";
  }

  private runValidation(): { ok: true; value: string } | { ok: false; error: string } {
    const raw = this.getCurrentValue();
    if (!this.options.validate) {
      this.errorMessage = undefined;
      return { ok: true, value: raw };
    }

    const result = this.options.validate(raw);
    if (result === true || result === undefined || result === "") {
      this.errorMessage = undefined;
      return { ok: true, value: raw };
    }
    if (result === false) {
      const error = "Invalid value";
      this.errorMessage = error;
      return { ok: false, error };
    }
    if (typeof result === "string") {
      this.errorMessage = result;
      return { ok: false, error: result };
    }
    if (result.ok) {
      this.errorMessage = undefined;
      return { ok: true, value: result.value ?? raw };
    }
    this.errorMessage = result.error;
    return { ok: false, error: result.error };
  }

  private tryCommit(): void {
    const checked = this.runValidation();
    if (!checked.ok) {
      return;
    }
    this.options.onSubmit(checked.value);
  }

  render(width: number): string[] {
    this.tracker.clear();
    this.widgetBounds = undefined;

    const safeWidth = Math.max(8, width);
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 18);
    const { theme } = this.options;

    const descLines = this.options.description
      ? wrapTextWithAnsi(this.options.description, safeWidth)
          .slice(0, maxHeight >= 8 ? 2 : 1)
          .map((l) => fitToWidth(theme.fg("muted", l), safeWidth))
      : [];

    const errorLines = this.errorMessage
      ? [fitToWidth(theme.fg("error", `⚠ ${this.errorMessage}`), safeWidth)]
      : [];

    const footerLinesCount = maxHeight >= 6 ? 2 : 1;
    const minWidgetLines = this.editor ? 3 : 1;
    const maxDescBudget = Math.max(0, maxHeight - minWidgetLines - errorLines.length - footerLinesCount);
    const clippedDesc = descLines.slice(0, maxDescBudget);

    const widgetBudget = Math.max(
      1,
      maxHeight - clippedDesc.length - errorLines.length - footerLinesCount,
    );

    const lines: string[] = [...clippedDesc];

    const rawWidgetLines = this.editor
      ? this.editor.render(safeWidth)
      : (this.input?.render(safeWidth) ?? [""]);
    const widgetLines = rawWidgetLines.slice(0, widgetBudget).map((l) => fitToWidth(l, safeWidth));

    const widgetStartY = lines.length;
    this.widgetBounds = {
      x: 0,
      y: widgetStartY,
      width: safeWidth,
      height: widgetLines.length,
    };
    this.tracker.add({
      y: widgetStartY,
      x0: 0,
      x1: safeWidth,
      kind: "input",
      id: "widget",
    });
    lines.push(...widgetLines);

    lines.push(...errorLines);

    if (lines.length < maxHeight) {
      const buttonY = lines.length;
      const applyLabel = this.editor ? "Ctrl+S Apply" : "Enter Apply";
      const applyPill = formatActionPill(applyLabel, theme, {
        highlighted: !this.errorMessage,
        tone: this.errorMessage ? "muted" : "accent",
      });
      const cancelPill = formatActionPill("Esc Cancel", theme, { tone: "muted" });
      const pillRow = renderPillRow(
        [
          { kind: "button", id: "apply", text: applyPill },
          { kind: "button", id: "cancel", text: cancelPill },
        ],
        {
          tracker: this.tracker,
          y: buttonY,
          startX: 0,
          separator: "  ",
          maxWidth: safeWidth,
        },
      );
      lines.push(fitToWidth(pillRow, safeWidth));
    }

    if (lines.length < maxHeight) {
      const hint = this.editor
        ? "Enter newline · Ctrl+S apply · Esc cancel"
        : "Enter apply · Esc cancel";
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

    if (this.editor) {
      if (matchesKey(data, Key.ctrl("s"))) {
        this.tryCommit();
        return;
      }
      if (matchesKey(data, Key.enter) || data === "\r") {
        // Because disableSubmit=true causes Editor to ignore Enter, insert newline explicitly.
        this.editor.insertTextAtCursor("\n");
        this.runValidation();
        return;
      }
      this.editor.handleInput(data);
      this.runValidation();
      return;
    }

    if (
      keybindings.matches(data, "tui.input.submit") ||
      matchesKey(data, Key.enter) ||
      data === "\n"
    ) {
      this.tryCommit();
      return;
    }

    this.input?.handleInput(data);
    this.runValidation();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const hit = this.tracker.hitTest(event.x, event.y);

    if (event.type === "press" && event.button === "left") {
      if (hit?.kind === "button") {
        return { handled: true, focus: true, render: false };
      }
      if (this.widgetBounds && this.isInsideBounds(event, this.widgetBounds)) {
        const forwarded = this.forwardMouseToWidget(event, this.widgetBounds);
        // Editor intentionally returns undefined on press so TuiAltScreen would select text;
        // inside an overlay sub-route we claim press so AltScreen synthesizes click.
        return forwarded ? { ...forwarded, handled: true, focus: true } : { handled: true, focus: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      if (hit?.kind === "button") {
        if (hit.id === "apply") {
          this.tryCommit();
        } else if (hit.id === "cancel") {
          this.options.onCancel();
        }
        return { handled: true, focus: true, render: true };
      }
      if (this.widgetBounds && this.isInsideBounds(event, this.widgetBounds)) {
        const forwarded = this.forwardMouseToWidget(event, this.widgetBounds);
        return forwarded ? { ...forwarded, handled: true, focus: true } : { handled: true, focus: true, render: false };
      }
      return { handled: true, render: false };
    }

    if (event.type === "wheel" && this.widgetBounds && this.isInsideBounds(event, this.widgetBounds)) {
      return this.forwardMouseToWidget(event, this.widgetBounds) ?? { handled: true, render: false };
    }

    return undefined;
  }

  private isInsideBounds(event: TuiMouseEvent, bounds: ChildBounds): boolean {
    return (
      event.x >= bounds.x &&
      event.x < bounds.x + bounds.width &&
      event.y >= bounds.y &&
      event.y < bounds.y + bounds.height
    );
  }

  private forwardMouseToWidget(
    event: TuiMouseEvent,
    bounds: ChildBounds,
  ): TuiMouseEventResult | undefined {
    const localEvent: TuiMouseEvent = {
      ...event,
      x: event.x - bounds.x,
      y: event.y - bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
    if (this.editor) {
      return this.editor.handleMouse(localEvent);
    }
    return this.input?.handleMouse(localEvent);
  }
}
