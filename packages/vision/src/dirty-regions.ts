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
  maxInputRegions: z.number().int().positive().max(10_000),
  maxRegionCount: z.number().int().positive().max(1_000),
  maxTotalAnalyzedArea: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
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
  let working = rectangles.map((rect) => validateImageRect(rect)).sort(compareRects);
  let merged = true;

  while (merged) {
    merged = false;
    outer: for (let leftIndex = 0; leftIndex < working.length; leftIndex += 1) {
      const left = working[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < working.length; rightIndex += 1) {
        const right = working[rightIndex];
        if (right === undefined || !rectsOverlap(left, right)) continue;
        const union = unionRects([left, right]);
        if (union === undefined) throw new Error("Union unexpectedly missing for two rectangles");
        working = working.filter((_, index) => index !== leftIndex && index !== rightIndex);
        working.push(union);
        working.sort(compareRects);
        merged = true;
        break outer;
      }
    }
  }

  return Object.freeze(working.map((rect) => Object.freeze({ ...rect })));
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
