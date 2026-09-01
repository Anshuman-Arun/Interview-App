import { describe, expect, it } from "vitest";
import {
  isStudentOwnedShape,
  normalizeStudentShape
} from "../apps/web/src/whiteboard/normalized-board.js";
import type {
  TLShapeBounds,
  TLShapeRecord
} from "../apps/web/src/tldraw-whiteboard-adapter.js";

const bounds: TLShapeBounds = {
  x: 10,
  y: 20,
  width: 120,
  height: 60
};

function studentShape(
  overrides: Partial<TLShapeRecord> = {}
): TLShapeRecord {
  return {
    id: "shape:student",
    type: "geo",
    x: 10,
    y: 20,
    props: { geo: "rectangle" },
    meta: {
      layer: "STUDENT",
      origin: "STUDENT",
      shapeRevision: 3,
      createdAt: "2026-08-30T20:00:00.000Z",
      lastModifiedAt: "2026-08-30T20:01:00.000Z"
    },
    ...overrides
  };
}

describe("normalized tldraw board changes", () => {
  it("normalizes rectangle and ellipse geometry without leaking tldraw records", () => {
    const rectangle = normalizeStudentShape(studentShape(), bounds);
    const ellipse = normalizeStudentShape(
      studentShape({ id: "shape:ellipse", props: { geo: "ellipse" } }),
      bounds
    );

    expect(rectangle).toMatchObject({
      id: "shape:student",
      type: "rectangle",
      bounds,
      revision: 3
    });
    expect(ellipse?.type).toBe("ellipse");
  });

  it("normalizes freehand draw points into page coordinates", () => {
    const shape = studentShape({
      type: "draw",
      x: 100,
      y: 200,
      props: {
        segments: [
          {
            type: "free",
            points: [
              { x: 1, y: 2, z: 0.5 },
              { x: 4, y: 8, z: 0.5 }
            ]
          }
        ]
      }
    });

    expect(normalizeStudentShape(shape, bounds)?.points).toEqual([
      { x: 101, y: 202 },
      { x: 104, y: 208 }
    ]);
  });

  it("rejects malformed normalized bounds instead of clamping or propagating them", () => {
    const shape = studentShape();

    expect(() => normalizeStudentShape(shape, {
      ...bounds,
      width: Number.POSITIVE_INFINITY
    })).toThrow(/non-finite width bounds/u);

    expect(() => normalizeStudentShape(shape, {
      ...bounds,
      height: -1
    })).toThrow(/non-negative/u);

    expect(() => normalizeStudentShape(shape, {
      ...bounds,
      x: Number.NaN
    })).toThrow(/non-finite x bounds/u);
  });

  it("drops non-finite geometry points from normalized mutations", () => {
    const shape = studentShape({
      type: "draw",
      x: 0,
      y: 0,
      props: {
        segments: [{
          type: "free",
          points: [
            { x: Number.POSITIVE_INFINITY, y: 1 },
            { x: 2, y: Number.NaN },
            { x: 3, y: 4 }
          ]
        }]
      }
    });

    expect(normalizeStudentShape(shape, bounds)?.points).toEqual([{ x: 3, y: 4 }]);
  });

  it("normalizes arrows, text, and formula metadata", () => {
    const arrow = studentShape({
      type: "arrow",
      x: 25,
      y: 30,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 40, y: 50 }
      }
    });
    const text = studentShape({
      id: "shape:text",
      type: "text",
      props: { text: "x^2 + y^2" }
    });
    const formula = studentShape({
      id: "shape:formula",
      type: "text",
      props: { text: "R(3,3)=6" },
      meta: {
        layer: "STUDENT",
        shapeRevision: 1,
        isEquation: true,
        createdAt: "2026-08-30T20:00:00.000Z"
      }
    });

    expect(normalizeStudentShape(arrow, bounds)?.points).toEqual([
      { x: 25, y: 30 },
      { x: 65, y: 80 }
    ]);
    expect(normalizeStudentShape(text, bounds)?.text).toBe("x^2 + y^2");
    expect(normalizeStudentShape(formula, bounds)?.type).toBe("formula");
  });

  it("excludes AI annotations and system decorations from student changes", () => {
    const aiShape = studentShape({
      meta: {
        layer: "AI_ANNOTATION",
        origin: "AI",
        shapeRevision: 1,
        createdAt: "2026-08-30T20:00:00.000Z"
      }
    });
    const systemShape = studentShape({
      id: "shape:system",
      meta: {
        layer: "SYSTEM_DECORATION",
        origin: "SYSTEM",
        shapeRevision: 1,
        createdAt: "2026-08-30T20:00:00.000Z"
      }
    });

    expect(isStudentOwnedShape(aiShape)).toBe(false);
    expect(isStudentOwnedShape(systemShape)).toBe(false);
    expect(normalizeStudentShape(aiShape, bounds)).toBeNull();
    expect(normalizeStudentShape(systemShape, bounds)).toBeNull();
  });

  it("rejects explicit malformed revisions while retaining legacy missing-revision support", () => {
    for (const shapeRevision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() => normalizeStudentShape(studentShape({
        meta: {
          layer: "STUDENT",
          origin: "STUDENT",
          shapeRevision,
          createdAt: "2026-08-30T20:00:00.000Z"
        }
      }), bounds)).toThrow(/positive safe integer/u);
    }

    expect(normalizeStudentShape(studentShape({
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: Number.MAX_SAFE_INTEGER,
        createdAt: "2026-08-30T20:00:00.000Z"
      }
    }), bounds)?.revision).toBe(Number.MAX_SAFE_INTEGER);

    expect(normalizeStudentShape({
      id: "shape:legacy-missing-revision",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle" },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        createdAt: "2026-08-30T20:00:00.000Z"
      }
    }, bounds)?.revision).toBe(1);
  });

  it("treats legacy untagged user shapes as student-owned and rejects unsupported shape types", () => {
    const legacy: TLShapeRecord = {
      id: "shape:legacy",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle" }
    };
    const unsupported = studentShape({ type: "image" });

    expect(isStudentOwnedShape(legacy)).toBe(true);
    expect(normalizeStudentShape(legacy, bounds)?.revision).toBe(1);
    expect(normalizeStudentShape(unsupported, bounds)).toBeNull();
  });
});
