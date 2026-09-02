import {
  BoardActionSchema,
  WhiteboardLayerSchema,
  type BoardAction,
  type WhiteboardAdapter,
  type WhiteboardLayer,
  type DeliveryId
} from "../../../packages/domain/src/index.js";
import type { WhiteboardPresenter } from "./renderer-client.js";
import {
  normalizeStudentShape,
  type NormalizedStudentMutationSource
} from "./whiteboard/normalized-board.js";
import type { StudentShape } from "../../../packages/whiteboard/src/index.js";

export class StudentShapeImmutableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StudentShapeImmutableError";
  }
}

export class StaleShapeRevisionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StaleShapeRevisionError";
  }
}

export class UnsupportedBoardActionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedBoardActionError";
  }
}

export interface CanvasShapeMeta {
  readonly layer: WhiteboardLayer;
  readonly shapeRevision: number;
  readonly origin: "STUDENT" | "AI" | "SYSTEM";
  readonly deliveryId?: DeliveryId;
  readonly turnId?: string;
  readonly generationId?: string;
  readonly targetShapeId?: string;
  readonly targetShapeRevision?: number;
  readonly annotationPurpose?: string;
  readonly operation?: string;
  readonly isEquation?: boolean;
  readonly createdAt: string;
  readonly lastModifiedAt?: string;
}

export interface TLShapeBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly minX?: number;
  readonly minY?: number;
  readonly maxX?: number;
  readonly maxY?: number;
}

export interface TLShapeRecord {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly rotation?: number;
  readonly isLocked?: boolean;
  readonly opacity?: number;
  readonly props?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface TLShapePartialRecord {
  readonly id: string;
  readonly type?: string;
  readonly x?: number;
  readonly y?: number;
  readonly rotation?: number;
  readonly isLocked?: boolean;
  readonly opacity?: number;
  readonly props?: Record<string, unknown>;
  readonly meta?: Record<string, unknown>;
}

export interface TldrawEditor {
  getShape: (id: string) => TLShapeRecord | undefined;
  getCurrentPageShapes: () => readonly TLShapeRecord[];
  createShapes: (shapes: readonly TLShapePartialRecord[]) => void;
  deleteShapes: (ids: readonly string[]) => void;
  updateShapes: (shapes: readonly TLShapePartialRecord[]) => void;
  getShapePageBounds?: (id: string | TLShapeRecord) => TLShapeBounds | undefined;
  store?: {
    listen?: (listener: (entry: unknown) => void) => () => void;
    allRecords?: () => readonly unknown[];
  };
}

export interface CanvasSnapshot {
  readonly boardRevision: number;
  readonly studentShapes: readonly {
    readonly id: string;
    readonly type: string;
    readonly bounds: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
    readonly text?: string;
    readonly shapeRevision: number;
  }[];
  readonly aiAnnotations: readonly {
    readonly id: string;
    readonly operation: string;
    readonly deliveryId?: string;
    readonly purpose: string;
    readonly targetShapeId?: string;
    readonly targetShapeRevision?: number;
  }[];
}

export interface DirtyRegion {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
  readonly shapeIds: readonly string[];
}

export interface ApplyAiOverlayOptions {
  readonly deliveryId?: DeliveryId;
  readonly turnId?: string;
  readonly generationId?: string;
}

/** Headless editor used by adapter unit tests only; the browser surface uses real tldraw. */
export class InMemoryTldrawEditor implements TldrawEditor {
  private readonly shapes = new Map<string, TLShapeRecord>();
  public store?: {
    listen?: (listener: (entry: unknown) => void) => () => void;
    allRecords?: () => readonly unknown[];
  };

  public getShape(id: string): TLShapeRecord | undefined {
    return this.shapes.get(id);
  }

  public getCurrentPageShapes(): readonly TLShapeRecord[] {
    return Array.from(this.shapes.values());
  }

  public createShapes(shapes: readonly TLShapePartialRecord[]): void {
    for (const shape of shapes) {
      const record: TLShapeRecord = {
        id: shape.id,
        type: shape.type ?? "geo",
        x: shape.x ?? 0,
        y: shape.y ?? 0,
        props: shape.props ? { ...shape.props } : {},
        meta: shape.meta ? { ...shape.meta } : {},
        ...(shape.rotation !== undefined ? { rotation: shape.rotation } : {}),
        ...(shape.isLocked !== undefined ? { isLocked: shape.isLocked } : {}),
        ...(shape.opacity !== undefined ? { opacity: shape.opacity } : {})
      };
      this.shapes.set(shape.id, record);
    }
  }

  public deleteShapes(ids: readonly string[]): void {
    for (const id of ids) {
      this.shapes.delete(id);
    }
  }

  public updateShapes(shapes: readonly TLShapePartialRecord[]): void {
    for (const update of shapes) {
      const existing = this.shapes.get(update.id);
      if (existing === undefined) continue;

      const rotation = update.rotation !== undefined ? update.rotation : existing.rotation;
      const isLocked = update.isLocked !== undefined ? update.isLocked : existing.isLocked;
      const opacity = update.opacity !== undefined ? update.opacity : existing.opacity;

      const updated: TLShapeRecord = {
        id: existing.id,
        type: update.type ?? existing.type,
        x: update.x ?? existing.x,
        y: update.y ?? existing.y,
        props: { ...existing.props, ...update.props },
        meta: { ...existing.meta, ...update.meta },
        ...(rotation !== undefined ? { rotation } : {}),
        ...(isLocked !== undefined ? { isLocked } : {}),
        ...(opacity !== undefined ? { opacity } : {})
      };
      this.shapes.set(update.id, updated);
    }
  }

  public getShapePageBounds(idOrShape: string | TLShapeRecord): TLShapeBounds | undefined {
    const shape = typeof idOrShape === "string" ? this.shapes.get(idOrShape) : idOrShape;
    if (shape === undefined) return undefined;

    const props = shape.props ?? {};
    const w = typeof props["w"] === "number" ? props["w"] : typeof props["width"] === "number" ? props["width"] : 100;
    const h = typeof props["h"] === "number" ? props["h"] : typeof props["height"] === "number" ? props["height"] : 100;
    const x = shape.x;
    const y = shape.y;

    return {
      x,
      y,
      width: w,
      height: h,
      minX: x,
      minY: y,
      maxX: x + w,
      maxY: y + h
    };
  }
}

export class TldrawWhiteboardAdapter implements WhiteboardAdapter, WhiteboardPresenter {
  private editor: TldrawEditor | null;
  private localBoardRevision = 0;

  public constructor(editor?: TldrawEditor | null) {
    this.editor = editor ?? null;
  }

  public attachEditor(editor: TldrawEditor): void {
    this.editor = editor;
  }

  public detachEditor(): void {
    this.editor = null;
  }

  public getEditor(): TldrawEditor | null {
    return this.editor;
  }

  public getBoardRevision(): number {
    return this.localBoardRevision;
  }

  /**
   * Records one normalized student mutation observed from the real editor.
   * Adapter-originated mutations are already counted by create/update methods;
   * direct editor transactions advance the sole BoardRevision authority once.
   */
  public observeNormalizedStudentMutation(source: NormalizedStudentMutationSource): void {
    if (source === "ADAPTER") return;
    this.advanceBoardRevision();
  }

  public async presentWhiteboard(action: BoardAction, deliveryId: DeliveryId): Promise<void> {
    await this.applyAiOverlayAction(action, { deliveryId });
  }

  public async applyAiOverlayAction(action: BoardAction, options?: ApplyAiOverlayOptions): Promise<void> {
    const validatedAction = BoardActionSchema.parse(action);
    const editor = this.requireEditor();

    if (validatedAction.expectedShapeRevision !== undefined || validatedAction.targetShapeId !== undefined) {
      this.validateTargetRevision(editor, validatedAction);
    }

    switch (validatedAction.operation) {
      case "circle":
        this.renderCircleOverlay(editor, validatedAction, options);
        break;
      case "highlight":
        this.renderHighlightOverlay(editor, validatedAction, options);
        break;
      case "draw_arrow":
        this.renderArrowOverlay(editor, validatedAction, options);
        break;
      case "point_at":
        this.renderPointAtOverlay(editor, validatedAction, options);
        break;
      case "write_text":
        this.renderWriteTextOverlay(editor, validatedAction, options);
        break;
      case "write_equation":
        this.renderWriteEquationOverlay(editor, validatedAction, options);
        break;
      case "erase_ai_annotation":
        this.executeEraseAiAnnotation(editor, validatedAction);
        break;
      default:
        throw new UnsupportedBoardActionError(
          `Unsupported whiteboard action operation: ${String((validatedAction as { operation?: string }).operation)}`
        );
    }
  }

  public async clearAiOverlay(): Promise<void> {
    const editor = this.requireEditor();
    const shapes = editor.getCurrentPageShapes();
    const aiShapeIds: string[] = [];

    for (const shape of shapes) {
      const layer = shape.meta?.["layer"];
      if (layer === "AI_ANNOTATION") {
        aiShapeIds.push(shape.id);
      }
    }

    if (aiShapeIds.length > 0) {
      editor.deleteShapes(aiShapeIds);
    }
  }

  public getNormalizedStudentShapes(): readonly StudentShape[] {
    const editor = this.requireEditor();
    const shapes: StudentShape[] = [];
    for (const shape of editor.getCurrentPageShapes()) {
      const layer = shape.meta?.["layer"];
      if (layer !== "STUDENT" && layer !== undefined) continue;
      const normalized = normalizeStudentShape(
        shape,
        this.resolveShapeBounds(editor, shape)
      );
      if (normalized !== null) shapes.push(normalized);
    }
    return shapes;
  }

  public getCanvasSnapshot(): CanvasSnapshot {
    const editor = this.requireEditor();
    const shapes = editor.getCurrentPageShapes();

    const studentShapes: CanvasSnapshot["studentShapes"][number][] = [];
    const aiAnnotations: CanvasSnapshot["aiAnnotations"][number][] = [];

    for (const shape of shapes) {
      const layer = shape.meta?.["layer"];
      if (layer === "STUDENT" || layer === undefined) {
        const bounds = this.resolveShapeBounds(editor, shape);
        const text = typeof shape.props?.["text"] === "string" ? shape.props["text"] : undefined;
        const shapeRevision = readShapeRevision(shape.meta?.["shapeRevision"], shape.id);
        studentShapes.push({
          id: shape.id,
          type: shape.type,
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          },
          ...(text !== undefined ? { text } : {}),
          shapeRevision
        });
      } else if (layer === "AI_ANNOTATION") {
        const operation = typeof shape.meta?.["operation"] === "string" ? shape.meta["operation"] : shape.type;
        const deliveryId = typeof shape.meta?.["deliveryId"] === "string" ? shape.meta["deliveryId"] : undefined;
        const purpose = typeof shape.meta?.["annotationPurpose"] === "string" ? shape.meta["annotationPurpose"] : "";
        const targetShapeId = typeof shape.meta?.["targetShapeId"] === "string" ? shape.meta["targetShapeId"] : undefined;
        const targetShapeRevision = readOptionalShapeRevision(
          shape.meta?.["targetShapeRevision"],
          shape.id,
          "targetShapeRevision"
        );
        aiAnnotations.push({
          id: shape.id,
          operation,
          ...(deliveryId !== undefined ? { deliveryId } : {}),
          purpose,
          ...(targetShapeId !== undefined ? { targetShapeId } : {}),
          ...(targetShapeRevision !== undefined ? { targetShapeRevision } : {})
        });
      }
    }

    return {
      boardRevision: this.localBoardRevision,
      studentShapes,
      aiAnnotations
    };
  }

  public computeDirtyRegion(modifiedShapeIds: readonly string[]): DirtyRegion | null {
    if (modifiedShapeIds.length === 0) return null;
    const editor = this.requireEditor();

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const validShapeIds: string[] = [];

    for (const id of modifiedShapeIds) {
      const shape = editor.getShape(id);
      if (shape === undefined) continue;
      const bounds = this.resolveShapeBounds(editor, shape);
      minX = Math.min(minX, bounds.x);
      minY = Math.min(minY, bounds.y);
      maxX = Math.max(maxX, bounds.x + bounds.width);
      maxY = Math.max(maxY, bounds.y + bounds.height);
      validShapeIds.push(id);
    }

    if (validShapeIds.length === 0) return null;

    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(0, maxX - minX),
      height: Math.max(0, maxY - minY),
      shapeIds: validShapeIds
    };
  }

  public createStudentShape(shape: {
    readonly id?: string;
    readonly type: string;
    readonly x: number;
    readonly y: number;
    readonly props?: Record<string, unknown>;
    readonly shapeRevision?: number;
  }): TLShapeRecord {
    const editor = this.requireEditor();
    const shapeId = shape.id ?? `shape:student_${generateId()}`;
    if (editor.getShape(shapeId) !== undefined) {
      throw new Error(`Student shape ${shapeId} already exists`);
    }
    const revision = shape.shapeRevision ?? 1;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new Error("Student shape revision must be a positive safe integer");
    }
    if (!Number.isFinite(shape.x) || !Number.isFinite(shape.y)) {
      throw new Error("Student shape coordinates must be finite numbers");
    }
    this.assertStudentMutationCanAdvance();
    const now = new Date().toISOString();

    const meta: CanvasShapeMeta = {
      layer: "STUDENT",
      shapeRevision: revision,
      origin: "STUDENT",
      createdAt: now,
      lastModifiedAt: now
    };

    const newShape: TLShapePartialRecord = {
      id: shapeId,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      props: shape.props ? { ...shape.props } : {},
      meta: { ...meta }
    };

    editor.createShapes([newShape]);

    const created = editor.getShape(shapeId);
    if (created === undefined) {
      throw new Error(`Failed to create student shape ${shapeId}`);
    }
    this.advanceBoardRevision();
    return created;
  }

  public updateStudentShape(
    shapeId: string,
    updates: {
      readonly x?: number;
      readonly y?: number;
      readonly props?: Record<string, unknown>;
    }
  ): TLShapeRecord {
    const editor = this.requireEditor();
    const existing = editor.getShape(shapeId);
    if (existing === undefined) {
      throw new Error(`Student shape ${shapeId} not found`);
    }

    const currentLayer = existing.meta?.["layer"];
    if (currentLayer !== "STUDENT" && currentLayer !== undefined) {
      throw new Error(`Shape ${shapeId} is not a student-owned shape`);
    }

    if (
      (updates.x !== undefined && !Number.isFinite(updates.x))
      || (updates.y !== undefined && !Number.isFinite(updates.y))
    ) {
      throw new Error("Student shape coordinates must be finite numbers");
    }

    const hasCoordinateChange =
      (updates.x !== undefined && updates.x !== existing.x)
      || (updates.y !== undefined && updates.y !== existing.y);
    const hasPropsChange = updates.props !== undefined
      && Object.entries(updates.props).some(([key, value]) => !Object.is(existing.props?.[key], value));
    if (!hasCoordinateChange && !hasPropsChange) {
      return existing;
    }

    const currentRevision = readShapeRevision(existing.meta?.["shapeRevision"], shapeId);
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Student shape revision cannot exceed Number.MAX_SAFE_INTEGER");
    }
    const nextRevision = currentRevision + 1;
    this.assertStudentMutationCanAdvance();
    const now = new Date().toISOString();

    const updatedMeta = {
      ...existing.meta,
      layer: "STUDENT",
      shapeRevision: nextRevision,
      origin: "STUDENT",
      createdAt: typeof existing.meta?.["createdAt"] === "string" ? existing.meta["createdAt"] : now,
      lastModifiedAt: now
    };

    editor.updateShapes([
      {
        id: shapeId,
        ...(updates.x !== undefined ? { x: updates.x } : {}),
        ...(updates.y !== undefined ? { y: updates.y } : {}),
        ...(updates.props !== undefined ? { props: updates.props } : {}),
        meta: updatedMeta
      }
    ]);

    const updated = editor.getShape(shapeId);
    if (updated === undefined) {
      throw new Error(`Failed to update student shape ${shapeId}`);
    }
    this.advanceBoardRevision();
    return updated;
  }

  public assertStudentMutationCanAdvance(): void {
    this.assertBoardRevisionCanAdvance();
  }

  private assertBoardRevisionCanAdvance(): void {
    if (
      !Number.isSafeInteger(this.localBoardRevision)
      || this.localBoardRevision < 0
      || this.localBoardRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("BoardRevision cannot exceed Number.MAX_SAFE_INTEGER");
    }
  }

  private advanceBoardRevision(): void {
    this.assertStudentMutationCanAdvance();
    this.localBoardRevision += 1;
  }

  private validateTargetRevision(editor: TldrawEditor, action: BoardAction): void {
    if (action.targetShapeId === undefined) {
      if (action.expectedShapeRevision !== undefined) {
        throw new StaleShapeRevisionError("expectedShapeRevision was specified without targetShapeId");
      }
      return;
    }

    const targetShape = editor.getShape(action.targetShapeId);
    if (targetShape === undefined) {
      throw new StaleShapeRevisionError(`Target shape "${action.targetShapeId}" not found`);
    }

    if (action.expectedShapeRevision !== undefined) {
      const actualRevision = readShapeRevision(
        targetShape.meta?.["shapeRevision"],
        targetShape.id
      );
      if (actualRevision !== action.expectedShapeRevision) {
        throw new StaleShapeRevisionError(
          `Target shape "${action.targetShapeId}" revision mismatch: expected ${String(action.expectedShapeRevision)}, got ${String(actualRevision)}`
        );
      }
    }
  }

  private renderCircleOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
    const padding = 12;
    const x = targetBounds.x - padding;
    const y = targetBounds.y - padding;
    const w = targetBounds.width + padding * 2;
    const h = targetBounds.height + padding * 2;

    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_circle");

    const circleShape: TLShapePartialRecord = {
      id: shapeId,
      type: "geo",
      x,
      y,
      props: {
        geo: "ellipse",
        color: "violet",
        dash: "dashed",
        fill: "none",
        size: "m",
        w,
        h,
        text: action.content ?? ""
      },
      meta: { ...meta }
    };

    editor.createShapes([circleShape]);
  }

  private renderHighlightOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
    const padding = 6;
    const x = targetBounds.x - padding;
    const y = targetBounds.y - padding;
    const w = targetBounds.width + padding * 2;
    const h = targetBounds.height + padding * 2;

    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_highlight");

    const highlightShape: TLShapePartialRecord = {
      id: shapeId,
      type: "geo",
      x,
      y,
      opacity: 0.35,
      props: {
        geo: "rectangle",
        color: "yellow",
        dash: "solid",
        fill: "semi",
        size: "m",
        w,
        h,
        text: action.content ?? ""
      },
      meta: { ...meta }
    };

    editor.createShapes([highlightShape]);
  }

  private renderArrowOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
    const targetCenterX = targetBounds.x + targetBounds.width / 2;
    const targetCenterY = targetBounds.y + targetBounds.height / 2;

    const startX = targetCenterX - 90;
    const startY = targetCenterY - 90;

    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_arrow");

    const arrowShape: TLShapePartialRecord = {
      id: shapeId,
      type: "arrow",
      x: startX,
      y: startY,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 90, y: 90 },
        arrowheadEnd: "arrow",
        color: "violet",
        dash: "draw",
        size: "m",
        text: action.content ?? action.annotationPurpose
      },
      meta: { ...meta }
    };

    editor.createShapes([arrowShape]);
  }

  private renderPointAtOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
    const targetCenterX = targetBounds.x + targetBounds.width / 2;
    const targetCenterY = targetBounds.y;

    const startX = targetCenterX - 60;
    const startY = targetCenterY - 60;

    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_point");

    const pointShape: TLShapePartialRecord = {
      id: shapeId,
      type: "arrow",
      x: startX,
      y: startY,
      props: {
        start: { x: 0, y: 0 },
        end: { x: 60, y: 60 },
        arrowheadEnd: "triangle",
        color: "orange",
        dash: "draw",
        size: "m",
        text: action.content ?? ""
      },
      meta: { ...meta }
    };

    editor.createShapes([pointShape]);
  }

  private renderWriteTextOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    let x = 320;
    let y = 120;

    if (action.targetShapeId !== undefined) {
      const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
      x = targetBounds.x + targetBounds.width + 16;
      y = targetBounds.y;
    }

    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_text");

    const textShape: TLShapePartialRecord = {
      id: shapeId,
      type: "note",
      x,
      y,
      props: {
        text: action.content ?? action.annotationPurpose,
        color: "violet",
        size: "m",
        align: "start"
      },
      meta: { ...meta }
    };

    editor.createShapes([textShape]);
  }

  private renderWriteEquationOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    let x = 320;
    let y = 220;

    if (action.targetShapeId !== undefined) {
      const targetBounds = this.resolveTargetBounds(editor, action.targetShapeId);
      x = targetBounds.x + targetBounds.width + 16;
      y = targetBounds.y;
    }

    const meta = {
      ...this.createAiMeta(action, options),
      isEquation: true
    };
    const shapeId = allocateUniqueShapeId(editor, "ai_equation");

    const equationShape: TLShapePartialRecord = {
      id: shapeId,
      type: "text",
      x,
      y,
      props: {
        text: action.content ?? "",
        color: "violet",
        size: "m",
        font: "mono"
      },
      meta: { ...meta }
    };

    editor.createShapes([equationShape]);
  }

  private executeEraseAiAnnotation(editor: TldrawEditor, action: BoardAction): void {
    if (action.targetShapeId !== undefined) {
      const shape = editor.getShape(action.targetShapeId);
      if (shape === undefined) {
        return;
      }

      const layer = shape.meta?.["layer"];
      if (layer === "STUDENT" || layer === undefined) {
        throw new StudentShapeImmutableError(
          `Fail-closed guard: Refusing to erase shape "${action.targetShapeId}" because it is owned by the STUDENT layer.`
        );
      }

      if (layer === "SYSTEM_DECORATION") {
        throw new StudentShapeImmutableError(
          `Fail-closed guard: Refusing to erase system decoration shape "${action.targetShapeId}".`
        );
      }

      if (layer === "AI_ANNOTATION") {
        editor.deleteShapes([action.targetShapeId]);
      }
      return;
    }

    const shapes = editor.getCurrentPageShapes();
    const aiShapes = shapes.filter((shape) => shape.meta?.["layer"] === "AI_ANNOTATION");

    if (aiShapes.length === 0) return;

    let latest = aiShapes[0];
    let latestTime = annotationCreatedAtMs(latest);
    for (let index = 1; index < aiShapes.length; index += 1) {
      const candidate = aiShapes[index];
      if (candidate === undefined) continue;
      const candidateTime = annotationCreatedAtMs(candidate);
      if (candidateTime >= latestTime) {
        latest = candidate;
        latestTime = candidateTime;
      }
    }
    if (latest !== undefined) editor.deleteShapes([latest.id]);
  }

  private resolveTargetBounds(editor: TldrawEditor, targetShapeId?: string): TLShapeBounds {
    if (targetShapeId !== undefined) {
      const shape = editor.getShape(targetShapeId);
      if (shape !== undefined) {
        return this.resolveShapeBounds(editor, shape);
      }
    }
    return {
      x: 200,
      y: 200,
      width: 120,
      height: 120,
      minX: 200,
      minY: 200,
      maxX: 320,
      maxY: 320
    };
  }

  private resolveShapeBounds(editor: TldrawEditor, shape: TLShapeRecord): TLShapeBounds {
    if (typeof editor.getShapePageBounds === "function") {
      const bounds = editor.getShapePageBounds(shape.id);
      if (bounds !== undefined) return this.validateShapeBounds(shape.id, bounds);
    }

    const props = shape.props ?? {};
    const width = typeof props["w"] === "number"
      ? props["w"]
      : typeof props["width"] === "number"
        ? props["width"]
        : 100;
    const height = typeof props["h"] === "number"
      ? props["h"]
      : typeof props["height"] === "number"
        ? props["height"]
        : 100;
    const x = shape.x;
    const y = shape.y;

    return this.validateShapeBounds(shape.id, {
      x,
      y,
      width,
      height,
      minX: x,
      minY: y,
      maxX: x + width,
      maxY: y + height
    });
  }

  private validateShapeBounds(shapeId: string, bounds: TLShapeBounds): TLShapeBounds {
    for (const [name, value] of [
      ["x", bounds.x],
      ["y", bounds.y],
      ["width", bounds.width],
      ["height", bounds.height]
    ] as const) {
      if (!Number.isFinite(value)) {
        throw new Error(`Shape ${shapeId} has non-finite ${name} bounds`);
      }
    }
    if (bounds.width < 0 || bounds.height < 0) {
      throw new Error(`Shape ${shapeId} has negative bounds dimensions`);
    }
    return bounds;
  }

  private createAiMeta(action: BoardAction, options?: ApplyAiOverlayOptions): CanvasShapeMeta {
    WhiteboardLayerSchema.parse("AI_ANNOTATION");
    return {
      layer: "AI_ANNOTATION",
      shapeRevision: 1,
      origin: "AI",
      ...(options?.deliveryId !== undefined ? { deliveryId: options.deliveryId } : {}),
      ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options?.generationId !== undefined ? { generationId: options.generationId } : {}),
      ...(action.targetShapeId !== undefined ? { targetShapeId: action.targetShapeId } : {}),
      ...(action.expectedShapeRevision !== undefined ? { targetShapeRevision: action.expectedShapeRevision } : {}),
      annotationPurpose: action.annotationPurpose,
      operation: action.operation,
      createdAt: new Date().toISOString()
    };
  }

  private requireEditor(): TldrawEditor {
    if (this.editor === null) {
      throw new Error("TldrawWhiteboardAdapter is not attached to an active Tldraw editor instance");
    }
    return this.editor;
  }
}

function annotationCreatedAtMs(shape: TLShapeRecord | undefined): number {
  const raw = shape?.meta?.["createdAt"];
  if (typeof raw !== "string") return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function readShapeRevision(value: unknown, shapeId: string): number {
  if (value === undefined) return 1;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new Error(`Shape ${shapeId} has an invalid shape revision`);
}

function readOptionalShapeRevision(
  value: unknown,
  shapeId: string,
  label: string
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
    return value;
  }
  throw new Error(`Shape ${shapeId} has an invalid ${label}`);
}

function allocateUniqueShapeId(editor: TldrawEditor, prefix: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `shape:${prefix}_${generateId()}`;
    if (editor.getShape(candidate) === undefined) return candidate;
  }
  throw new Error(`Unable to allocate a unique ${prefix} whiteboard shape ID`);
}

function generateId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
