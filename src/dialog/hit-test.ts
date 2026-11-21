import { visibleWidth } from "@earendil-works/pi-tui";
import type { HitRegion, HitRegionKind } from "./types.js";

/** Tracks 0-based overlay-local hit regions populated during each `render()`. */
export class HitRegionTracker {
  private regions: HitRegion[] = [];

  /** Clear all tracked regions at the start of a render pass. */
  clear(): void {
    this.regions = [];
  }

  /** Register a hit region (only added when `x1 > x0`). */
  add(region: HitRegion): void {
    if (region.x1 > region.x0) {
      this.regions.push(region);
    }
  }

  /** Find the topmost (last-registered) region containing `(x, y)`. */
  hitTest(x: number, y: number): HitRegion | undefined {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i]!;
      if (y === region.y && x >= region.x0 && x < region.x1) {
        return region;
      }
    }
    return undefined;
  }

  /** Snapshot all registered hit regions (useful for diagnostics and tests). */
  getRegions(): readonly HitRegion[] {
    return this.regions;
  }
}

/** Definition of a horizontal clickable pill/chip/button item. */
export interface PillItem {
  readonly kind: HitRegionKind;
  readonly id: string;
  readonly text: string;
  readonly index?: number;
  readonly data?: unknown;
}

/**
 * Join clickable pills with `separator`, returning the rendered string and
 * registering exact `[x0, x1)` hit spans on `tracker` when `y >= 0`.
 */
export function renderPillRow(
  items: readonly PillItem[],
  options: {
    readonly tracker: HitRegionTracker;
    readonly y: number;
    readonly startX: number;
    readonly separator?: string;
    readonly maxWidth?: number;
  },
): string {
  const separator = options.separator ?? " ";
  const sepWidth = visibleWidth(separator);
  let out = "";
  let cursorX = options.startX;
  let usedWidth = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const itemWidth = visibleWidth(item.text);
    const prefix = i > 0 ? separator : "";
    const prefixWidth = i > 0 ? sepWidth : 0;

    if (options.maxWidth !== undefined && usedWidth + prefixWidth + itemWidth > options.maxWidth) {
      break;
    }

    if (i > 0) {
      out += prefix;
      cursorX += prefixWidth;
      usedWidth += prefixWidth;
    }

    const x0 = cursorX;
    const x1 = cursorX + itemWidth;
    if (options.y >= 0) {
      options.tracker.add({
        y: options.y,
        x0,
        x1,
        kind: item.kind,
        id: item.id,
        index: item.index,
        data: item.data,
      });
    }

    out += item.text;
    cursorX = x1;
    usedWidth += itemWidth;
  }

  return out;
}
