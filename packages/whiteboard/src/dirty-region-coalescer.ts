import {
  type BoundingBox,
  type StudentShape
} from "./shape-model.js";

export interface DirtyRegionConfig {
  readonly paddingRatio?: number; // default 0.20 (20% context expansion)
  readonly minDimension?: number; // minimum width/height in px
}

export function computeUnionBounds(boxes: readonly BoundingBox[]): BoundingBox | undefined {
  if (boxes.length === 0) return undefined;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const box of boxes) {
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY)
  };
}

export function expandBoundingBox(
  box: BoundingBox,
  paddingRatio = 0.20,
  minDimension = 20
): BoundingBox {
  const padX = Math.max(box.width * paddingRatio, minDimension / 2);
  const padY = Math.max(box.height * paddingRatio, minDimension / 2);

  const x = box.x - padX;
  const y = box.y - padY;
  const width = Math.max(minDimension, box.width + 2 * padX);
  const height = Math.max(minDimension, box.height + 2 * padY);

  return { x, y, width, height };
}

export function doBoxesIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export class DirtyRegionCoalescer {
  private dirtyBoxes: BoundingBox[] = [];
  private readonly paddingRatio: number;
  private readonly minDimension: number;

  public constructor(config?: DirtyRegionConfig) {
    this.paddingRatio = config?.paddingRatio ?? 0.20;
    this.minDimension = config?.minDimension ?? 20;
  }

  public recordDirtyBox(box: BoundingBox): void {
    this.dirtyBoxes.push(box);
  }

  public hasDirtyRegions(): boolean {
    return this.dirtyBoxes.length > 0;
  }

  public flushDirtyRegion(
    allShapes: readonly StudentShape[]
  ): { readonly bounds: BoundingBox; readonly relevantShapeIds: readonly string[] } | undefined {
    if (this.dirtyBoxes.length === 0) return undefined;

    const union = computeUnionBounds(this.dirtyBoxes);
    this.dirtyBoxes = [];
    if (union === undefined) return undefined;

    const expanded = expandBoundingBox(union, this.paddingRatio, this.minDimension);

    const relevantShapeIds = allShapes
      .filter((shape) => doBoxesIntersect(shape.bounds, expanded))
      .map((shape) => shape.id);

    return {
      bounds: expanded,
      relevantShapeIds
    };
  }

  public clear(): void {
    this.dirtyBoxes = [];
  }
}
