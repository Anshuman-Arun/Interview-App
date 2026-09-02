import { describe, expect, it } from "vitest";
import {
  InMemoryTldrawEditor,
  TldrawWhiteboardAdapter,
  type TldrawEditor
} from "../apps/web/src/tldraw-whiteboard-adapter.js";
import { RealTldrawEditorBridge } from "../apps/web/src/whiteboard/real-tldraw-editor.js";

describe("TldrawWhiteboardAdapter board revision authority", () => {
  it("counts each direct editor student transaction exactly once", () => {
    const adapter = new TldrawWhiteboardAdapter(new InMemoryTldrawEditor());

    expect(adapter.getBoardRevision()).toBe(0);
    adapter.observeNormalizedStudentMutation("EDITOR");
    expect(adapter.getBoardRevision()).toBe(1);
    adapter.observeNormalizedStudentMutation("EDITOR");
    expect(adapter.getBoardRevision()).toBe(2);
    expect(adapter.getCanvasSnapshot().boardRevision).toBe(2);
  });

  it("is insensitive to delayed normalized listener delivery", async () => {
    const adapter = new TldrawWhiteboardAdapter(new InMemoryTldrawEditor());

    adapter.createStudentShape({
      id: "shape:delayed-adapter",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle" }
    });
    expect(adapter.getBoardRevision()).toBe(1);

    await Promise.resolve().then(() => {
      adapter.observeNormalizedStudentMutation("ADAPTER");
    });
    expect(adapter.getBoardRevision()).toBe(1);

    await Promise.resolve().then(() => {
      adapter.observeNormalizedStudentMutation("EDITOR");
    });
    expect(adapter.getBoardRevision()).toBe(2);
  });

  it("does not double-count adapter-originated student mutations", () => {
    const adapter = new TldrawWhiteboardAdapter(new InMemoryTldrawEditor());

    const created = adapter.createStudentShape({
      id: "shape:student",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle" }
    });
    expect(adapter.getBoardRevision()).toBe(1);

    adapter.observeNormalizedStudentMutation("ADAPTER");
    expect(adapter.getBoardRevision()).toBe(1);

    adapter.updateStudentShape(created.id, { x: 30 });
    expect(adapter.getBoardRevision()).toBe(2);

    adapter.observeNormalizedStudentMutation("ADAPTER");
    expect(adapter.getBoardRevision()).toBe(2);
  });

  it("fails atomically when BoardRevision cannot advance", () => {
    const editor = new InMemoryTldrawEditor();
    const adapter = new TldrawWhiteboardAdapter(editor);
    (adapter as unknown as { localBoardRevision: number }).localBoardRevision = Number.MAX_SAFE_INTEGER;

    expect(() => adapter.createStudentShape({
      id: "shape:overflow-create",
      type: "geo",
      x: 1,
      y: 2,
      props: { geo: "rectangle", w: 10, h: 10 }
    })).toThrow(/BoardRevision mirror cannot exceed Number\.MAX_SAFE_INTEGER/u);
    expect(editor.getShape("shape:overflow-create")).toBeUndefined();

    (adapter as unknown as { localBoardRevision: number }).localBoardRevision = 0;
    adapter.createStudentShape({
      id: "shape:overflow-update",
      type: "geo",
      x: 1,
      y: 2,
      props: { geo: "rectangle", w: 10, h: 10 }
    });
    (adapter as unknown as { localBoardRevision: number }).localBoardRevision = Number.MAX_SAFE_INTEGER;
    const before = editor.getShape("shape:overflow-update");

    expect(() => adapter.updateStudentShape("shape:overflow-update", { x: 99 }))
      .toThrow(/BoardRevision mirror cannot exceed Number\.MAX_SAFE_INTEGER/u);
    expect(editor.getShape("shape:overflow-update")).toEqual(before);
  });

  it("rejects malformed shape bounds instead of poisoning snapshots or dirty regions", () => {
    const editor = new InMemoryTldrawEditor();
    editor.createShapes([{
      id: "shape:bad-bounds",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: Number.POSITIVE_INFINITY, h: 10 },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: 1,
        createdAt: "2026-08-30T00:00:00.000Z"
      }
    }]);
    const adapter = new TldrawWhiteboardAdapter(editor);

    expect(() => adapter.getCanvasSnapshot()).toThrow(/non-finite width bounds/u);
    expect(() => adapter.computeDirtyRegion(["shape:bad-bounds"]))
      .toThrow(/non-finite width bounds/u);

    editor.updateShapes([{
      id: "shape:bad-bounds",
      props: { w: -1, h: 10 }
    }]);
    expect(() => adapter.getCanvasSnapshot()).toThrow(/negative bounds dimensions/u);
  });

  it("rejects corrupt explicit revisions in snapshots and stale-target checks", async () => {
    const editor = new InMemoryTldrawEditor();
    editor.createShapes([{
      id: "shape:corrupt-revision",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: 100, h: 50 },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: 0,
        createdAt: "2026-08-30T00:00:00.000Z"
      }
    }]);
    const adapter = new TldrawWhiteboardAdapter(editor);

    expect(() => adapter.getCanvasSnapshot()).toThrow(/invalid shape revision/u);
    await expect(adapter.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      annotationPurpose: "must reject corrupt target revision",
      targetShapeId: "shape:corrupt-revision",
      expectedShapeRevision: 1
    })).rejects.toThrow(/invalid shape revision/u);

    editor.updateShapes([{
      id: "shape:corrupt-revision",
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: undefined
      }
    }]);
    await expect(adapter.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      annotationPurpose: "legacy missing revision is revision one",
      targetShapeId: "shape:corrupt-revision",
      expectedShapeRevision: 1
    })).resolves.toBeUndefined();
  });

  it("preserves corrupt persisted real-editor revisions for fail-closed validation", () => {
    const nativeShape = {
      id: "shape:corrupt-persisted",
      typeName: "shape",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: 100, h: 50 },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: 0,
        createdAt: "2026-08-30T00:00:00.000Z"
      }
    };
    const nativeEditor = {
      getShape: () => nativeShape,
      getCurrentPageShapes: () => [nativeShape],
      getShapePageBounds: () => ({ x: 10, y: 20, w: 100, h: 50 })
    } as unknown as ConstructorParameters<typeof RealTldrawEditorBridge>[0];
    const bridge = new RealTldrawEditorBridge(nativeEditor);
    const adapter = new TldrawWhiteboardAdapter(bridge);

    expect(bridge.getShape(nativeShape.id)?.meta?.["shapeRevision"]).toBe(0);
    expect(() => adapter.getCanvasSnapshot()).toThrow(/invalid shape revision/u);
  });

  it("fails closed when every generated AI overlay id collides", async () => {
    const base = new InMemoryTldrawEditor();
    base.createShapes([{
      id: "shape:student-target",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: 100, h: 50 },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: 1,
        createdAt: "2026-08-30T00:00:00.000Z"
      }
    }]);
    const collisionShape = {
      id: "shape:collision",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", w: 1, h: 1 },
      meta: {
        layer: "STUDENT",
        origin: "STUDENT",
        shapeRevision: 1,
        createdAt: "2026-08-30T00:00:00.000Z"
      }
    };
    const editor: TldrawEditor = {
      getShape: (id) => id.startsWith("shape:ai_circle_")
        ? { ...collisionShape, id }
        : base.getShape(id),
      getCurrentPageShapes: () => base.getCurrentPageShapes(),
      createShapes: (shapes) => base.createShapes(shapes),
      deleteShapes: (ids) => base.deleteShapes(ids),
      updateShapes: (shapes) => base.updateShapes(shapes),
      getShapePageBounds: (id) => base.getShapePageBounds(id)
    };
    const adapter = new TldrawWhiteboardAdapter(editor);

    await expect(adapter.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      annotationPurpose: "must not overwrite student work",
      targetShapeId: "shape:student-target",
      expectedShapeRevision: 1
    })).rejects.toThrow(/Unable to allocate a unique ai_circle/u);

    expect(base.getShape("shape:student-target")?.meta?.["layer"]).toBe("STUDENT");
    expect(adapter.getBoardRevision()).toBe(0);
    expect(base.getCurrentPageShapes()).toHaveLength(1);
  });

  it("never advances BoardRevision for protected-layer adapter activity", async () => {
    const adapter = new TldrawWhiteboardAdapter(new InMemoryTldrawEditor());
    const student = adapter.createStudentShape({
      id: "shape:student",
      type: "geo",
      x: 10,
      y: 20,
      props: { geo: "rectangle", w: 100, h: 50 }
    });
    const before = adapter.getBoardRevision();

    await adapter.applyAiOverlayAction({
      operation: "circle",
      layer: "AI_ANNOTATION",
      annotationPurpose: "point out structure",
      targetShapeId: student.id,
      expectedShapeRevision: 1
    });
    await adapter.clearAiOverlay();

    expect(adapter.getBoardRevision()).toBe(before);
  });
});
