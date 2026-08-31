import { z } from "zod";
import { boundedArrayLength } from "./array-validation.js";
import {
  MAX_GEOMETRY_RECTANGLES,
  clipRectToBounds,
  expandRect,
  imageBounds,
  rectArea,
  unionRects,
  validateImageRect,
  type ImageRect
} from "./geometry.js";
import { PixelDimensionsSchema, VisionPreprocessingError } from "./types.js";
import type { PixelDimensions } from "./types.js";

export const DirtyRegionInputSchema = z.object({
  x: z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  y: z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  width: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  height: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type DirtyRegionInput = z.infer<typeof DirtyRegionInputSchema>;

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

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRects(left: ImageRect, right: ImageRect): number {
  return compareNumber(left.y, right.y)
    || compareNumber(left.x, right.x)
    || compareNumber(left.height, right.height)
    || compareNumber(left.width, right.width);
}

function normalizeConfig(config: unknown) {
  if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
    throw new RangeError("Dirty-region planner configuration must be an object");
  }
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

export function rasterizeDirtyRegion(regionInput: DirtyRegionInput): ImageRect {
  const parsed = DirtyRegionInputSchema.safeParse(regionInput);
  if (!parsed.success) {
    throw new VisionPreprocessingError(
      "INVALID_RECTANGLE",
      "Dirty region coordinates must be finite with nonnegative dimensions"
    );
  }

  const rawRight = parsed.data.x + parsed.data.width;
  const rawBottom = parsed.data.y + parsed.data.height;
  if (!Number.isFinite(rawRight)
      || !Number.isFinite(rawBottom)
      || rawRight < Number.MIN_SAFE_INTEGER
      || rawRight > Number.MAX_SAFE_INTEGER
      || rawBottom < Number.MIN_SAFE_INTEGER
      || rawBottom > Number.MAX_SAFE_INTEGER) {
    throw new VisionPreprocessingError("INVALID_RECTANGLE", "Dirty region edges exceed safe numeric range");
  }

  const x = Math.floor(parsed.data.x);
  const y = Math.floor(parsed.data.y);
  const right = Math.max(x + 1, Math.ceil(rawRight));
  const bottom = Math.max(y + 1, Math.ceil(rawBottom));
  return validateImageRect({ x, y, width: right - x, height: bottom - y });
}

function validatedRectsOverlap(left: ImageRect, right: ImageRect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function coalesceOverlappingRegions(rectangles: readonly ImageRect[]): readonly ImageRect[] {
  const rectangleCount = boundedArrayLength(rectangles, MAX_GEOMETRY_RECTANGLES, "Rectangle collection");
  const input: ImageRect[] = [];
  for (let index = 0; index < rectangleCount; index += 1) {
    const rect = rectangles[index];
    if (rect === undefined) {
      throw new VisionPreprocessingError("INVALID_RECTANGLE", "Rectangle collection must not contain missing entries");
    }
    input.push(validateImageRect(rect));
  }
  input.sort(compareRects);
  const merged: ImageRect[] = [];

  for (const rect of input) {
    let candidate = rect;
    let index = 0;
    while (index < merged.length) {
      const existing = merged[index];
      if (existing === undefined || !validatedRectsOverlap(candidate, existing)) {
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
  dirtyRegions: readonly DirtyRegionInput[],
  dimensions: PixelDimensions,
  config?: DirtyRegionPlannerConfig
): DirtyRegionPlan {
  let dirtyRegionCount: number;
  try {
    dirtyRegionCount = boundedArrayLength(
      dirtyRegions,
      MAX_GEOMETRY_RECTANGLES,
      "Dirty-region input"
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new VisionPreprocessingError(
        "DIRTY_PLAN_EXCEEDS_BUDGET",
        "Dirty-region input exceeds the package hard region-count limit"
      );
    }
    throw new VisionPreprocessingError("INVALID_RECTANGLE", "Dirty-region input must be a bounded array");
  }

  const safeDimensions = PixelDimensionsSchema.parse(dimensions);
  const safeConfig = normalizeConfig(config);
  const frame = imageBounds(safeDimensions);

  if (dirtyRegionCount === 0) {
    const regions: readonly [] = Object.freeze([]);
    return Object.freeze({ mode: "NONE" as const, regions, analyzedArea: 0 as const });
  }

  let frameArea: number;
  try {
    frameArea = rectArea(frame);
  } catch {
    throw new VisionPreprocessingError(
      "DIRTY_PLAN_EXCEEDS_BUDGET",
      "Image frame area exceeds the planner's safe numeric range"
    );
  }

  const rasterRegions: ImageRect[] = [];
  for (let index = 0; index < dirtyRegionCount; index += 1) {
    const region = dirtyRegions[index];
    if (region === undefined) {
      throw new VisionPreprocessingError("INVALID_RECTANGLE", "Dirty-region list must not contain missing entries");
    }
    rasterRegions.push(rasterizeDirtyRegion(region));
  }
  const clippedRegions: ImageRect[] = [];
  for (const rawRegion of rasterRegions) {
    const clipped = clipRectToBounds(rawRegion, frame);
    if (clipped !== undefined) clippedRegions.push(clipped);
  }

  if (clippedRegions.length === 0) {
    const regions: readonly [] = Object.freeze([]);
    return Object.freeze({ mode: "NONE" as const, regions, analyzedArea: 0 as const });
  }
  if (clippedRegions.length > safeConfig.maxInputRegions) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "TOO_MANY_INPUTS");
  }

  const padded: ImageRect[] = [];
  for (const clipped of clippedRegions) {
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
    throw new VisionPreprocessingError(
      "DIRTY_PLAN_EXCEEDS_BUDGET",
      "Dirty-region analysis exceeds the configured total-area budget"
    );
  }

  if (analyzedArea / frameArea >= safeConfig.fullFrameFallbackAreaRatio) {
    return fullFrameFallback(frame, safeConfig.maxTotalAnalyzedArea, "AREA_FRAGMENTATION");
  }

  return Object.freeze({
    mode: "REGIONS" as const,
    regions,
    analyzedArea
  });
}
