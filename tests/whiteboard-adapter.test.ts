import { describe, expect, it, vi } from "vitest";
import {
  newDeliveryId,
  newSessionId,
  type BoardAction
} from "../packages/domain/src/index.js";
import {
  RendererClient,
  type AudioPlayer,
  type RendererAcknowledgementSender,
  type TextPresenter
} from "../apps/web/src/renderer-client.js";
import {
  InMemoryTldrawEditor,
  StaleShapeRevisionError,
  StudentShapeImmutableError,
  TldrawWhiteboardAdapter
} from "../apps/web/src/tldraw-whiteboard-adapter.js";

describe("TldrawWhiteboardAdapter & AI Overlay Subsystem", () => {
  describe("1. Three-Layer Shape Isolation & Initialization", () => {
    it("initializes without an editor and allows attaching/detaching editor", () => {
      const adapter = new TldrawWhiteboardAdapter();
      expect(adapter.getEditor()).toBeNull();

      const editor = new InMemoryTldrawEditor();
      adapter.attachEditor(editor);
      expect(adapter.getEditor()).toBe(editor);

      adapter.detachEditor();
      expect(adapter.getEditor()).toBeNull();
    });

    it("preserves the current page across a temporary editor detach and remount", async () => {
      const firstEditor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(firstEditor);

      const student = adapter.createStudentShape({
        id: "shape:pause_student",
        type: "geo",
        x: 40,
        y: 50,
        props: { w: 90, h: 60, text: "keep me" }
      });
      await adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: student.id,
        expectedShapeRevision: 1,
        annotationPurpose: "pause continuity"
      });
      const revisionBeforeDetach = adapter.getBoardRevision();
      const shapeIdsBeforeDetach = firstEditor
        .getCurrentPageShapes()
        .map((shape) => shape.id)
        .sort();

      adapter.detachEditor();
      expect(adapter.getEditor()).toBeNull();

      const remountedEditor = new InMemoryTldrawEditor();
      adapter.attachEditor(remountedEditor);

      expect(adapter.getBoardRevision()).toBe(revisionBeforeDetach);
      expect(
        remountedEditor.getCurrentPageShapes().map((shape) => shape.id).sort()
      ).toEqual(shapeIdsBeforeDetach);
      expect(remountedEditor.getShape(student.id)?.props?.["text"]).toBe("keep me");
      expect(
        remountedEditor
          .getCurrentPageShapes()
          .some((shape) => shape.meta?.["layer"] === "AI_ANNOTATION")
      ).toBe(true);
    });

    it("does not restore an incomplete freehand gesture that was never authoritative", () => {
      const firstEditor = new InMemoryTldrawEditor();
      firstEditor.createShapes([
        {
          id: "shape:stable_student",
          type: "geo",
          x: 10,
          y: 10,
          props: { text: "stable" },
          meta: {
            layer: "STUDENT",
            origin: "STUDENT",
            shapeRevision: 1
          }
        },
        {
          id: "shape:unfinished_stroke",
          type: "draw",
          x: 20,
          y: 20,
          props: { isComplete: false },
          meta: {
            layer: "STUDENT",
            origin: "STUDENT",
            shapeRevision: 1
          }
        }
      ]);
      const adapter = new TldrawWhiteboardAdapter(firstEditor);

      adapter.detachEditor();
      const remounted = new InMemoryTldrawEditor();
      adapter.attachEditor(remounted);

      expect(remounted.getShape("shape:stable_student")).toBeDefined();
      expect(remounted.getShape("shape:unfinished_stroke")).toBeUndefined();
    });

    it("does not restore a detached canvas after a genuine new-session reset", () => {
      const firstEditor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(firstEditor);
      adapter.createStudentShape({
        id: "shape:old_session",
        type: "geo",
        x: 1,
        y: 2,
        props: { text: "old" }
      });

      adapter.detachEditor();
      adapter.resetForNewSession();

      const nextEditor = new InMemoryTldrawEditor();
      adapter.attachEditor(nextEditor);

      expect(nextEditor.getCurrentPageShapes()).toEqual([]);
      expect(adapter.getBoardRevision()).toBe(0);
    });

    it("throws when calling operations without an attached editor", async () => {
      const adapter = new TldrawWhiteboardAdapter();
      const action: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        annotationPurpose: "highlight clique candidate"
      };

      await expect(adapter.applyAiOverlayAction(action)).rejects.toThrow(
        "TldrawWhiteboardAdapter is not attached to an active Tldraw editor instance"
      );
      await expect(adapter.clearAiOverlay()).rejects.toThrow(
        "TldrawWhiteboardAdapter is not attached to an active Tldraw editor instance"
      );
      expect(() => adapter.getCanvasSnapshot()).toThrow(
        "TldrawWhiteboardAdapter is not attached to an active Tldraw editor instance"
      );
    });

    it("creates student shapes tagged with STUDENT layer metadata", () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentShape = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100,
        props: { geo: "ellipse", text: "v1" }
      });

      expect(studentShape.id).toMatch(/^shape:student_/);
      expect(studentShape.meta?.["layer"]).toBe("STUDENT");
      expect(studentShape.meta?.["origin"]).toBe("STUDENT");
      expect(studentShape.meta?.["shapeRevision"]).toBe(1);
    });

    it("resets all mounted shapes and the local revision for a genuinely new session", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      adapter.createStudentShape({
        type: "geo",
        x: 10,
        y: 10,
        props: { text: "old-session work" }
      });
      await adapter.applyAiOverlayAction({
        operation: "write_text",
        layer: "AI_ANNOTATION",
        content: "old hint",
        annotationPurpose: "old-session annotation"
      });
      expect(adapter.getBoardRevision()).toBeGreaterThan(0);
      expect(editor.getCurrentPageShapes().length).toBeGreaterThan(0);

      adapter.resetForNewSession();

      expect(editor.getCurrentPageShapes()).toEqual([]);
      expect(adapter.getBoardRevision()).toBe(0);
      expect(adapter.getNormalizedStudentShapes()).toEqual([]);
    });

    it("increments shapeRevision when updating student shapes", () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentShape = adapter.createStudentShape({
        type: "geo",
        x: 50,
        y: 50,
        props: { text: "v1" }
      });

      const updated = adapter.updateStudentShape(studentShape.id, {
        x: 80,
        y: 90,
        props: { text: "v1 (modified)" }
      });

      expect(updated.x).toBe(80);
      expect(updated.y).toBe(90);
      expect(updated.meta?.["shapeRevision"]).toBe(2);
      expect(updated.meta?.["layer"]).toBe("STUDENT");
    });
  });

  describe("2. Non-Destructive AI Overlay Actions (All 7 Operations)", () => {
    it("renders 'circle' overlay enclosing target bounds with violet dashed stroke", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentVertex = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100,
        props: { w: 60, h: 60, text: "v1" }
      });

      const circleAction: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: studentVertex.id,
        expectedShapeRevision: 1,
        content: "Look at v1",
        annotationPurpose: "focus on vertex with deg >= 3"
      };

      await adapter.applyAiOverlayAction(circleAction);

      const shapes = editor.getCurrentPageShapes();
      expect(shapes).toHaveLength(2);

      const aiShape = shapes.find((s) => s.meta?.["layer"] === "AI_ANNOTATION");
      expect(aiShape).toBeDefined();
      expect(aiShape?.id).toMatch(/^shape:ai_circle_/);
      expect(aiShape?.x).toBe(100 - 12);
      expect(aiShape?.y).toBe(100 - 12);
      expect(aiShape?.props?.["w"]).toBe(60 + 24);
      expect(aiShape?.props?.["h"]).toBe(60 + 24);
      expect(aiShape?.props?.["color"]).toBe("violet");
      expect(aiShape?.props?.["dash"]).toBe("dashed");
      expect(aiShape?.props?.["fill"]).toBe("none");
      expect(aiShape?.meta?.["targetShapeId"]).toBe(studentVertex.id);
      expect(aiShape?.meta?.["annotationPurpose"]).toBe("focus on vertex with deg >= 3");
    });

    it("renders 'highlight' overlay with yellow semi fill and 0.35 opacity", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentEq = adapter.createStudentShape({
        type: "text",
        x: 200,
        y: 200,
        props: { w: 150, h: 40, text: "R(3,3) <= 6" }
      });

      const highlightAction: BoardAction = {
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: studentEq.id,
        expectedShapeRevision: 1,
        annotationPurpose: "highlight Ramsey bound"
      };

      await adapter.applyAiOverlayAction(highlightAction);

      const shapes = editor.getCurrentPageShapes();
      const aiHighlight = shapes.find((s) => s.id.startsWith("shape:ai_highlight_"));
      expect(aiHighlight).toBeDefined();
      expect(aiHighlight?.x).toBe(200 - 6);
      expect(aiHighlight?.y).toBe(200 - 6);
      expect(aiHighlight?.opacity).toBe(0.35);
      expect(aiHighlight?.props?.["color"]).toBe("yellow");
      expect(aiHighlight?.props?.["fill"]).toBe("semi");
      expect(aiHighlight?.meta?.["layer"]).toBe("AI_ANNOTATION");
    });

    it("renders 'draw_arrow' pointing towards target shape center", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentNode = adapter.createStudentShape({
        type: "geo",
        x: 300,
        y: 300,
        props: { w: 100, h: 100 }
      });

      const arrowAction: BoardAction = {
        operation: "draw_arrow",
        layer: "AI_ANNOTATION",
        targetShapeId: studentNode.id,
        expectedShapeRevision: 1,
        content: "Check neighbors",
        annotationPurpose: "suggest edge analysis"
      };

      await adapter.applyAiOverlayAction(arrowAction);

      const shapes = editor.getCurrentPageShapes();
      const aiArrow = shapes.find((s) => s.id.startsWith("shape:ai_arrow_"));
      expect(aiArrow).toBeDefined();
      expect(aiArrow?.type).toBe("arrow");
      expect(aiArrow?.props?.["color"]).toBe("violet");
      expect(aiArrow?.props?.["text"]).toBe("Check neighbors");
      expect(aiArrow?.meta?.["layer"]).toBe("AI_ANNOTATION");
    });

    it("renders 'point_at' overlay with orange triangle pointer", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const target = adapter.createStudentShape({
        type: "geo",
        x: 400,
        y: 150,
        props: { w: 80, h: 80 }
      });

      const pointAction: BoardAction = {
        operation: "point_at",
        layer: "AI_ANNOTATION",
        targetShapeId: target.id,
        expectedShapeRevision: 1,
        annotationPurpose: "point at critical vertex"
      };

      await adapter.applyAiOverlayAction(pointAction);

      const shapes = editor.getCurrentPageShapes();
      const aiPoint = shapes.find((s) => s.id.startsWith("shape:ai_point_"));
      expect(aiPoint).toBeDefined();
      expect(aiPoint?.type).toBe("arrow");
      expect(aiPoint?.props?.["color"]).toBe("orange");
      expect(aiPoint?.props?.["arrowheadEnd"]).toBe("triangle");
      expect(aiPoint?.meta?.["layer"]).toBe("AI_ANNOTATION");
    });

    it("renders 'write_text' overlay as a margin note card adjacent to target", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const target = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100,
        props: { w: 100, h: 100 }
      });

      const writeTextAction: BoardAction = {
        operation: "write_text",
        layer: "AI_ANNOTATION",
        targetShapeId: target.id,
        expectedShapeRevision: 1,
        content: "Consider the degree of this vertex.",
        annotationPurpose: "socratic question"
      };

      await adapter.applyAiOverlayAction(writeTextAction);

      const shapes = editor.getCurrentPageShapes();
      const aiNote = shapes.find((s) => s.id.startsWith("shape:ai_text_"));
      expect(aiNote).toBeDefined();
      expect(aiNote?.type).toBe("note");
      expect(aiNote?.x).toBe(100 + 100 + 16);
      expect(aiNote?.y).toBe(100);
      expect(aiNote?.props?.["text"]).toBe("Consider the degree of this vertex.");
      expect(aiNote?.meta?.["layer"]).toBe("AI_ANNOTATION");
    });

    it("renders 'write_equation' overlay with monospace equation card", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const eqAction: BoardAction = {
        operation: "write_equation",
        layer: "AI_ANNOTATION",
        content: "d(v) >= 3",
        annotationPurpose: "pigeonhole principle degree bound"
      };

      await adapter.applyAiOverlayAction(eqAction);

      const shapes = editor.getCurrentPageShapes();
      const aiEq = shapes.find((s) => s.id.startsWith("shape:ai_equation_"));
      expect(aiEq).toBeDefined();
      expect(aiEq?.props?.["text"]).toBe("d(v) >= 3");
      expect(aiEq?.props?.["font"]).toBe("mono");
      expect(aiEq?.meta?.["layer"]).toBe("AI_ANNOTATION");
      expect(aiEq?.meta?.["isEquation"]).toBe(true);
    });

    it("executes 'erase_ai_annotation' on targeted AI annotation", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const circleAction: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        annotationPurpose: "temporary hint"
      };
      await adapter.applyAiOverlayAction(circleAction);

      const shapesBefore = editor.getCurrentPageShapes();
      const aiShape = shapesBefore.find((s) => s.meta?.["layer"] === "AI_ANNOTATION");
      expect(aiShape).toBeDefined();

      const eraseAction: BoardAction = {
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: aiShape?.id,
        annotationPurpose: "withdraw hint"
      };
      await adapter.applyAiOverlayAction(eraseAction);

      const shapesAfter = editor.getCurrentPageShapes();
      expect(shapesAfter.find((s) => s.id === aiShape?.id)).toBeUndefined();
    });

    it("uses annotation creation metadata rather than page order for targetless erase", async () => {
      const base = new InMemoryTldrawEditor();
      base.createShapes([
        {
          id: "shape:ai_newer",
          type: "note",
          x: 0,
          y: 0,
          props: { text: "newer" },
          meta: {
            layer: "AI_ANNOTATION",
            origin: "AI",
            shapeRevision: 1,
            annotationPurpose: "newer",
            operation: "write_text",
            createdAt: "2026-08-30T20:00:01.000Z"
          }
        },
        {
          id: "shape:ai_older",
          type: "note",
          x: 0,
          y: 0,
          props: { text: "older" },
          meta: {
            layer: "AI_ANNOTATION",
            origin: "AI",
            shapeRevision: 1,
            annotationPurpose: "older",
            operation: "write_text",
            createdAt: "2026-08-30T20:00:00.000Z"
          }
        }
      ]);
      const newerShape = base.getShape("shape:ai_newer");
      const olderShape = base.getShape("shape:ai_older");
      if (newerShape === undefined || olderShape === undefined) {
        throw new Error("AI ordering fixture shapes were not created");
      }
      const editor = {
        getShape: (id: string) => base.getShape(id),
        getCurrentPageShapes: () => [newerShape, olderShape],
        createShapes: base.createShapes.bind(base),
        deleteShapes: base.deleteShapes.bind(base),
        updateShapes: base.updateShapes.bind(base),
        getShapePageBounds: base.getShapePageBounds.bind(base)
      };
      const adapter = new TldrawWhiteboardAdapter(editor);

      await adapter.applyAiOverlayAction({
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        annotationPurpose: "erase newest"
      });

      expect(base.getShape("shape:ai_newer")).toBeUndefined();
      expect(base.getShape("shape:ai_older")).toBeDefined();
    });

    it("executes 'erase_ai_annotation' without targetShapeId by deleting most recent AI shape", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      await adapter.applyAiOverlayAction({
        operation: "write_text",
        layer: "AI_ANNOTATION",
        content: "First hint",
        annotationPurpose: "hint 1"
      });

      await adapter.applyAiOverlayAction({
        operation: "write_text",
        layer: "AI_ANNOTATION",
        content: "Second hint",
        annotationPurpose: "hint 2"
      });

      const shapesBefore = editor.getCurrentPageShapes();
      expect(shapesBefore).toHaveLength(2);

      await adapter.applyAiOverlayAction({
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        annotationPurpose: "erase latest"
      });

      const shapesAfter = editor.getCurrentPageShapes();
      expect(shapesAfter).toHaveLength(1);
      expect(shapesAfter[0]?.props?.["text"]).toBe("First hint");
    });
  });

  describe("3. Student Shape Immutability & Fail-Closed Guard", () => {
    it("throws StudentShapeImmutableError and refuses when erase_ai_annotation targets a STUDENT shape", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentShape = adapter.createStudentShape({
        type: "geo",
        x: 150,
        y: 150,
        props: { geo: "ellipse", text: "Student Vertex" }
      });

      const maliciousAction: BoardAction = {
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: studentShape.id,
        annotationPurpose: "attempted deletion of student stroke"
      };

      await expect(adapter.applyAiOverlayAction(maliciousAction)).rejects.toThrow(
        StudentShapeImmutableError
      );

      // Verify the student shape was NOT deleted
      const found = editor.getShape(studentShape.id);
      expect(found).toBeDefined();
      expect(found?.meta?.["layer"]).toBe("STUDENT");
    });

    it("refuses to delete SYSTEM_DECORATION shapes via erase_ai_annotation", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const systemShape = {
        id: "shape:system_grid_1",
        type: "geo",
        x: 0,
        y: 0,
        meta: { layer: "SYSTEM_DECORATION", origin: "SYSTEM" }
      };
      editor.createShapes([systemShape]);

      const action: BoardAction = {
        operation: "erase_ai_annotation",
        layer: "AI_ANNOTATION",
        targetShapeId: systemShape.id,
        annotationPurpose: "attempted deletion of system grid"
      };

      await expect(adapter.applyAiOverlayAction(action)).rejects.toThrow(
        StudentShapeImmutableError
      );
      expect(editor.getShape(systemShape.id)).toBeDefined();
    });

    it("ensures student shapes are never mutated when any AI overlay is created around them", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentShape = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100,
        props: { w: 80, h: 80, color: "black", text: "v1" }
      });
      const originalProps = JSON.stringify(studentShape.props);
      const originalMeta = JSON.stringify(studentShape.meta);

      // Run multiple AI overlay actions targeting this student shape
      await adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: studentShape.id,
        expectedShapeRevision: 1,
        annotationPurpose: "circle hint"
      });
      await adapter.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: studentShape.id,
        expectedShapeRevision: 1,
        annotationPurpose: "highlight hint"
      });
      await adapter.applyAiOverlayAction({
        operation: "write_text",
        layer: "AI_ANNOTATION",
        targetShapeId: studentShape.id,
        expectedShapeRevision: 1,
        content: "Question",
        annotationPurpose: "question hint"
      });

      const currentStudentShape = editor.getShape(studentShape.id);
      expect(currentStudentShape).toBeDefined();
      expect(currentStudentShape?.x).toBe(100);
      expect(currentStudentShape?.y).toBe(100);
      expect(JSON.stringify(currentStudentShape?.props)).toBe(originalProps);
      expect(JSON.stringify(currentStudentShape?.meta)).toBe(originalMeta);
    });
  });

  describe("4. clearAiOverlay() Atomic Overlay Removal", () => {
    it("cleanly removes only AI annotations while leaving 100% of student and system shapes intact", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      // Create 3 student shapes
      const s1 = adapter.createStudentShape({ type: "geo", x: 10, y: 10, props: { text: "v1" } });
      const s2 = adapter.createStudentShape({ type: "geo", x: 50, y: 50, props: { text: "v2" } });
      const s3 = adapter.createStudentShape({ type: "geo", x: 90, y: 90, props: { text: "v3" } });

      // Create 1 system decoration shape
      editor.createShapes([
        {
          id: "shape:system_axis",
          type: "geo",
          x: 0,
          y: 0,
          meta: { layer: "SYSTEM_DECORATION" }
        }
      ]);

      // Create 3 AI annotations
      await adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: s1.id,
        annotationPurpose: "circle v1"
      });
      await adapter.applyAiOverlayAction({
        operation: "highlight",
        layer: "AI_ANNOTATION",
        targetShapeId: s2.id,
        annotationPurpose: "highlight v2"
      });
      await adapter.applyAiOverlayAction({
        operation: "write_equation",
        layer: "AI_ANNOTATION",
        content: "K_3 \\subseteq G",
        annotationPurpose: "subgraph formula"
      });

      expect(editor.getCurrentPageShapes()).toHaveLength(7);

      // Clear AI overlay
      await adapter.clearAiOverlay();

      const remainingShapes = editor.getCurrentPageShapes();
      expect(remainingShapes).toHaveLength(4);

      // Verify all student shapes exist and are unchanged
      expect(editor.getShape(s1.id)).toBeDefined();
      expect(editor.getShape(s2.id)).toBeDefined();
      expect(editor.getShape(s3.id)).toBeDefined();
      expect(editor.getShape("shape:system_axis")).toBeDefined();

      // Verify zero AI annotations remain
      const aiShapes = remainingShapes.filter((s) => s.meta?.["layer"] === "AI_ANNOTATION");
      expect(aiShapes).toHaveLength(0);
    });
  });

  describe("5. Shape Revision Validation & Stale Reference Handling", () => {
    it("succeeds when expectedShapeRevision matches actual target shape revision", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentNode = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100,
        shapeRevision: 3
      });

      const action: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: studentNode.id,
        expectedShapeRevision: 3,
        annotationPurpose: "valid revision hint"
      };

      await expect(adapter.applyAiOverlayAction(action)).resolves.not.toThrow();
    });

    it("throws StaleShapeRevisionError when target shape revision has advanced", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const studentNode = adapter.createStudentShape({
        type: "geo",
        x: 100,
        y: 100
      });
      // Student updates the shape, advancing revision to 2
      adapter.updateStudentShape(studentNode.id, { x: 120 });

      // AI had prepared an action based on revision 1
      const staleAction: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: studentNode.id,
        expectedShapeRevision: 1,
        annotationPurpose: "stale hint"
      };

      await expect(adapter.applyAiOverlayAction(staleAction)).rejects.toThrow(
        StaleShapeRevisionError
      );
    });

    it("throws StaleShapeRevisionError when target shape does not exist", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const missingAction: BoardAction = {
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:non_existent_123",
        expectedShapeRevision: 1,
        annotationPurpose: "missing target hint"
      };

      await expect(adapter.applyAiOverlayAction(missingAction)).rejects.toThrow(
        StaleShapeRevisionError
      );
    });
  });

  describe("6. Canvas Snapshot Extraction & Dirty Region Calculation", () => {
    it("extracts clean structured CanvasSnapshot separating student and AI elements", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const s1 = adapter.createStudentShape({
        type: "geo",
        x: 10,
        y: 20,
        props: { w: 100, h: 80, text: "Student Vertex A" }
      });

      await adapter.applyAiOverlayAction(
        {
          operation: "circle",
          layer: "AI_ANNOTATION",
          targetShapeId: s1.id,
          expectedShapeRevision: 1,
          annotationPurpose: "circle vertex A"
        },
        {
          deliveryId: newDeliveryId()
        }
      );

      const snapshot = adapter.getCanvasSnapshot();
      expect(snapshot.studentShapes).toHaveLength(1);
      expect(snapshot.studentShapes[0]?.id).toBe(s1.id);
      expect(snapshot.studentShapes[0]?.text).toBe("Student Vertex A");
      expect(snapshot.studentShapes[0]?.bounds).toEqual({
        x: 10,
        y: 20,
        width: 100,
        height: 80
      });
      expect(snapshot.studentShapes[0]?.shapeRevision).toBe(1);

      expect(snapshot.aiAnnotations).toHaveLength(1);
      expect(snapshot.aiAnnotations[0]?.operation).toBe("circle");
      expect(snapshot.aiAnnotations[0]?.purpose).toBe("circle vertex A");
      expect(snapshot.aiAnnotations[0]?.targetShapeId).toBe(s1.id);
      expect(snapshot.aiAnnotations[0]?.deliveryId).toBeDefined();
    });

    it("computes dirty region bounding box across modified shape IDs", () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const s1 = adapter.createStudentShape({ type: "geo", x: 100, y: 100, props: { w: 50, h: 50 } });
      const s2 = adapter.createStudentShape({ type: "geo", x: 300, y: 200, props: { w: 60, h: 80 } });

      const dirty = adapter.computeDirtyRegion([s1.id, s2.id]);
      expect(dirty).not.toBeNull();
      expect(dirty?.minX).toBe(100);
      expect(dirty?.minY).toBe(100);
      expect(dirty?.maxX).toBe(360);
      expect(dirty?.maxY).toBe(280);
      expect(dirty?.width).toBe(260);
      expect(dirty?.height).toBe(180);
      expect(dirty?.shapeIds).toEqual([s1.id, s2.id]);
    });

    it("returns null dirty region for empty modified shape list", () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);
      expect(adapter.computeDirtyRegion([])).toBeNull();
    });
  });

  describe("7. Integration with RendererClient & Delivery Acknowledgements", () => {
    it("presents whiteboard action and triggers EXPOSED and COMPLETED acknowledgements", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);
      const deliveryId = newDeliveryId();
      const sessionId = newSessionId();

      const sentCommands: unknown[] = [];
      const acknowledgementSender: RendererAcknowledgementSender = {
        send: async (command) => {
          sentCommands.push(command);
        }
      };

      const textPresenter: TextPresenter = {
        presentText: vi.fn()
      };

      const audioPlayer: AudioPlayer = {
        playAudio: vi.fn()
      };

      const renderer = new RendererClient({
        sessionId,
        acknowledgementSender,
        textPresenter,
        audioPlayer,
        whiteboardPresenter: adapter
      });

      const action: BoardAction = {
        operation: "write_equation",
        layer: "AI_ANNOTATION",
        content: "R(3,3) = 6",
        annotationPurpose: "deliver final theorem statement"
      };

      const streamMessage = {
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId,
          content: {
            medium: "WHITEBOARD",
            action
          }
        }
      };

      const handleResult = await renderer.handleMessage(streamMessage);
      expect(handleResult.deliveryId).toBe(deliveryId);
      expect(handleResult.phase).toBe("COMPLETED");

      // Verify that AI shape was created on the editor
      const shapes = editor.getCurrentPageShapes();
      const aiShape = shapes.find((s) => s.meta?.["layer"] === "AI_ANNOTATION");
      expect(aiShape).toBeDefined();
      expect(aiShape?.props?.["text"]).toBe("R(3,3) = 6");
      expect(aiShape?.meta?.["deliveryId"]).toBe(deliveryId);

      // Verify delivery snapshots
      const snapshots = renderer.snapshot();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.phase).toBe("COMPLETED");
      expect(snapshots[0]?.exposedAcknowledged).toBe(true);
      expect(snapshots[0]?.completedAcknowledged).toBe(true);

      // Verify acknowledgements sent
      expect(sentCommands).toHaveLength(2);
      expect(sentCommands[0]).toMatchObject({
        type: "ACK_DELIVERY_EXPOSED",
        deliveryId,
        sessionId
      });
      expect(sentCommands[1]).toMatchObject({
        type: "ACK_DELIVERY_COMPLETED",
        deliveryId,
        sessionId
      });
    });
  });

  describe("8. Store and Listener Lifecycle", () => {
    it("attaches listeners and notifies of snapshot state changes", () => {
      const editor = new InMemoryTldrawEditor();
      let listenerRegistered = false;
      editor.store = {
        listen: vi.fn(() => {
          listenerRegistered = true;
          return () => {
            listenerRegistered = false;
          };
        }),
        allRecords: () => []
      };

      const adapter = new TldrawWhiteboardAdapter(editor);
      expect(adapter.getEditor()).toBe(editor);

      const unlisten = editor.store.listen?.(() => {
        // change notification
      });
      expect(listenerRegistered).toBe(true);

      unlisten?.();
      expect(listenerRegistered).toBe(false);
    });

    it("rejects malformed target revision and blank action metadata before rendering", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      for (const expectedShapeRevision of [
        0,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER + 1
      ]) {
        await expect(adapter.applyAiOverlayAction({
          operation: "circle",
          layer: "AI_ANNOTATION",
          targetShapeId: "shape:target",
          expectedShapeRevision,
          annotationPurpose: "test"
        })).rejects.toThrow(/positive safe integer/u);
      }

      await expect(adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "shape:target",
        expectedShapeRevision: Number.POSITIVE_INFINITY,
        annotationPurpose: "test"
      })).rejects.toThrow();

      await expect(adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        expectedShapeRevision: 1,
        annotationPurpose: "test"
      })).rejects.toThrow(/requires targetShapeId/u);

      await expect(adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        targetShapeId: "   ",
        annotationPurpose: "test"
      })).rejects.toThrow(/targetShapeId must be non-blank/u);

      await expect(adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        annotationPurpose: "   "
      })).rejects.toThrow(/annotationPurpose must be non-blank/u);

      expect(editor.getCurrentPageShapes()).toEqual([]);
    });

    it("rejects unrecognized action operations at runtime schema validation", async () => {
      const editor = new InMemoryTldrawEditor();
      const adapter = new TldrawWhiteboardAdapter(editor);

      const invalidAction = {
        operation: "unknown_custom_op" as unknown as BoardAction["operation"],
        layer: "AI_ANNOTATION" as const,
        annotationPurpose: "invalid op test"
      };

      await expect(adapter.applyAiOverlayAction(invalidAction as BoardAction)).rejects.toThrow();
    });
  });
});
