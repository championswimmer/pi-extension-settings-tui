import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ValueTone } from "../schema/index.js";

/** List viewport window slice computed from total items, selection, and scroll offset. */
export interface ListWindow {
  readonly start: number;
  readonly end: number;
  readonly scrollOffset: number;
  readonly visibleSlots: number;
  readonly aboveCount: number;
  readonly belowCount: number;
}

/** Map schema `ValueTone` to a Pi `ThemeColor` token. */
export function toneToThemeColor(tone: ValueTone | undefined): ThemeColor {
  switch (tone) {
    case "accent":
      return "accent";
    case "warn":
      return "warning";
    case "error":
      return "error";
    case "success":
      return "success";
    case "muted":
      return "muted";
    case "default":
    default:
      return "text";
  }
}

/** Pad or truncate a styled line to an exact terminal column width. */
export function fitToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "…", true);
}

/** Compute horizontal padding inside a rounded box frame for a given total width. */
export function getFramePadding(width: number): number {
  return width >= 10 ? 1 : 0;
}

/** Compute usable inner content width inside a rounded box frame. */
export function getFrameInnerWidth(width: number): number {
  const pad = getFramePadding(width);
  return Math.max(1, width - 2 - pad * 2);
}

/** Render top rounded border: `╭───╮`. */
export function renderBoxTop(width: number, theme: Theme): string {
  if (width <= 2) return theme.fg("border", "─".repeat(Math.max(0, width)));
  return theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
}

/** Render bottom rounded border: `╰───╯`. */
export function renderBoxBottom(width: number, theme: Theme): string {
  if (width <= 2) return theme.fg("border", "─".repeat(Math.max(0, width)));
  return theme.fg("border", `╰${"─".repeat(width - 2)}╯`);
}

/** Render subtle horizontal divider: `├───┤`. */
export function renderBoxDivider(width: number, theme: Theme): string {
  if (width <= 2) return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
  return theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`);
}

/** Render a single framed content line padded to `width` with `│` borders. */
export function renderBoxLine(content: string, width: number, theme: Theme): string {
  if (width <= 2) {
    return truncateToWidth(content, Math.max(0, width), "", true);
  }
  const pad = getFramePadding(width);
  const innerWidth = getFrameInnerWidth(width);
  const padStr = pad > 0 ? " ".repeat(pad) : "";
  const body = fitToWidth(content, innerWidth);
  const left = theme.fg("border", "│");
  const right = theme.fg("border", "│");
  return `${left}${padStr}${body}${padStr}${right}`;
}

/** Style a clickable action pill with bracket framing. */
export function formatActionPill(
  label: string,
  theme: Theme,
  options?: { readonly highlighted?: boolean; readonly tone?: ThemeColor },
): string {
  const text = `[${label}]`;
  if (options?.highlighted) {
    const fg = options.tone ?? "accent";
    return theme.bg("selectedBg", theme.fg(fg, theme.bold(text)));
  }
  return theme.fg(options?.tone ?? "muted", text);
}

/**
 * Compute a visible `[start, end)` slice for a scrollable list within `maxRows`,
 * reserving up to 2 indicator rows (`↑ N more` / `↓ N more`) when overflowing.
 */
export function computeListWindow(
  totalItems: number,
  scrollOffset: number,
  maxRows: number,
): ListWindow {
  if (totalItems <= 0 || maxRows <= 0) {
    return {
      start: 0,
      end: 0,
      scrollOffset: 0,
      visibleSlots: 0,
      aboveCount: 0,
      belowCount: 0,
    };
  }

  if (totalItems <= maxRows) {
    return {
      start: 0,
      end: totalItems,
      scrollOffset: 0,
      visibleSlots: totalItems,
      aboveCount: 0,
      belowCount: 0,
    };
  }

  // Tight height budget: skip scroll indicators so at least 1-2 items stay visible.
  if (maxRows <= 2) {
    const clampedStart = Math.max(0, Math.min(scrollOffset, totalItems - maxRows));
    const end = Math.min(totalItems, clampedStart + maxRows);
    return {
      start: clampedStart,
      end,
      scrollOffset: clampedStart,
      visibleSlots: end - clampedStart,
      aboveCount: clampedStart,
      belowCount: Math.max(0, totalItems - end),
    };
  }

  let start = Math.max(0, Math.min(scrollOffset, totalItems - 1));
  // Iteratively settle indicator rows so `start..end` + indicators == `maxRows`.
  for (let pass = 0; pass < 3; pass++) {
    const hasAbove = start > 0;
    const tentativeSlots = Math.max(1, maxRows - (hasAbove ? 1 : 0));
    const tentativeEnd = Math.min(totalItems, start + tentativeSlots);
    const hasBelow = tentativeEnd < totalItems;
    const slots = Math.max(1, maxRows - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0));
    const maxStart = Math.max(0, totalItems - slots);
    if (start > maxStart) {
      start = maxStart;
    }
  }

  const hasAbove = start > 0;
  let slots = Math.max(1, maxRows - (hasAbove ? 1 : 0));
  let end = Math.min(totalItems, start + slots);
  if (end < totalItems) {
    slots = Math.max(1, maxRows - (hasAbove ? 1 : 0) - 1);
    end = Math.min(totalItems, start + slots);
  }

  return {
    start,
    end,
    scrollOffset: start,
    visibleSlots: end - start,
    aboveCount: start,
    belowCount: Math.max(0, totalItems - end),
  };
}

/** Adjust `scrollOffset` minimally so `index` is inside the visible window. */
export function ensureIndexInWindow(
  index: number,
  currentScrollOffset: number,
  totalItems: number,
  maxRows: number,
): number {
  if (totalItems <= 0 || maxRows <= 0 || totalItems <= maxRows) {
    return 0;
  }

  const clampedIndex = Math.max(0, Math.min(index, totalItems - 1));
  let offset = Math.max(0, Math.min(currentScrollOffset, totalItems - 1));

  const currentWindow = computeListWindow(totalItems, offset, maxRows);
  if (clampedIndex < currentWindow.start) {
    offset = clampedIndex;
  } else if (clampedIndex >= currentWindow.end) {
    // Estimate visible slots when scrolled down (accounting for up/down indicators).
    const reserveIndicators = maxRows > 2 ? (clampedIndex < totalItems - 1 ? 2 : 1) : 0;
    const slots = Math.max(1, maxRows - reserveIndicators);
    offset = Math.max(0, clampedIndex - slots + 1);
  }

  // Refine upward if indicator edge caused the index to fall just past `end`.
  for (let guard = 0; guard < 3; guard++) {
    const win = computeListWindow(totalItems, offset, maxRows);
    if (clampedIndex >= win.start && clampedIndex < win.end) {
      return win.scrollOffset;
    }
    if (clampedIndex < win.start) {
      offset = Math.max(0, offset - 1);
    } else {
      offset = Math.min(totalItems - 1, offset + 1);
    }
  }

  return offset;
}

/** Render a muted scroll indicator row (`↑ N more` or `↓ N more`). */
export function renderScrollIndicator(
  direction: "up" | "down",
  count: number,
  width: number,
  theme: Theme,
): string {
  const arrow = direction === "up" ? "↑" : "↓";
  return fitToWidth(theme.fg("muted", `  ${arrow} ${count} more`), width);
}

/** Align left and right segments on one line of `width` columns. */
export function joinLeftRight(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightW = visibleWidth(right);
  if (rightW >= width) {
    return fitToWidth(right, width);
  }
  const maxLeftW = Math.max(0, width - rightW - 1);
  const clippedLeft = truncateToWidth(left, maxLeftW, "…", false);
  const leftW = visibleWidth(clippedLeft);
  const gap = Math.max(1, width - leftW - rightW);
  return `${clippedLeft}${" ".repeat(gap)}${right}`;
}
