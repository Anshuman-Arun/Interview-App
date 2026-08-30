import { describe, expect, it } from "vitest";
import {
  DirtyRegionCoalescer,
  WhiteboardSessionAdapter
} from "../packages/whiteboard/src/index.js";
import { type BoardAction } from "../packages/domain/src/index.js";

describe("Whiteboard Intelligence Engine & Adapter", () => {
  describe("1. Layer Isolation & Non-Destructive AI Overlays", () => {
    it("preserves student shapes when applying diverse AI annotation actions", async () => {
      const adapter = new WhiteboardSessionAdapter();

      // Student draws a triangle with vertices
      const shapeA = adapter.upsertStudentShape({
        id: "vertex_A",
        type: "ellipse",
        bounds: { x: 100, y: 100, width: 20, height: 20 },
        createdAt: Date.now()
      });
      adapter.upsertStudentShape({
        id: "vertex_B",
        type: "ellipse",
        bounds: { x: 200, y: 100, width: 20, height: 20 },
        createdAt: Date.now()
      });

      expect(adapter.boardRevision).toBe(2);
      expect(adapter.getAllStudentShapes()).toHaveLength(2);

      // AI circles vertex A and writes an equation overlay
      const circleAction: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "vertex_A",
        expectedShapeRevision: shapeA.revision,
        annotationPurpose: "Highlight central vertex A"
      };
      const equationAction: BoardAction = {
        operation: "write_equation",
        layer: "AI_ANNOTATION",
        content: "\\deg(v) = 5",
        annotationPurpose: "Display vertex degree formula"
      };

      const result1 = adapter.applyAiOverlayActionWithResult(circleAction);
      const result2 = adapter.applyAiOverlayActionWithResult(equationAction);

      expect(result1.applied).toBe(true);
      expect(result2.applied).toBe(true);

      // Verify AI layer contains 2 annotations
      expect(adapter.getAllAiAnnotations()).toHaveLength(2);

      // Verify Student layer is completely untouched
      const currentShapes = adapter.getAllStudentShapes();
      expect(currentShapes).toHaveLength(2);
      expect(adapter.getStudentShape("vertex_A")?.bounds).toEqual({ x: 100, y: 100, width: 20, height: 20 });
      expect(adapter.getStudentShape("vertex_B")?.bounds).toEqual({ x: 200, y: 100, width: 20, height: 20 });
    });

    it("clears only AI overlays while leaving student shapes 100% intact", async () => {
      const adapter = new WhiteboardSessionAdapter();

      adapter.upsertStudentShape({
        id: "formula_1",
        type: "formula",
        text: "P_k = p P_{k+1} + q P_{k-1}",
        bounds: { x: 50, y: 50, width: 150, height: 30 },
        createdAt: Date.now()
      });

      await adapter.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: "formula_1",
        annotationPurpose: "Highlight recurrence"
      });

      expect(adapter.getAllAiAnnotations()).toHaveLength(1);
      expect(adapter.getAllStudentShapes()).toHaveLength(1);

      await adapter.clearAiOverlay();

      expect(adapter.getAllAiAnnotations()).toHaveLength(0);
      expect(adapter.getAllStudentShapes()).toHaveLength(1);
      expect(adapter.getStudentShape("formula_1")?.text).toBe("P_k = p P_{k+1} + q P_{k-1}");
    });
  });

  describe("2. Shape Revision Freshness & Stale Pointing Prevention", () => {
    it("drops AI action when target student shape has been mutated to a newer revision", () => {
      const adapter = new WhiteboardSessionAdapter();

      const shape = adapter.upsertStudentShape({
        id: "edge_AB",
        type: "arrow",
        bounds: { x: 50, y: 50, width: 100, height: 10 },
        createdAt: Date.now()
      });
      expect(shape.revision).toBe(1);

      // Student edits/moves the edge
      adapter.upsertStudentShape({
        id: "edge_AB",
        type: "arrow",
        bounds: { x: 60, y: 70, width: 120, height: 15 },
        createdAt: shape.createdAt
      });
      expect(adapter.getStudentShape("edge_AB")?.revision).toBe(2);

      // AI action based on old revision 1
      const staleAction: BoardAction = {
        operation: "point_at",
        layer: "AI_ANNOTATION",
        targetShapeId: "edge_AB",
        expectedShapeRevision: 1, // Stale revision!
        annotationPurpose: "Point to old edge position"
      };

      const result = adapter.applyAiOverlayActionWithResult(staleAction);
      expect(result.applied).toBe(false);
      expect(!result.applied && result.reason).toBe("STALE_SHAPE_REVISION");
      expect(adapter.getAllAiAnnotations()).toHaveLength(0);

      // AI action targeting correct revision 2 succeeds
      const freshAction: BoardAction = {
        operation: "point_at",
        layer: "AI_ANNOTATION",
        targetShapeId: "edge_AB",
        expectedShapeRevision: 2,
        annotationPurpose: "Point to updated edge position"
      };

      const freshResult = adapter.applyAiOverlayActionWithResult(freshAction);
      expect(freshResult.applied).toBe(true);
      expect(adapter.getAllAiAnnotations()).toHaveLength(1);
    });

    it("fails closed when target shape has been deleted", () => {
      const adapter = new WhiteboardSessionAdapter();

      adapter.upsertStudentShape({
        id: "scratch_note",
        type: "text",
        text: "Temporary idea",
        bounds: { x: 10, y: 10, width: 50, height: 20 },
        createdAt: Date.now()
      });

      adapter.deleteStudentShape("scratch_note");

      const action: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "scratch_note",
        annotationPurpose: "Circle deleted note"
      };

      const result = adapter.applyAiOverlayActionWithResult(action);
      expect(result.applied).toBe(false);
      expect(!result.applied && result.reason).toBe("SHAPE_NOT_FOUND");
    });
  });

  describe("3. Dirty Region Coalescing & Context Expansion", () => {
    it("coalesces bounding boxes and finds intersecting shapes", () => {
      const coalescer = new DirtyRegionCoalescer({ paddingRatio: 0.20, minDimension: 20 });

      coalescer.recordDirtyBox({ x: 100, y: 100, width: 50, height: 50 });
      coalescer.recordDirtyBox({ x: 140, y: 120, width: 60, height: 40 });

      const studentShapes = [
        {
          id: "shape_inside",
          type: "rectangle" as const,
          bounds: { x: 110, y: 110, width: 30, height: 30 },
          revision: 1,
          createdAt: 1000,
          lastModifiedAt: 1000
        },
        {
          id: "shape_far_away",
          type: "rectangle" as const,
          bounds: { x: 800, y: 800, width: 50, height: 50 },
          revision: 1,
          createdAt: 1000,
          lastModifiedAt: 1000
        }
      ];

      const flushed = coalescer.flushDirtyRegion(studentShapes);
      expect(flushed).toBeDefined();
      if (!flushed) throw new Error("Expected flushed dirty region");

      // Union was x: 100..200 (width 100), y: 100..160 (height 60). Expanded with 20% padding.
      expect(flushed.bounds.x).toBeLessThan(100);
      expect(flushed.bounds.width).toBeGreaterThan(100);
      expect(flushed.relevantShapeIds).toContain("shape_inside");
      expect(flushed.relevantShapeIds).not.toContain("shape_far_away");

      // Subsequent flush should be undefined until new dirty box recorded
      expect(coalescer.flushDirtyRegion(studentShapes)).toBeUndefined();
    });
  });

  describe("4. Snapshot Serialization", () => {
    it("produces valid serialized whiteboard snapshots", () => {
      const adapter = new WhiteboardSessionAdapter();

      adapter.upsertStudentShape({
        id: "box_1",
        type: "rectangle",
        bounds: { x: 10, y: 20, width: 100, height: 50 },
        createdAt: 5000
      });

      adapter.applyAiOverlayActionWithResult({
        operation: "draw_arrow",
        layer: "AI_ANNOTATION",
        content: "implication",
        annotationPurpose: "Arrow between steps"
      });

      const snapshot = adapter.getSnapshot();
      expect(snapshot.boardRevision).toBe(1);
      expect(snapshot.studentShapes).toHaveLength(1);
      expect(snapshot.aiAnnotations).toHaveLength(1);
      expect(snapshot.timestamp).toBeGreaterThan(0);
    });
  });
});
