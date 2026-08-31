import { z } from "zod";
import {
  clipRectToBounds,
  expandRect,
  imageBounds,
  rectArea,
  rectsOverlap,
  unionRects,
  validateImageRect,
  type ImageRect
} from "./geometry.js";
import { PixelDimensionsSchema, VisionPreprocessingError } from "./types.js";
import type { PixelDimensions } from "./types.js";

const DirtyRegionConfigSchema = z.object({
  paddingPixels: z.number().int().nonnegative().max(100_000),
  maxInputRegions: z.number().int().positive().max(2048),
  maxRegionCount: z.number().int().positive().max(256),
  maxTotalAnalyzedArea: z.number().int().positive().max(128 * 1024 * 1024),
  fullFrameFallbackAreaRatio: z.number().finite().positive().max(1)
}).strict();

export interface DirtyRegionPlannerConfig {
  readonly paddingPixels?: number;
  readonly maxInputRegions?: number;
  readonly maxRegionCount?: number;
  readonly maxTotalAnalyzedArea?: number;
  readonly fullFrameFallbackAreaRatio?: number;
}

export const DEFAULT_DIRTY_REGION_PLANNER_CONFIG = Object.freeze({
  paddingPixels: 24,
  maxInputRegions: 1024,
  maxRegionCount: 8,
  maxTotalAnalyzedArea: 16 * 1024 * 1024,
  fullFrameFallbackAreaRatio: 0.65
});

type DirtyRegionFallbackReason = "TOO_MANY_INPUTS" | "TOO_MANY_REGIONS" | "AREA_FRAGMENTATION";

export type DirtyRegionPlan =
  | {
      readonly mode: "NONE";
      readonly regions: readonly [];
      readonly analyzedArea: 0;
    }
  | {
      readonly mode: "REGIONS";
      readonly regions: readonly ImageRect[];
      readonly analyzedArea: number;
    }
  | {
      readonly mode: "FULL_FRAME";
      readonly regions: readonly [ImageRect];
      readonly analyzedArea: number;
      readonly fallbackReason: DirtyRegionFallbackReason;
    };

function compareRects(left: ImageRect, right: ImageRect): number {
  return left.y - right.y || left.x - right.x || left.height - right.height || left.width - right.width;
}

function normalizeConfig(config: DirtyRegionPlannerConfig | undefined) {
  const parsed = DirtyRegionConfigSchema.parse({
    ...DEFAULT_DIRTY_REGION_PLANNER_CONFIG,
    ...config
  });
  if (parsed.maxRegionCount > parsed.maxInputRegions) {
    throw new RangeError("maxRegionCount cannot exceed maxInputRegions");
  }
  return parsed;
}

function fullFrameFallback(
  frame: ImageRect,
  maximumArea: number,
  reason: DirtyRegionFallbackReason
): DirtyRegionPlan {
  const area = rectArea(frame);
  if (area > maximumArea) {
    throw new VisionPreprocessingError(
      "DIRTY_PLAN_EXCEEDS_BUDGET",
      "Dirty-region fragmentation requires full-frame analysis, but the full frame exceeds the configured area budget"
    );
  }
  const regions: readonly [ImageRect] = Object.freeze([frame]);
  return Object.freeze({
    mode: "FULL_FRAME" as const,
    regions,
    analyzedArea: area,
    fallbackReason: reason
  });
}

export function coalesceOverlappingRegions(rectangles: readonly ImageRect[]): readonly ImageRect[] {
  if (rectangles.length > 2048) throw new RangeError("At most 2048 regions may be coalesced at once");
  const input = rectangles.map((rect) => validateImageRect(rect)).sort(compareRects);
  const merged: ImageRect[] = [];

  for (const rect of input) {
    let candidate = rect;
    let index = 0;
    while (index < merged.length) {
      const existing = merged[index];
      if (existing === undefined || !rectsOverlap(candidate, existing)) {
        index += 1;
        continue;
      }
      const union = unionRects([candidate, existing]);
      if (union === undefined) throw new Error("Union unexpectedly missing for overlapping rectangles");
      candidate = union;
      merged.splice(index, 1);
      index = 0;
    }
    merged.push(candidate);
  }

  merged.sort(compareRects);
  return Object.freeze(merged.map((rect) => Object.freeze({ ...rect })));
}

export function planDirtyRegions(
  dirtyRegions: readonly ImageRect[],
  dimensions: PixelDimensions,
  config?: DirtyRegionPlannerConfig
): DirtyRegionPlan {
  const safeDimensions = PixelDimensionsSchema.parse(dimensions);
  const safeConfig = normalizeConfig(config);
  const frame = imageBounds(safeDimensions);

  if (dirtyRegions.length === 0) {
    const regions: readonly [] = Object.freeze([]);
    return Object.freeze({ mode: "NONE" as const, regions, analyzedArea: 0 as const });
  }

  if (dirtyRegions.length > safeConfig.maxInputRegions) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "TOO_MANY_INPUTS");
  }

  const padded: ImageRect[] = [];
  for (const rawRegion of dirtyRegions) {
    const clipped = clipRectToBounds(validateImageRect(rawRegion), frame);
    if (clipped === undefined) continue;
    const expanded = expandRect(clipped, safeConfig.paddingPixels, frame);
    if (expanded !== undefined) padded.push(expanded);
  }

  if (padded.length === 0) {
    const regions: readonly [] = Object.freeze([]);
    return Object.freeze({ mode: "NONE" as const, regions, analyzedArea: 0 as const });
  }

  const regions = coalesceOverlappingRegions(padded);
  if (regions.length > safeConfig.maxRegionCount) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "TOO_MANY_REGIONS");
  }

  let analyzedArea = 0;
  for (const region of regions) {
    analyzedArea += rectArea(region);
    if (!Number.isSafeInteger(analyzedArea)) {
      throw new VisionPreprocessingError("DIRTY_PLAN_EXCEEDS_BUDGET", "Dirty-region area exceeds safe integer range");
    }
  }

  if (analyzedArea > safeConfig.maxTotalAnalyzedArea) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "AREA_FRAGMENTATION");
  }

  const frameArea = rectArea(frame);
  if (analyzedArea / frameArea >= safeConfig.fullFrameFallbackAreaRatio
      && frameArea <= safeConfig.maxTotalAnalyzedArea) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "AREA_FRAGMENTATION");
  }

  return Object.freeze({
    mode: "REGIONS" as const,
    regions,
    analyzedArea
  });
}
