import { Key, matchesKey, wrapTextWithAnsi, type KeybindingsManager, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fitToWidth, formatActionPill } from "../frame.js";
import { HitRegionTracker, renderPillRow } from "../hit-test.js";
import type { DialogRouteComponent } from "../types.js";

/** Configuration for `ConfirmRoute`. */
export interface ConfirmRouteOptions {
  readonly title?: string;
  readonly message: string;
  readonly detail?: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly defaultAction?: "confirm" | "cancel";
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly getMaxHeight?: () => number;
}

/** Confirmation sub-route with keyboard and mouse support. */
export class ConfirmRoute implements DialogRouteComponent {
  readonly title?: string;
  private readonly options: ConfirmRouteOptions;
  private readonly tracker = new HitRegionTracker();
  private selectedButton: "confirm" | "cancel";
  private _focused = false;

  constructor(options: ConfirmRouteOptions) {
    this.options = options;
    this.title = options.title;
    this.selectedButton = options.defaultAction ?? (options.destructive ? "cancel" : "confirm");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  invalidate(): void {
    // Stateless per-render output; nothing cached.
  }

  render(width: number): string[] {
    this.tracker.clear();
    const safeWidth = Math.max(8, width);
    const maxHeight = Math.max(3, this.options.getMaxHeight?.() ?? 16);
    const { theme } = this.options;

    const msgLines = wrapTextWithAnsi(this.options.message, safeWidth).map((l) =>
      fitToWidth(theme.fg("text", l), safeWidth),
    );
    const detailLines = this.options.detail
      ? wrapTextWithAnsi(this.options.detail, safeWidth).map((l) =>
          fitToWidth(theme.fg("muted", l), safeWidth),
        )
      : [];

    const reservedBottom = 2; // button row + hint row
    const maxTextLines = Math.max(1, maxHeight - reservedBottom - (maxHeight >= 5 ? 1 : 0));
    const textLines = [...msgLines, ...detailLines].slice(0, maxTextLines);

    const lines: string[] = [...textLines];
    if (lines.length + reservedBottom < maxHeight) {
      lines.push(fitToWidth("", safeWidth));
    }

    const buttonY = lines.length;
    const confirmText = formatActionPill(this.options.confirmLabel ?? "Confirm", theme, {
      highlighted: this.selectedButton === "confirm",
      tone: this.options.destructive ? "error" : "accent",
    });
    const cancelText = formatActionPill(this.options.cancelLabel ?? "Cancel", theme, {
      highlighted: this.selectedButton === "cancel",
      tone: "text",
    });

    const buttonRow = renderPillRow(
      [
        { kind: "button", id: "confirm", text: confirmText },
        { kind: "button", id: "cancel", text: cancelText },
      ],
      {
        tracker: this.tracker,
        y: buttonY,
        startX: 0,
        separator: "  ",
        maxWidth: safeWidth,
      },
    );
    lines.push(fitToWidth(buttonRow, safeWidth));

    if (lines.length < maxHeight) {
      lines.push(
        fitToWidth(
          theme.fg("dim", "y confirm · n cancel · ←/→ switch · Enter select · Esc back"),
          safeWidth,
        ),
      );
    }

    return lines.slice(0, maxHeight);
  }

  handleInput(data: string): void {
    const { keybindings, onConfirm, onCancel } = this.options;

    if (keybindings.matches(data, "tui.select.cancel") || matchesKey(data, Key.escape)) {
      onCancel();
      return;
    }
    if (data === "y" || data === "Y") {
      onConfirm();
      return;
    }
    if (data === "n" || data === "N") {
      onCancel();
      return;
    }
    if (
      matchesKey(data, Key.left) ||
      matchesKey(data, Key.right) ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, Key.shift("tab")) ||
      data === "h" ||
      data === "l"
    ) {
      this.selectedButton = this.selectedButton === "confirm" ? "cancel" : "confirm";
      return;
    }
    if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) {
      if (this.selectedButton === "confirm") {
        onConfirm();
      } else {
        onCancel();
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press" && event.button === "left") {
      const hit = this.tracker.hitTest(event.x, event.y);
      if (hit?.kind === "button" && (hit.id === "confirm" || hit.id === "cancel")) {
        this.selectedButton = hit.id;
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, render: false };
    }

    if (event.type === "click" && event.button === "left") {
      const hit = this.tracker.hitTest(event.x, event.y);
      if (hit?.kind === "button") {
        if (hit.id === "confirm") {
          this.options.onConfirm();
        } else if (hit.id === "cancel") {
          this.options.onCancel();
        }
        return { handled: true, focus: true, render: true };
      }
      return { handled: true, render: false };
    }

    return undefined;
  }
}
