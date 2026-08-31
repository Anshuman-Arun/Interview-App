import { z } from "zod";
import { PixelDimensionsSchema, VisionPreprocessingError } from "./types.js";
import type { PixelDimensions } from "./types.js";

const SAFE_INTEGER_SCHEMA = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const SAFE_NONNEGATIVE_INTEGER_SCHEMA = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SAFE_POSITIVE_INTEGER_SCHEMA = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const ImageRectSchema = z.object({
  x: SAFE_INTEGER_SCHEMA,
  y: SAFE_INTEGER_SCHEMA,
  width: SAFE_POSITIVE_INTEGER_SCHEMA,
  height: SAFE_POSITIVE_INTEGER_SCHEMA
}).strict();
export type ImageRect = z.infer<typeof ImageRectSchema>;

export interface RectCorners {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

function invalidRect(message: string): never {
  throw new VisionPreprocessingError("INVALID_RECTANGLE", message);
}

function safeAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) invalidRect(`${label} exceeds safe integer range`);
  return result;
}

export function validateImageRect(input: ImageRect): ImageRect {
  const parsed = ImageRectSchema.safeParse(input);
  if (!parsed.success) invalidRect("Rectangle coordinates must be safe integers with positive width and height");
  safeAdd(parsed.data.x, parsed.data.width, "Rectangle right edge");
  safeAdd(parsed.data.y, parsed.data.height, "Rectangle bottom edge");
  return Object.freeze(parsed.data);
}

export function imageBounds(dimensions: PixelDimensions): ImageRect {
  const parsed = PixelDimensionsSchema.parse(dimensions);
  return Object.freeze({ x: 0, y: 0, width: parsed.width, height: parsed.height });
}

export function normalizeRect(corners: RectCorners): ImageRect {
  const values = [corners.x1, corners.y1, corners.x2, corners.y2];
  if (!values.every(Number.isSafeInteger)) invalidRect("Rectangle corners must be safe integers");

  const x = Math.min(corners.x1, corners.x2);
  const y = Math.min(corners.y1, corners.y2);
  const width = Math.abs(corners.x2 - corners.x1);
  const height = Math.abs(corners.y2 - corners.y1);
  if (width === 0 || height === 0) invalidRect("Rectangle must have non-zero area");
  return validateImageRect({ x, y, width, height });
}

export function rectArea(rect: ImageRect): number {
  const safe = validateImageRect(rect);
  const area = safe.width * safe.height;
  if (!Number.isSafeInteger(area)) invalidRect("Rectangle area exceeds safe integer range");
  return area;
}

export function intersectRects(left: ImageRect, right: ImageRect): ImageRect | undefined {
  const a = validateImageRect(left);
  const b = validateImageRect(right);
  const leftEdge = Math.max(a.x, b.x);
  const topEdge = Math.max(a.y, b.y);
  const rightEdge = Math.min(safeAdd(a.x, a.width, "Rectangle edge"), safeAdd(b.x, b.width, "Rectangle edge"));
  const bottomEdge = Math.min(safeAdd(a.y, a.height, "Rectangle edge"), safeAdd(b.y, b.height, "Rectangle edge"));
  if (rightEdge <= leftEdge || bottomEdge <= topEdge) return undefined;
  return validateImageRect({
    x: leftEdge,
    y: topEdge,
    width: rightEdge - leftEdge,
    height: bottomEdge - topEdge
  });
}

export function rectsOverlap(left: ImageRect, right: ImageRect): boolean {
  return intersectRects(left, right) !== undefined;
}

export function unionRects(rectangles: readonly ImageRect[]): ImageRect | undefined {
  if (rectangles.length === 0) return undefined;
  const firstInput = rectangles[0];
  if (firstInput === undefined) return undefined;
  const first = validateImageRect(firstInput);
  let minX = first.x;
  let minY = first.y;
  let maxX = safeAdd(first.x, first.width, "Rectangle edge");
  let maxY = safeAdd(first.y, first.height, "Rectangle edge");

  for (let index = 1; index < rectangles.length; index += 1) {
    const input = rectangles[index];
    if (input === undefined) continue;
    const rect = validateImageRect(input);
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, safeAdd(rect.x, rect.width, "Rectangle edge"));
    maxY = Math.max(maxY, safeAdd(rect.y, rect.height, "Rectangle edge"));
  }

  return validateImageRect({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

export function clipRectToBounds(rect: ImageRect, bounds: ImageRect): ImageRect | undefined {
  return intersectRects(validateImageRect(rect), validateImageRect(bounds));
}

export function expandRect(
  rect: ImageRect,
  paddingPixels: number,
  bounds?: ImageRect
): ImageRect | undefined {
  const safe = validateImageRect(rect);
  const parsedPadding = SAFE_NONNEGATIVE_INTEGER_SCHEMA.safeParse(paddingPixels);
  if (!parsedPadding.success) invalidRect("Padding must be a nonnegative safe integer");
  const padding = parsedPadding.data;

  const x = safeAdd(safe.x, -padding, "Expanded rectangle edge");
  const y = safeAdd(safe.y, -padding, "Expanded rectangle edge");
  const doubledPadding = padding * 2;
  if (!Number.isSafeInteger(doubledPadding)) invalidRect("Padding exceeds safe integer range");
  const width = safeAdd(safe.width, doubledPadding, "Expanded rectangle width");
  const height = safeAdd(safe.height, doubledPadding, "Expanded rectangle height");
  const expanded = validateImageRect({ x, y, width, height });
  return bounds === undefined ? expanded : clipRectToBounds(expanded, bounds);
}

export function rectContains(outer: ImageRect, inner: ImageRect): boolean {
  const a = validateImageRect(outer);
  const b = validateImageRect(inner);
  return b.x >= a.x
    && b.y >= a.y
    && safeAdd(b.x, b.width, "Rectangle edge") <= safeAdd(a.x, a.width, "Rectangle edge")
    && safeAdd(b.y, b.height, "Rectangle edge") <= safeAdd(a.y, a.height, "Rectangle edge");
}

export function assertRectWithinImage(rect: ImageRect, dimensions: PixelDimensions): ImageRect {
  const safeRect = validateImageRect(rect);
  const bounds = imageBounds(dimensions);
  if (!rectContains(bounds, safeRect)) {
    throw new VisionPreprocessingError("OUT_OF_BOUNDS", "Image region extends outside source image bounds");
  }
  return safeRect;
}
