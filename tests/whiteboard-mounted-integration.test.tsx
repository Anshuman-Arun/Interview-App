import { createHash } from "node:crypto";
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createShapeId } from "tldraw";
import {
  createWhiteboardCanvasMount
} from "../apps/web/src/components/WhiteboardCanvas.js";
import {
  TldrawWhiteboardAdapter,
  type TldrawEditor
} from "../apps/web/src/tldraw-whiteboard-adapter.js";
import {
  RealTldrawEditorBridge
} from "../apps/web/src/whiteboard/real-tldraw-editor.js";
import {
  BoardRevisionSchema,
  authoritativeBoardShapeCanonicalJson,
  newDeliveryId,
  newRequestId,
  newSessionId,
  type BoardAction
} from "../packages/domain/src/index.js";
import {
  SessionRuntimeRegistry,
  TurnCoordinator,
  createCommandEnvelope
} from "../packages/interview-engine/src/index.js";
import {
  RendererStreamMessageSchema,
  type RendererAcknowledgementCommand
} from "../packages/delivery/src/index.js";
import { SqliteEventStore } from "../packages/persistence/src/index.js";
import { sixPeopleProblem } from "../packages/problems/src/index.js";
import {
  AuthoritativeBoardSyncCoordinator
} from "../apps/web/src/whiteboard/authoritative-board-sync.js";
import { RendererClient } from "../apps/web/src/renderer-client.js";
import type { NormalizedStudentShapeChange } from "../apps/web/src/whiteboard/normalized-board.js";

function requireRealTldrawBridge(
  handle: ReturnType<typeof createWhiteboardCanvasMount>
): RealTldrawEditorBridge {
  const editor = handle.getEditor();
  if (!(editor instanceof RealTldrawEditorBridge)) {
    throw new Error("Real tldraw bridge did not mount");
  }
  return editor;
}

const ACT_ENVIRONMENT_KEY = "IS_REACT_ACT_ENVIRONMENT";
const hadActEnvironment = Object.prototype.hasOwnProperty.call(
  globalThis,
  ACT_ENVIRONMENT_KEY
);
const previousActEnvironment: unknown = Reflect.get(globalThis, ACT_ENVIRONMENT_KEY);
const originalDocumentFontsDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "fonts"
);

describe("Real tldraw mounted browser integration", () => {
  beforeEach(() => {
    Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, true);

    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));

    if (typeof globalThis.FontFace === "undefined") {
      vi.stubGlobal("FontFace", class FontFace {
        public load(): Promise<this> {
          return Promise.resolve(this);
        }
      });
    }

    if (typeof document !== "undefined") {
      Object.defineProperty(document, "fonts", {
        value: {
          [Symbol.iterator]: () => [][Symbol.iterator](),
          values: () => [][Symbol.iterator](),
          add: () => {},
          delete: () => {},
          has: () => false,
          ready: Promise.resolve()
        },
        configurable: true,
        writable: true
      });
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (hadActEnvironment) {
      Reflect.set(globalThis, ACT_ENVIRONMENT_KEY, previousActEnvironment);
    } else {
      Reflect.deleteProperty(globalThis, ACT_ENVIRONMENT_KEY);
    }
    if (originalDocumentFontsDescriptor === undefined) {
      Reflect.deleteProperty(document, "fonts");
    } else {
      Object.defineProperty(document, "fonts", originalDocumentFontsDescriptor);
    }
  });

  it("mounts the real tldraw component into a DOM element and initializes adapter bridge", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    let mountedEditor: TldrawEditor | null = null;
    const onBoardChange = vi.fn();
    const onNormalizedChange = vi.fn();

    const handle = createWhiteboardCanvasMount({
      adapter,
      onEditorMount: (editor) => {
        mountedEditor = editor;
      },
      onBoardChange,
      onNormalizedBoardChange: onNormalizedChange
    });

    await act(async () => {
      handle.mount(container);
    });

    expect(container.querySelector("[data-whiteboard-canvas='true']")).not.toBeNull();
    expect(handle.getAdapter()).toBe(adapter);
    expect(mountedEditor).not.toBeNull();
    expect(mountedEditor).toBeInstanceOf(RealTldrawEditorBridge);
    expect(adapter.getEditor()).toBe(mountedEditor);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("exercises real DOM pointer and user events on the mounted canvas", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const normalizedChanges: NormalizedStudentShapeChange[] = [];

    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => {
        normalizedChanges.push(change);
      }
    });

    await act(async () => {
      handle.mount(container);
    });

    const bridge = requireRealTldrawBridge(handle);
    expect(bridge).toBeInstanceOf(RealTldrawEditorBridge);
    const canvasElement = container.querySelector("[data-whiteboard-canvas='true']");
    expect(canvasElement).not.toBeNull();

    // Dispatch real DOM pointer events
    await act(async () => {
      canvasElement?.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        pointerType: "mouse"
      }));

      canvasElement?.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 200,
        clientY: 200,
        pointerId: 1,
        pointerType: "mouse"
      }));

      canvasElement?.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 200,
        clientY: 200,
        pointerId: 1,
        pointerType: "mouse"
      }));
    });

    // Create a student shape through the adapter simulating student interaction
    let studentShape: ReturnType<typeof adapter.createStudentShape> | undefined;
    await act(async () => {
      studentShape = adapter.createStudentShape({
        type: "geo",
        x: 50,
        y: 50,
        props: { geo: "rectangle", text: "Student Box" }
      });
    });

    expect(studentShape).toBeDefined();
    expect(studentShape?.meta?.["layer"]).toBe("STUDENT");
    expect(studentShape?.meta?.["origin"]).toBe("STUDENT");

    // Add an AI overlay annotation and verify protection
    const action: BoardAction = {
      operation: "circle",
      layer: "AI_ANNOTATION",
      annotationPurpose: "highlight clique candidate",
      targetShapeId: studentShape?.id
    };

    await act(async () => {
      await adapter.applyAiOverlayAction(action);
    });

    const snapshot = adapter.getCanvasSnapshot();
    expect(snapshot.studentShapes.length).toBeGreaterThanOrEqual(1);
    expect(snapshot.aiAnnotations.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });


  it("counts direct multi-shape create, update, and delete transactions once each", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const handle = createWhiteboardCanvasMount({
      adapter,
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const firstId = createShapeId("multi-first");
    const secondId = createShapeId("multi-second");
    await act(async () => {
      bridge.getNativeEditor().run(() => {
        bridge.getNativeEditor().createShapes([
          {
            id: firstId,
            type: "geo",
            x: 10,
            y: 10,
            props: { geo: "rectangle", w: 20, h: 20 }
          },
          {
            id: secondId,
            type: "geo",
            x: 40,
            y: 40,
            props: { geo: "rectangle", w: 20, h: 20 }
          }
        ]);
      });
    });
    expect(adapter.getBoardRevision()).toBe(1);
    expect(bridge.getShape(firstId)?.meta?.["shapeRevision"]).toBe(1);
    expect(bridge.getShape(secondId)?.meta?.["shapeRevision"]).toBe(1);

    await act(async () => {
      bridge.getNativeEditor().run(() => {
        bridge.getNativeEditor().updateShapes([
          { id: firstId, type: "geo", x: 15 },
          { id: secondId, type: "geo", x: 45 }
        ]);
      });
    });
    expect(adapter.getBoardRevision()).toBe(2);
    expect(bridge.getShape(firstId)?.meta?.["shapeRevision"]).toBe(2);
    expect(bridge.getShape(secondId)?.meta?.["shapeRevision"]).toBe(2);

    await act(async () => {
      bridge.getNativeEditor().run(() => {
        bridge.getNativeEditor().deleteShapes([firstId, secondId]);
      });
    });
    expect(adapter.getBoardRevision()).toBe(3);
    expect(bridge.getShape(firstId)).toBeUndefined();
    expect(bridge.getShape(secondId)).toBeUndefined();

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("advances board and shape revisions through undo and redo without ABA regression", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const handle = createWhiteboardCanvasMount({
      adapter,
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const id = createShapeId("undo-redo");
    await act(async () => {
      bridge.getNativeEditor().createShapes([{
        id,
        type: "geo",
        x: 10,
        y: 10,
        props: { geo: "rectangle", w: 20, h: 20 }
      }]);
    });
    expect(adapter.getBoardRevision()).toBe(1);
    expect(bridge.getShape(id)?.meta?.["shapeRevision"]).toBe(1);

    bridge.getNativeEditor().markHistoryStoppingPoint("before whiteboard move");
    await act(async () => {
      bridge.getNativeEditor().updateShapes([{ id, type: "geo", x: 100 }]);
    });
    expect(adapter.getBoardRevision()).toBe(2);
    expect(bridge.getShape(id)?.x).toBe(100);
    expect(bridge.getShape(id)?.meta?.["shapeRevision"]).toBe(2);

    await act(async () => {
      bridge.getNativeEditor().undo();
    });
    expect(adapter.getBoardRevision()).toBe(3);
    expect(bridge.getShape(id)?.x).toBe(10);
    expect(bridge.getShape(id)?.meta?.["shapeRevision"]).toBe(3);

    await act(async () => {
      bridge.getNativeEditor().redo();
    });
    expect(adapter.getBoardRevision()).toBe(4);
    expect(bridge.getShape(id)?.x).toBe(100);
    expect(bridge.getShape(id)?.meta?.["shapeRevision"]).toBe(4);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("uses real tldraw readonly mode to block student document mutation", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const handle = createWhiteboardCanvasMount({
      adapter,
      readOnly: true,
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);
    expect(bridge.getNativeEditor().getIsReadonly()).toBe(true);

    const id = createShapeId("readonly-create");
    await act(async () => {
      bridge.getNativeEditor().createShapes([{
        id,
        type: "geo",
        x: 10,
        y: 10,
        props: { geo: "rectangle", w: 20, h: 20 }
      }]);
    });

    expect(bridge.getShape(id)).toBeUndefined();
    expect(adapter.getBoardRevision()).toBe(0);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("preserves BoardRevision across unmount and remount without duplicate listeners", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const changes: NormalizedStudentShapeChange[] = [];
    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => changes.push(change)
    });

    await act(async () => {
      handle.mount(container);
    });
    let bridge = requireRealTldrawBridge(handle);
    const firstBridge = bridge;
    const firstId = createShapeId("before-remount");
    await act(async () => {
      firstBridge.getNativeEditor().createShapes([{
        id: firstId,
        type: "geo",
        x: 10,
        y: 10,
        props: { geo: "rectangle", w: 20, h: 20 }
      }]);
    });
    expect(adapter.getBoardRevision()).toBe(1);
    expect(changes).toHaveLength(1);

    await act(async () => {
      handle.unmount();
    });
    expect(adapter.getEditor()).toBeNull();
    expect(adapter.getBoardRevision()).toBe(1);

    await act(async () => {
      handle.mount(container);
    });
    bridge = requireRealTldrawBridge(handle);
    expect(bridge).not.toBe(firstBridge);
    expect(adapter.getBoardRevision()).toBe(1);

    const secondId = createShapeId("after-remount");
    await act(async () => {
      bridge.getNativeEditor().createShapes([{
        id: secondId,
        type: "geo",
        x: 30,
        y: 30,
        props: { geo: "rectangle", w: 20, h: 20 }
      }]);
    });
    expect(adapter.getBoardRevision()).toBe(2);
    expect(changes).toHaveLength(2);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("classifies one real editor transaction identically for every normalized subscriber", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const firstChanges: NormalizedStudentShapeChange[] = [];
    const secondChanges: NormalizedStudentShapeChange[] = [];

    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => {
        firstChanges.push(change);
      }
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const unlistenThrowing = bridge.subscribeToNormalizedStudentChanges(() => {
      throw new Error("observer failure must not own editor mutation");
    });
    const unlistenSecond = bridge.subscribeToNormalizedStudentChanges((change) => {
      secondChanges.push(change);
    });

    await act(async () => {
      adapter.createStudentShape({
        id: "shape:multi-subscriber",
        type: "geo",
        x: 40,
        y: 50,
        props: { geo: "rectangle", text: "before" }
      });
    });

    const created = bridge.getShape("shape:multi-subscriber");
    if (created === undefined) throw new Error("Student shape was not created");
    expect(adapter.getBoardRevision()).toBe(1);
    expect(firstChanges.at(-1)?.source).toBe("ADAPTER");
    expect(secondChanges.at(-1)?.source).toBe("ADAPTER");

    await act(async () => {
      adapter.updateStudentShape("shape:multi-subscriber", {
        props: { text: "after" }
      });
    });

    expect(adapter.getBoardRevision()).toBe(2);
    expect(firstChanges.at(-1)?.source).toBe("ADAPTER");
    expect(secondChanges.at(-1)?.source).toBe("ADAPTER");
    expect(
      adapter.getCanvasSnapshot().studentShapes.find(
        (shape) => shape.id === "shape:multi-subscriber"
      )?.text
    ).toBe("after");

    const beforeNoOp = adapter.getBoardRevision();
    await act(async () => {
      adapter.updateStudentShape("shape:multi-subscriber", {
        x: created.x,
        y: created.y,
        props: { text: "after" }
      });
    });
    expect(adapter.getBoardRevision()).toBe(beforeNoOp);

    unlistenThrowing();
    unlistenSecond();
    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("classifies a mixed adapter-and-editor student transaction as editor-originated", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const changes: NormalizedStudentShapeChange[] = [];
    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => changes.push(change)
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const directId = createShapeId("mixed-direct");
    await act(async () => {
      bridge.getNativeEditor().run(() => {
        adapter.createStudentShape({
          id: "shape:mixed-adapter",
          type: "geo",
          x: 10,
          y: 10,
          props: { geo: "rectangle", w: 20, h: 20 }
        });
        bridge.getNativeEditor().createShapes([{
          id: directId,
          type: "geo",
          x: 40,
          y: 40,
          props: { geo: "rectangle", w: 20, h: 20 }
        }]);
      });
    });

    const mixed = changes.find((change) => {
      const ids = new Set(change.added.map((shape) => shape.id));
      return ids.has("shape:mixed-adapter") && ids.has(directId);
    });
    expect(mixed?.source).toBe("EDITOR");
    expect(adapter.getBoardRevision()).toBe(2);
    expect(bridge.getShape("shape:mixed-adapter")?.meta?.["shapeRevision"]).toBe(1);
    expect(bridge.getShape(directId)?.meta?.["shapeRevision"]).toBe(1);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("blocks native user edits that would overflow shape revision and hides provenance metadata", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const changes: NormalizedStudentShapeChange[] = [];
    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => changes.push(change)
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const nativeId = createShapeId("max-revision");
    await act(async () => {
      adapter.createStudentShape({
        id: nativeId,
        type: "geo",
        x: 20,
        y: 30,
        props: { geo: "rectangle", w: 40, h: 50 },
        shapeRevision: Number.MAX_SAFE_INTEGER
      });
    });

    const before = bridge.getShape(nativeId);
    expect(before?.meta?.["shapeRevision"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(Object.keys(before?.meta ?? {}).some((key) => key.includes("interviewAdapterStudentMutation")))
      .toBe(false);
    const boardRevision = adapter.getBoardRevision();
    const changeCount = changes.length;

    await act(async () => {
      bridge.getNativeEditor().updateShapes([{
        id: nativeId,
        type: "geo",
        x: 999
      }]);
    });

    const after = bridge.getShape(nativeId);
    expect(after?.x).toBe(before?.x);
    expect(after?.meta?.["shapeRevision"]).toBe(Number.MAX_SAFE_INTEGER);
    expect(adapter.getBoardRevision()).toBe(boardRevision);
    expect(changes).toHaveLength(changeCount);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("rejects direct native student mutation before exhausted BoardRevision can diverge", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const handle = createWhiteboardCanvasMount({
      adapter,
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    (adapter as unknown as { localBoardRevision: number }).localBoardRevision =
      Number.MAX_SAFE_INTEGER;
    const nativeId = createShapeId("board-revision-exhausted");

    await expect(
      act(async () => {
        bridge.getNativeEditor().createShapes([{
          id: nativeId,
          type: "geo",
          x: 10,
          y: 10,
          props: { geo: "rectangle", w: 20, h: 20 }
        }]);
      })
    ).rejects.toThrow(/BoardRevision/u);

    expect(bridge.getShape(nativeId)).toBeUndefined();
    expect(adapter.getBoardRevision()).toBe(Number.MAX_SAFE_INTEGER);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("keeps legacy locked untagged shapes protected from native user edits and deletion", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const handle = createWhiteboardCanvasMount({ adapter });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);
    const nativeEditor = bridge.getNativeEditor();
    const legacyId = createShapeId("legacy-locked-untagged");

    await act(async () => {
      nativeEditor.createShapes([{
        id: legacyId,
        type: "geo",
        x: 25,
        y: 35,
        props: { geo: "rectangle", w: 40, h: 30 }
      }]);
    });

    const seeded = nativeEditor.getShape(legacyId);
    if (seeded === undefined) throw new Error("Failed to seed legacy-shape fixture");

    await act(async () => {
      nativeEditor.store.mergeRemoteChanges(() => {
        nativeEditor.store.put([{
          ...seeded,
          isLocked: true,
          meta: {}
        }]);
      });
    });

    const legacy = nativeEditor.getShape(legacyId);
    if (legacy === undefined) throw new Error("Legacy-shape fixture disappeared");
    expect(legacy.isLocked).toBe(true);
    expect(legacy.meta["layer"]).toBeUndefined();

    const beforeRevision = adapter.getBoardRevision();
    await act(async () => {
      nativeEditor.run(() => {
        nativeEditor.updateShapes([{
          id: legacyId,
          type: "geo",
          x: 999
        }]);
        nativeEditor.deleteShapes([legacyId]);
      }, { ignoreShapeLock: true });
    });

    const after = nativeEditor.getShape(legacyId);
    expect(after).toBeDefined();
    expect(after?.x).toBe(legacy.x);
    expect(after?.isLocked).toBe(true);
    expect(after?.meta["layer"]).toBeUndefined();
    expect(adapter.getBoardRevision()).toBe(beforeRevision);

    expect(bridge.getShape(legacyId)?.meta?.["layer"]).toBe("SYSTEM_DECORATION");
    await act(async () => {
      await adapter.clearAiOverlay();
    });
    expect(nativeEditor.getShape(legacyId)).toBeDefined();
    expect(adapter.getBoardRevision()).toBe(beforeRevision);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("tags native user shapes and blocks native deletion of protected layers", async () => {
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const adapter = new TldrawWhiteboardAdapter();
    const normalizedChanges: NormalizedStudentShapeChange[] = [];
    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => normalizedChanges.push(change)
    });

    await act(async () => {
      handle.mount(container);
    });
    const bridge = requireRealTldrawBridge(handle);

    const studentId = createShapeId("native-student");
    await act(async () => {
      bridge.getNativeEditor().createShapes([{
        id: studentId,
        type: "geo",
        x: 100,
        y: 120,
        props: { geo: "rectangle", w: 120, h: 80 }
      }]);
    });

    const student = bridge.getShape(studentId);
    expect(student?.meta?.["layer"]).toBe("STUDENT");
    expect(student?.meta?.["origin"]).toBe("STUDENT");
    expect(student?.isLocked).toBe(false);
    expect(student?.meta?.["shapeRevision"]).toBe(1);
    expect(normalizedChanges.at(-1)?.source).toBe("EDITOR");
    expect(adapter.getBoardRevision()).toBe(1);

    await act(async () => {
      await adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        annotationPurpose: "protect this annotation",
        targetShapeId: studentId,
        expectedShapeRevision: 1
      });
    });
    const aiId = adapter.getCanvasSnapshot().aiAnnotations.at(-1)?.id;
    if (aiId === undefined) throw new Error("AI annotation was not created");
    expect(bridge.getShape(aiId)?.isLocked).toBe(true);

    const revisionBeforeProtectedPartial = adapter.getBoardRevision();
    const aiBeforePartial = bridge.getShape(aiId);
    await act(async () => {
      bridge.updateShapes([{
        id: aiId,
        x: (aiBeforePartial?.x ?? 0) + 5
      }]);
    });
    expect(bridge.getShape(aiId)?.meta?.["layer"]).toBe("AI_ANNOTATION");
    expect(bridge.getShape(aiId)?.meta?.["origin"]).toBe("AI");
    expect(bridge.getShape(aiId)?.meta?.["shapeRevision"]).toBe(1);
    expect(bridge.getShape(aiId)?.isLocked).toBe(true);
    expect(adapter.getBoardRevision()).toBe(revisionBeforeProtectedPartial);

    expect(() => bridge.updateShapes([{
      id: studentId,
      meta: {
        layer: "AI_ANNOTATION",
        origin: "AI"
      }
    }])).toThrow(/ownership layer cannot change/u);
    expect(bridge.getShape(studentId)?.meta?.["layer"]).toBe("STUDENT");

    expect(() => bridge.updateShapes([{
      id: aiId,
      meta: {
        layer: "STUDENT",
        origin: "STUDENT"
      }
    }])).toThrow(/ownership layer cannot change/u);
    expect(bridge.getShape(aiId)?.meta?.["layer"]).toBe("AI_ANNOTATION");

    expect(() => bridge.createShapes([{
      id: "shape:invalid-layer",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", w: 10, h: 10 },
      meta: {
        layer: "UNKNOWN_LAYER",
        origin: "STUDENT"
      }
    }])).toThrow(/invalid ownership layer/u);
    expect(bridge.getShape("shape:invalid-layer")).toBeUndefined();

    expect(() => bridge.createShapes([{
      id: "shape:mismatched-origin",
      type: "geo",
      x: 0,
      y: 0,
      props: { geo: "rectangle", w: 10, h: 10 },
      meta: {
        layer: "AI_ANNOTATION",
        origin: "STUDENT"
      }
    }])).toThrow(/origin does not match/u);
    expect(bridge.getShape("shape:mismatched-origin")).toBeUndefined();

    const implicitSystemId = createShapeId("system-decoration-implicit-origin");
    await act(async () => {
      bridge.createShapes([{
        id: implicitSystemId,
        type: "geo",
        x: 5,
        y: 5,
        isLocked: true,
        props: { geo: "rectangle", w: 10, h: 10 },
        meta: {
          layer: "SYSTEM_DECORATION",
          shapeRevision: 1,
          createdAt: "2026-08-30T00:00:00.000Z"
        }
      }]);
    });
    expect(bridge.getShape(implicitSystemId)?.meta?.["layer"]).toBe("SYSTEM_DECORATION");
    expect(bridge.getShape(implicitSystemId)?.meta?.["origin"]).toBe("SYSTEM");

    const systemId = createShapeId("system-decoration");
    await act(async () => {
      bridge.createShapes([{
        id: systemId,
        type: "geo",
        x: 10,
        y: 10,
        isLocked: true,
        props: { geo: "rectangle", w: 20, h: 20 },
        meta: {
          layer: "SYSTEM_DECORATION",
          origin: "SYSTEM",
          shapeRevision: 1,
          createdAt: "2026-08-30T00:00:00.000Z"
        }
      }]);
    });

    const systemBeforePartial = bridge.getShape(systemId);
    await act(async () => {
      bridge.updateShapes([{
        id: systemId,
        x: (systemBeforePartial?.x ?? 0) + 5
      }]);
    });
    expect(bridge.getShape(systemId)?.meta?.["layer"]).toBe("SYSTEM_DECORATION");
    expect(bridge.getShape(systemId)?.meta?.["origin"]).toBe("SYSTEM");
    expect(bridge.getShape(systemId)?.meta?.["shapeRevision"]).toBe(1);
    expect(bridge.getShape(systemId)?.isLocked).toBe(true);

    const beforeProtectedDelete = adapter.getBoardRevision();
    await act(async () => {
      bridge.getNativeEditor().deleteShapes([
        createShapeId(aiId.replace(/^shape:/u, "")),
        systemId
      ]);
    });
    expect(bridge.getShape(aiId)).toBeDefined();
    expect(bridge.getShape(systemId)).toBeDefined();
    expect(adapter.getBoardRevision()).toBe(beforeProtectedDelete);

    const aiBeforeUpdate = bridge.getShape(aiId);
    const systemBeforeUpdate = bridge.getShape(systemId);
    const nativeAiId = createShapeId(aiId.replace(/^shape:/u, ""));
    const nativeAiBeforeUpdate = bridge.getNativeEditor().getShape(nativeAiId);
    const nativeSystemBeforeUpdate = bridge.getNativeEditor().getShape(systemId);
    if (nativeAiBeforeUpdate === undefined || nativeSystemBeforeUpdate === undefined) {
      throw new Error("Protected native shapes disappeared before update test");
    }
    await act(async () => {
      bridge.getNativeEditor().updateShapes([
        {
          id: nativeAiId,
          type: nativeAiBeforeUpdate.type,
          x: 999
        },
        {
          id: systemId,
          type: nativeSystemBeforeUpdate.type,
          x: 999
        }
      ]);
    });
    expect(bridge.getShape(aiId)?.x).toBe(aiBeforeUpdate?.x);
    expect(bridge.getShape(systemId)?.x).toBe(systemBeforeUpdate?.x);
    expect(adapter.getBoardRevision()).toBe(beforeProtectedDelete);

    await expect(adapter.applyAiOverlayAction({
      operation: "erase_ai_annotation",
      layer: "AI_ANNOTATION",
      annotationPurpose: "must not erase student work",
      targetShapeId: studentId,
      expectedShapeRevision: 1
    })).rejects.toThrow(/Refusing to erase shape/u);
    expect(bridge.getShape(studentId)).toBeDefined();
    expect(adapter.getBoardRevision()).toBe(beforeProtectedDelete);

    await act(async () => {
      handle.unmount();
    });
    container.remove();
  });

  it("routes a real mounted tldraw student mutation into authoritative BoardRevision exactly once", async () => {
    const store = new SqliteEventStore(":memory:");
    const container = document.createElement("div");
    container.style.width = "800px";
    container.style.height = "600px";
    document.body.appendChild(container);

    const sessionId = newSessionId();
    const registry = new SessionRuntimeRegistry(store);
    const writer = registry.get(sessionId);
    const turns = new TurnCoordinator(writer);
    await turns.startSession(sixPeopleProblem);

    type SyncClient = ConstructorParameters<typeof AuthoritativeBoardSyncCoordinator>[0];
    const syncClient: SyncClient = {
      getBoardState: async (_targetSessionId, options) => {
        const state = writer.getState();
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_STATE",
          requestId: options?.requestId ?? newRequestId(),
          sessionId,
          boardRevision: state.boardRevision,
          shapeAuthorityKnown: state.boardShapeAuthorityKnown,
          shapeRevisions: Object.values(state.boardShapes)
            .map((shape) => ({
              shapeId: shape.id,
              revision: shape.revision,
              contentSha256: createHash("sha256")
                .update(authoritativeBoardShapeCanonicalJson(shape), "utf8")
                .digest("hex")
            }))
            .sort((left, right) => left.shapeId.localeCompare(right.shapeId))
        };
      },
      commitBoardMutation: async (_targetSessionId, mutation, options) => {
        const requestId = options?.requestId ?? newRequestId();
        const committed = await turns.commitBoardMutation(
          mutation,
          createCommandEnvelope({
            sessionId,
            producer: "mounted-whiteboard-test",
            requestId
          })
        );
        return {
          protocolVersion: 1,
          ok: true,
          type: "BOARD_MUTATION_COMMITTED",
          requestId,
          sessionId,
          committed: committed.committed,
          boardRevision: committed.boardRevision,
          ...(committed.reason === undefined ? {} : { reason: committed.reason })
        };
      }
    };

    const sync = new AuthoritativeBoardSyncCoordinator(syncClient);
    const adapter = new TldrawWhiteboardAdapter();
    const pendingMutations: Promise<void>[] = [];
    let authoritativeBridgeEnabled = false;
    const handle = createWhiteboardCanvasMount({
      adapter,
      onNormalizedBoardChange: (change) => {
        if (authoritativeBridgeEnabled) {
          pendingMutations.push(sync.submit(change));
        }
      }
    });

    try {
      await act(async () => {
        handle.mount(container);
      });
      const bridge = requireRealTldrawBridge(handle);
      await sync.synchronize(sessionId, adapter.getNormalizedStudentShapes());
      authoritativeBridgeEnabled = true;

      const studentId = createShapeId("authoritative-mounted-student");
      await act(async () => {
        bridge.getNativeEditor().createShapes([{
          id: studentId,
          type: "geo",
          x: 40,
          y: 50,
          props: { geo: "rectangle", w: 120, h: 80 }
        }]);
      });
      await Promise.all(pendingMutations.splice(0));

      expect(writer.getState().boardRevision).toBe(BoardRevisionSchema.parse(1));
      expect(writer.getState().boardShapes[studentId]?.revision).toBe(1);
      const boardEventsAfterCreate = store.load(sessionId)
        .filter((event) => event.type === "BOARD_PATCH_COMMITTED");
      expect(boardEventsAfterCreate).toHaveLength(1);

      await act(async () => {
        bridge.getNativeEditor().updateShapes([{
          id: studentId,
          type: "geo",
          x: 90
        }]);
      });
      await Promise.all(pendingMutations.splice(0));

      expect(writer.getState().boardRevision).toBe(BoardRevisionSchema.parse(2));
      expect(writer.getState().boardShapes[studentId]?.revision).toBe(2);
      const studentBeforeOverlay = bridge.getShape(studentId);

      await expect(adapter.applyAiOverlayAction({
        operation: "circle",
        layer: "AI_ANNOTATION",
        annotationPurpose: "stale mounted target must reject",
        targetShapeId: studentId,
        expectedShapeRevision: 1
      })).rejects.toThrow(/revision mismatch/u);
      expect(writer.getState().boardRevision).toBe(BoardRevisionSchema.parse(2));

      const acknowledgements: RendererAcknowledgementCommand[] = [];
      const renderer = new RendererClient({
        sessionId,
        acknowledgementSender: {
          send: async (command) => {
            acknowledgements.push(command);
          }
        },
        textPresenter: { presentText: () => undefined },
        audioPlayer: { playAudio: () => undefined },
        whiteboardPresenter: adapter,
        requestIdFactory: () => newRequestId()
      });
      const deliveryId = newDeliveryId();
      const message = RendererStreamMessageSchema.parse({
        protocolVersion: 1,
        type: "DELIVERY_COMMAND",
        command: {
          deliveryId,
          content: {
            medium: "WHITEBOARD",
            action: {
              operation: "circle",
              layer: "AI_ANNOTATION",
              annotationPurpose: "authorized mounted overlay",
              targetShapeId: studentId,
              expectedShapeRevision: 2
            }
          }
        }
      });

      await act(async () => {
        const first = await renderer.handleMessage(message);
        expect(first.duplicate).toBe(false);
      });
      const annotationAfterFirstDelivery = adapter.getCanvasSnapshot().aiAnnotations;
      expect(annotationAfterFirstDelivery).toHaveLength(1);
      expect(acknowledgements.map((command) => command.type)).toEqual([
        "ACK_DELIVERY_EXPOSED",
        "ACK_DELIVERY_COMPLETED"
      ]);

      await act(async () => {
        const reconnectDuplicate = await renderer.handleMessage(message);
        expect(reconnectDuplicate.duplicate).toBe(true);
      });

      expect(writer.getState().boardRevision).toBe(BoardRevisionSchema.parse(2));
      expect(bridge.getShape(studentId)).toEqual(studentBeforeOverlay);
      expect(adapter.getCanvasSnapshot().aiAnnotations)
        .toEqual(annotationAfterFirstDelivery);
      expect(acknowledgements.map((command) => command.type)).toEqual([
        "ACK_DELIVERY_EXPOSED",
        "ACK_DELIVERY_COMPLETED"
      ]);
      expect(store.load(sessionId)
        .filter((event) => event.type === "BOARD_PATCH_COMMITTED"))
        .toHaveLength(2);
    } finally {
      sync.reset();
      await act(async () => {
        handle.unmount();
      });
      container.remove();
      store.close();
    }
  });

});
