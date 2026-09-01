import type { StudentShape, StudentShapeType } from "../../../../packages/whiteboard/src/index.js";
import type { TLShapeBounds, TLShapeRecord } from "../tldraw-whiteboard-adapter.js";

export type NormalizedStudentMutationSource = "ADAPTER" | "EDITOR";

export interface NormalizedStudentShapeChange {
  /**
   * The real-editor bridge reports mutation provenance only. BoardRevision is
   * owned by TldrawWhiteboardAdapter and is intentionally not synthesized here.
   */
  readonly source: NormalizedStudentMutationSource;
  readonly added: readonly StudentShape[];
  readonly updated: readonly {
    readonly before: StudentShape;
    readonly after: StudentShape;
  }[];
  readonly deleted: readonly StudentShape[];
}

export function isStudentOwnedShape(shape: TLShapeRecord): boolean {
  const layer = shape.meta?.["layer"];
  return layer === "STUDENT" || layer === undefined;
}

export function normalizeStudentShape(
  shape: TLShapeRecord,
  bounds: TLShapeBounds,
  now: number = Date.now()
): StudentShape | null {
  if (!isStudentOwnedShape(shape)) return null;

  const type = normalizeShapeType(shape);
  if (type === null) return null;

  const createdAt = timestampFromMeta(shape.meta?.["createdAt"], now);
  const lastModifiedAt = timestampFromMeta(shape.meta?.["lastModifiedAt"], createdAt);
  const revision = revisionFromMeta(shape.meta?.["shapeRevision"]);
  const text = typeof shape.props?.["text"] === "string" ? shape.props["text"] : undefined;
  const points = normalizePoints(shape);
  const normalizedBounds = validateBounds(bounds);

  return {
    id: shape.id,
    type,
    bounds: normalizedBounds,
    ...(points !== undefined ? { points } : {}),
    ...(text !== undefined ? { text } : {}),
    revision,
    createdAt,
    lastModifiedAt
  };
}

function validateBounds(bounds: TLShapeBounds): StudentShape["bounds"] {
  for (const [name, value] of [
    ["x", bounds.x],
    ["y", bounds.y],
    ["width", bounds.width],
    ["height", bounds.height]
  ] as const) {
    if (!Number.isFinite(value)) {
      throw new Error(`Student shape has non-finite ${name} bounds`);
    }
  }
  if (bounds.width < 0 || bounds.height < 0) {
    throw new Error("Student shape bounds dimensions must be non-negative");
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  };
}

function normalizeShapeType(shape: TLShapeRecord): StudentShapeType | null {
  if (shape.meta?.["isEquation"] === true) return "formula";

  switch (shape.type) {
    case "draw":
    case "highlight":
    case "line":
      return "stroke";
    case "text":
    case "note":
      return "text";
    case "arrow":
      return "arrow";
    case "geo": {
      const geo = shape.props?.["geo"];
      return geo === "ellipse" || geo === "oval" ? "ellipse" : "rectangle";
    }
    default:
      return null;
  }
}

function normalizePoints(shape: TLShapeRecord): { x: number; y: number }[] | undefined {
  if (shape.type === "arrow") {
    const start = asPoint(shape.props?.["start"]);
    const end = asPoint(shape.props?.["end"]);
    if (start !== null && end !== null) {
      return [
        { x: shape.x + start.x, y: shape.y + start.y },
        { x: shape.x + end.x, y: shape.y + end.y }
      ];
    }
  }

  if (shape.type === "draw" || shape.type === "highlight") {
    const segments = shape.props?.["segments"];
    if (!Array.isArray(segments)) return undefined;

    const points: { x: number; y: number }[] = [];
    for (const segment of segments) {
      if (!isRecord(segment)) continue;
      const segmentPoints = segment["points"];
      if (!Array.isArray(segmentPoints)) continue;
      for (const rawPoint of segmentPoints) {
        const point = asPoint(rawPoint);
        if (point !== null) {
          points.push({ x: shape.x + point.x, y: shape.y + point.y });
        }
      }
    }
    return points.length > 0 ? points : undefined;
  }

  return undefined;
}

function asPoint(value: unknown): { x: number; y: number } | null {
  if (!isRecord(value)) return null;
  const x = value["x"];
  const y = value["y"];
  return typeof x === "number"
    && Number.isFinite(x)
    && typeof y === "number"
    && Number.isFinite(y)
    ? { x, y }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function timestampFromMeta(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function revisionFromMeta(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new Error("Student shape revision must be a positive safe integer");
}
