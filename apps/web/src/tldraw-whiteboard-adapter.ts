import {
  BoardActionSchema,
  WhiteboardLayerSchema,
  type BoardAction,
  type WhiteboardAdapter,
  type WhiteboardLayer,
  type DeliveryId
} from "../../../packages/domain/src/index.js";
import {
  RendererPresentationNotExposedError,
  type WhiteboardPresenter
} from "./renderer-client.js";
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

export class WhiteboardPresentationPossiblyExposedError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WhiteboardPresentationPossiblyExposedError";
  }
}

export interface CanvasShapeMeta {
  readonly layer: WhiteboardLayer;
  readonly shapeRevision: number;
  readonly origin: "STUDENT" | "AI" | "SYSTEM";
  readonly annotationId?: string;
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
  setReadOnly?: (readOnly: boolean) => void;
  exportStudentShapesPng?: (
    shapeIds: readonly string[],
    bounds: TLShapeBounds
  ) => Promise<{
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
  }>;
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
    readonly annotationId: string;
    readonly physicalShapeIds: readonly string[];
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
  readonly annotationId?: string;
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

  public setReadOnly(readOnly: boolean): void {
    this.editor?.setReadOnly?.(readOnly);
  }

  public resetForNewSession(): void {
    const editor = this.editor;
    if (editor !== null) {
      const ids = editor.getCurrentPageShapes().map((shape) => shape.id);
      if (ids.length > 0) editor.deleteShapes(ids);
    }
    this.localBoardRevision = 0;
  }

  public getBoardRevision(): number {
    return this.localBoardRevision;
  }

  /**
   * Records one normalized student mutation in the adapter's browser-local
   * revision mirror. Application authority lives in the event-sourced session;
   * AuthoritativeBoardSyncCoordinator binds this canvas to that BoardRevision.
   * Adapter-originated mutations are already counted by create/update methods.
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
    const annotationOptions: ApplyAiOverlayOptions = {
      ...options,
      annotationId: options?.annotationId
        ?? options?.deliveryId
        ?? `local_annotation_${generateId()}`
    };

    this.validateTargetRevision(editor, validatedAction);

    switch (validatedAction.operation) {
      case "circle":
        this.renderCircleOverlay(editor, validatedAction, annotationOptions);
        break;
      case "highlight":
        this.renderHighlightOverlay(editor, validatedAction, annotationOptions);
        break;
      case "draw_arrow":
        this.renderArrowOverlay(editor, validatedAction, annotationOptions);
        break;
      case "point_at":
        this.renderPointAtOverlay(editor, validatedAction, annotationOptions);
        break;
      case "write_text":
        this.renderWriteTextOverlay(editor, validatedAction, annotationOptions);
        break;
      case "write_equation":
        this.renderWriteEquationOverlay(editor, validatedAction, annotationOptions);
        break;
      case "draw_segment":
        this.renderSegmentOverlay(editor, validatedAction, annotationOptions);
        break;
      case "draw_arrow_between":
        this.renderArrowBetweenOverlay(editor, validatedAction, annotationOptions);
        break;
      case "draw_polyline":
        this.renderPolylineOverlay(editor, validatedAction, annotationOptions);
        break;
      case "draw_rectangle":
        this.renderBoxOverlay(editor, validatedAction, "rectangle", annotationOptions);
        break;
      case "draw_ellipse":
        this.renderBoxOverlay(editor, validatedAction, "ellipse", annotationOptions);
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

  public async exportStudentRegionPng(
    shapeIds: readonly string[],
    bounds: TLShapeBounds
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly width: number;
    readonly height: number;
  }> {
    const editor = this.requireEditor();
    if (editor.exportStudentShapesPng === undefined) {
      throw new Error("Mounted whiteboard editor does not support bounded PNG export");
    }
    return editor.exportStudentShapesPng(shapeIds, bounds);
  }

  public getCanvasSnapshot(): CanvasSnapshot {
    const editor = this.requireEditor();
    const shapes = editor.getCurrentPageShapes();

    const studentShapes: CanvasSnapshot["studentShapes"][number][] = [];
    const aiAnnotationGroups = new Map<
      string,
      {
        id: string;
        annotationId: string;
        physicalShapeIds: string[];
        operation: string;
        deliveryId?: string;
        purpose: string;
        targetShapeId?: string;
        targetShapeRevision?: number;
      }
    >();

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
        const annotationId = logicalAnnotationId(shape);
        const existing = aiAnnotationGroups.get(annotationId);
        if (existing !== undefined) {
          existing.physicalShapeIds.push(shape.id);
          continue;
        }
        const operation = typeof shape.meta?.["operation"] === "string" ? shape.meta["operation"] : shape.type;
        const deliveryId = typeof shape.meta?.["deliveryId"] === "string" ? shape.meta["deliveryId"] : undefined;
        const purpose = typeof shape.meta?.["annotationPurpose"] === "string" ? shape.meta["annotationPurpose"] : "";
        const targetShapeId = typeof shape.meta?.["targetShapeId"] === "string" ? shape.meta["targetShapeId"] : undefined;
        const targetShapeRevision = readOptionalShapeRevision(
          shape.meta?.["targetShapeRevision"],
          shape.id,
          "targetShapeRevision"
        );
        aiAnnotationGroups.set(annotationId, {
          id: annotationId,
          annotationId,
          physicalShapeIds: [shape.id],
          operation,
          ...(deliveryId !== undefined ? { deliveryId } : {}),
          purpose,
          ...(targetShapeId !== undefined ? { targetShapeId } : {}),
          ...(targetShapeRevision !== undefined ? { targetShapeRevision } : {})
        });
      }
    }

    const aiAnnotations = Array.from(aiAnnotationGroups.values());
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
      throw new Error("Local whiteboard BoardRevision mirror cannot exceed Number.MAX_SAFE_INTEGER");
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
    } else {
      this.validateShapeRevisionBinding(
        editor,
        action.targetShapeId,
        action.expectedShapeRevision,
        "Target shape"
      );
    }

    if (action.placement?.anchorShapeId !== undefined) {
      this.validateShapeRevisionBinding(
        editor,
        action.placement.anchorShapeId,
        action.placement.anchorRevision,
        "Placement anchor"
      );
    }

    if (action.targetRegion !== undefined) {
      this.validateShapeRevisionBinding(
        editor,
        action.targetRegion.shapeId,
        action.targetRegion.shapeRevision,
        "Target region"
      );
    }

    if (action.operation === "draw_arrow_between") {
      if (action.fromShapeId === undefined || action.toShapeId === undefined) {
        throw new UnsupportedBoardActionError(
          "draw_arrow_between requires two target shapes"
        );
      }
      this.validateShapeRevisionBinding(
        editor,
        action.fromShapeId,
        action.fromShapeRevision,
        "Arrow source"
      );
      this.validateShapeRevisionBinding(
        editor,
        action.toShapeId,
        action.toShapeRevision,
        "Arrow destination"
      );
    }
  }

  private validateShapeRevisionBinding(
    editor: TldrawEditor,
    shapeId: string,
    expectedRevision: number | undefined,
    label: string
  ): void {
    const shape = editor.getShape(shapeId);
    if (shape === undefined) {
      throw new StaleShapeRevisionError(`${label} "${shapeId}" not found`);
    }
    if (expectedRevision === undefined) return;
    const actualRevision = readShapeRevision(shape.meta?.["shapeRevision"], shape.id);
    if (actualRevision !== expectedRevision) {
      throw new StaleShapeRevisionError(
        `${label} "${shapeId}" revision mismatch: expected ${String(expectedRevision)}, got ${String(actualRevision)}`
      );
    }
  }

  private renderCircleOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveActionTargetBounds(editor, action);
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

    this.commitAiShapeBatch(editor, [circleShape]);
  }

  private renderHighlightOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveActionTargetBounds(editor, action);
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

    this.commitAiShapeBatch(editor, [highlightShape]);
  }

  private renderArrowOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveActionTargetBounds(editor, action);
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

    this.commitAiShapeBatch(editor, [arrowShape]);
  }

  private renderPointAtOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const targetBounds = this.resolveActionTargetBounds(editor, action);
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

    this.commitAiShapeBatch(editor, [pointShape]);
  }

  private renderWriteTextOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const placement = this.resolveActionPlacement(
      editor,
      action,
      { x: 320, y: 120 },
      { width: 220, height: 96 }
    );
    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, "ai_text");

    const textShape: TLShapePartialRecord = {
      id: shapeId,
      type: "note",
      x: placement.x,
      y: placement.y,
      props: {
        text: action.content ?? action.annotationPurpose,
        color: "violet",
        size: "m",
        align: "start"
      },
      meta: { ...meta }
    };

    this.commitAiShapeBatch(editor, [textShape]);
  }

  private renderWriteEquationOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const placement = this.resolveActionPlacement(
      editor,
      action,
      { x: 320, y: 220 },
      { width: 220, height: 56 }
    );
    const meta = {
      ...this.createAiMeta(action, options),
      isEquation: true
    };
    const shapeId = allocateUniqueShapeId(editor, "ai_equation");

    const equationShape: TLShapePartialRecord = {
      id: shapeId,
      type: "text",
      x: placement.x,
      y: placement.y,
      props: {
        text: action.content ?? "",
        color: "violet",
        size: "m",
        font: "mono"
      },
      meta: { ...meta }
    };

    this.commitAiShapeBatch(editor, [equationShape]);
  }

  private renderSegmentOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const points = action.points;
    if (points === undefined || points.length !== 2) {
      throw new UnsupportedBoardActionError("draw_segment requires exactly two points");
    }
    const start = points[0];
    const end = points[1];
    if (start === undefined || end === undefined) {
      throw new UnsupportedBoardActionError("draw_segment requires exactly two points");
    }
    this.renderStraightAnnotationSegment(
      editor,
      action,
      start,
      end,
      false,
      "ai_segment",
      options
    );
  }

  private renderArrowBetweenOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    if (action.fromShapeId === undefined || action.toShapeId === undefined) {
      throw new UnsupportedBoardActionError("draw_arrow_between requires two target shapes");
    }
    const from = this.resolveTargetBounds(editor, action.fromShapeId);
    const to = this.resolveTargetBounds(editor, action.toShapeId);
    this.renderStraightAnnotationSegment(
      editor,
      action,
      { x: from.x + from.width / 2, y: from.y + from.height / 2 },
      { x: to.x + to.width / 2, y: to.y + to.height / 2 },
      true,
      "ai_arrow_between",
      options
    );
  }

  private renderPolylineOverlay(editor: TldrawEditor, action: BoardAction, options?: ApplyAiOverlayOptions): void {
    const points = action.points;
    if (points === undefined || points.length < 2) {
      throw new UnsupportedBoardActionError("draw_polyline requires at least two points");
    }
    const meta = this.createAiMeta(action, options);
    const shapes: TLShapePartialRecord[] = [];
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index];
      const end = points[index + 1];
      if (start === undefined || end === undefined) {
        throw new UnsupportedBoardActionError("draw_polyline contains an incomplete segment");
      }
      shapes.push(this.buildStraightAnnotationSegment(
        editor,
        start,
        end,
        false,
        `ai_polyline_${String(index)}`,
        meta,
        index === 0 ? (action.content ?? "") : ""
      ));
    }
    this.commitAiShapeBatch(editor, shapes);
  }

  private renderStraightAnnotationSegment(
    editor: TldrawEditor,
    action: BoardAction,
    start: { readonly x: number; readonly y: number },
    end: { readonly x: number; readonly y: number },
    arrowhead: boolean,
    prefix: string,
    options?: ApplyAiOverlayOptions,
    includeText = true
  ): void {
    const shape = this.buildStraightAnnotationSegment(
      editor,
      start,
      end,
      arrowhead,
      prefix,
      this.createAiMeta(action, options),
      includeText ? (action.content ?? "") : ""
    );
    this.commitAiShapeBatch(editor, [shape]);
  }

  private buildStraightAnnotationSegment(
    editor: TldrawEditor,
    start: { readonly x: number; readonly y: number },
    end: { readonly x: number; readonly y: number },
    arrowhead: boolean,
    prefix: string,
    meta: CanvasShapeMeta,
    text: string
  ): TLShapePartialRecord {
    const shapeId = allocateUniqueShapeId(editor, prefix);
    return {
      id: shapeId,
      type: "arrow",
      x: start.x,
      y: start.y,
      props: {
        start: { x: 0, y: 0 },
        end: { x: end.x - start.x, y: end.y - start.y },
        arrowheadStart: "none",
        arrowheadEnd: arrowhead ? "arrow" : "none",
        color: "violet",
        dash: "draw",
        size: "m",
        text
      },
      meta: { ...meta }
    };
  }

  private renderBoxOverlay(
    editor: TldrawEditor,
    action: BoardAction,
    geo: "rectangle" | "ellipse",
    options?: ApplyAiOverlayOptions
  ): void {
    if (action.width === undefined || action.height === undefined) {
      throw new UnsupportedBoardActionError(`draw_${geo} requires width and height`);
    }
    const placement = this.resolveActionPlacement(
      editor,
      action,
      { x: 320, y: 320 },
      { width: action.width, height: action.height }
    );
    const meta = this.createAiMeta(action, options);
    const shapeId = allocateUniqueShapeId(editor, `ai_${geo}`);
    this.commitAiShapeBatch(editor, [{
      id: shapeId,
      type: "geo",
      x: placement.x,
      y: placement.y,
      props: {
        geo,
        color: "violet",
        dash: "draw",
        fill: "none",
        size: "m",
        w: action.width,
        h: action.height,
        text: action.content ?? ""
      },
      meta: { ...meta }
    }]);
  }

  private resolveActionPlacement(
    editor: TldrawEditor,
    action: BoardAction,
    fallback: { readonly x: number; readonly y: number },
    geometry: { readonly width: number; readonly height: number } = { width: 0, height: 0 }
  ): { readonly x: number; readonly y: number } {
    const placement = action.placement;
    let x = fallback.x;
    let y = fallback.y;

    if (placement?.anchorShapeId !== undefined) {
      const bounds = this.resolveTargetBounds(editor, placement.anchorShapeId);
      switch (placement.position) {
        case "LEFT":
          x = bounds.x - geometry.width - 16;
          y = bounds.y;
          break;
        case "RIGHT":
          x = bounds.x + bounds.width + 16;
          y = bounds.y;
          break;
        case "ABOVE":
          x = bounds.x;
          y = bounds.y - geometry.height - 16;
          break;
        case "BELOW":
          x = bounds.x;
          y = bounds.y + bounds.height + 16;
          break;
        case "CENTER":
          x = bounds.x + (bounds.width - geometry.width) / 2;
          y = bounds.y + (bounds.height - geometry.height) / 2;
          break;
        default:
          throw new UnsupportedBoardActionError("Shape-relative placement requires a position");
      }
    } else if (placement?.x !== undefined && placement.y !== undefined) {
      x = placement.x;
      y = placement.y;
    } else if (action.targetShapeId !== undefined) {
      const targetBounds = this.resolveActionTargetBounds(editor, action);
      x = targetBounds.x + targetBounds.width + 16;
      y = targetBounds.y;
    }

    return {
      x: x + (placement?.offsetX ?? 0),
      y: y + (placement?.offsetY ?? 0)
    };
  }

  private executeEraseAiAnnotation(editor: TldrawEditor, action: BoardAction): void {
    const aiShapes = editor.getCurrentPageShapes()
      .filter((shape) => shape.meta?.["layer"] === "AI_ANNOTATION");
    if (aiShapes.length === 0) {
      throw new UnsupportedBoardActionError("No AI annotation is available to erase");
    }

    let targetAnnotationId = action.targetAnnotationId;
    if (targetAnnotationId === undefined) {
      const groups = new Map<string, { readonly shapes: TLShapeRecord[]; latestTime: number }>();
      for (const shape of aiShapes) {
        const annotationId = logicalAnnotationId(shape);
        const existing = groups.get(annotationId);
        const createdAt = annotationCreatedAtMs(shape);
        if (existing === undefined) {
          groups.set(annotationId, { shapes: [shape], latestTime: createdAt });
        } else {
          existing.shapes.push(shape);
          if (createdAt > existing.latestTime) existing.latestTime = createdAt;
        }
      }
      let latestId: string | undefined;
      let latestTime = Number.NEGATIVE_INFINITY;
      for (const [annotationId, group] of groups) {
        if (group.latestTime >= latestTime) {
          latestId = annotationId;
          latestTime = group.latestTime;
        }
      }
      targetAnnotationId = latestId;
    }

    if (targetAnnotationId === undefined) {
      throw new UnsupportedBoardActionError("No AI annotation is available to erase");
    }
    const group = aiShapes.filter((shape) => logicalAnnotationId(shape) === targetAnnotationId);
    if (group.length === 0) {
      throw new UnsupportedBoardActionError(
        `AI annotation "${targetAnnotationId}" is not visible on the canvas`
      );
    }
    this.deleteAiAnnotationGroupAtomically(editor, group);
  }

  private commitAiShapeBatch(
    editor: TldrawEditor,
    shapes: readonly TLShapePartialRecord[]
  ): void {
    if (shapes.length === 0) {
      throw new RendererPresentationNotExposedError("AI annotation batch is empty");
    }
    const ids = shapes.map((shape) => shape.id);
    if (new Set(ids).size !== ids.length) {
      throw new RendererPresentationNotExposedError("AI annotation batch reused a renderer shape ID");
    }
    if (ids.some((id) => editor.getShape(id) !== undefined)) {
      throw new RendererPresentationNotExposedError("AI annotation batch collided with an existing shape");
    }

    let createError: unknown;
    try {
      editor.createShapes(shapes);
    } catch (error) {
      createError = error;
    }

    const presentIds = ids.filter((id) => editor.getShape(id) !== undefined);
    if (presentIds.length === ids.length) {
      return;
    }
    if (presentIds.length === 0) {
      throw new RendererPresentationNotExposedError(
        "AI annotation batch failed before any shape remained visible"
      );
    }

    let rollbackError: unknown;
    try {
      editor.deleteShapes(presentIds);
    } catch (error) {
      rollbackError = error;
    }
    const survivors = ids.filter((id) => editor.getShape(id) !== undefined);
    if (survivors.length === 0) {
      throw new RendererPresentationNotExposedError(
        "AI annotation batch partially mutated but was fully rolled back"
      );
    }
    throw new WhiteboardPresentationPossiblyExposedError(
      "AI annotation batch partially rendered and rollback could not be proven",
      { cause: rollbackError ?? createError }
    );
  }

  private deleteAiAnnotationGroupAtomically(
    editor: TldrawEditor,
    shapes: readonly TLShapeRecord[]
  ): void {
    const snapshots = shapes.map((shape): TLShapePartialRecord => ({
      id: shape.id,
      type: shape.type,
      x: shape.x,
      y: shape.y,
      ...(shape.rotation === undefined ? {} : { rotation: shape.rotation }),
      ...(shape.isLocked === undefined ? {} : { isLocked: shape.isLocked }),
      ...(shape.opacity === undefined ? {} : { opacity: shape.opacity }),
      props: { ...(shape.props ?? {}) },
      meta: { ...(shape.meta ?? {}) }
    }));
    const ids = snapshots.map((shape) => shape.id);

    let deletionError: unknown;
    try {
      editor.deleteShapes(ids);
    } catch (error) {
      deletionError = error;
    }
    const survivors = ids.filter((id) => editor.getShape(id) !== undefined);
    if (survivors.length === 0) return;

    const missingSnapshots = snapshots.filter((shape) => editor.getShape(shape.id) === undefined);
    if (missingSnapshots.length === 0) {
      throw new RendererPresentationNotExposedError(
        "AI annotation erase failed before changing the visible group"
      );
    }

    let rollbackError: unknown;
    try {
      editor.createShapes(missingSnapshots);
    } catch (error) {
      rollbackError = error;
    }
    const restored = ids.every((id) => editor.getShape(id) !== undefined);
    if (restored) {
      throw new RendererPresentationNotExposedError(
        "AI annotation erase partially mutated but was fully rolled back"
      );
    }
    throw new WhiteboardPresentationPossiblyExposedError(
      "AI annotation erase partially mutated and rollback could not be proven",
      { cause: rollbackError ?? deletionError }
    );
  }

  private resolveActionTargetBounds(editor: TldrawEditor, action: BoardAction): TLShapeBounds {
    if (action.targetRegion === undefined) {
      return this.resolveTargetBounds(editor, action.targetShapeId);
    }
    const shape = editor.getShape(action.targetRegion.shapeId);
    if (shape === undefined) {
      throw new StaleShapeRevisionError(
        `Target region shape "${action.targetRegion.shapeId}" not found`
      );
    }
    const bounds = this.resolveShapeBounds(editor, shape);
    const widthFraction = action.targetRegion.widthFraction ?? 0;
    const heightFraction = action.targetRegion.heightFraction ?? 0;
    const x = bounds.x + bounds.width * action.targetRegion.xFraction;
    const y = bounds.y + bounds.height * action.targetRegion.yFraction;
    const width = bounds.width * widthFraction;
    const height = bounds.height * heightFraction;
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
      ...(options?.annotationId !== undefined ? { annotationId: options.annotationId } : {}),
      ...(options?.deliveryId !== undefined ? { deliveryId: options.deliveryId } : {}),
      ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
      ...(options?.generationId !== undefined ? { generationId: options.generationId } : {}),
      ...((action.targetShapeId ?? action.targetRegion?.shapeId) === undefined
        ? {}
        : { targetShapeId: action.targetShapeId ?? action.targetRegion?.shapeId }),
      ...((action.expectedShapeRevision ?? action.targetRegion?.shapeRevision) === undefined
        ? {}
        : { targetShapeRevision: action.expectedShapeRevision ?? action.targetRegion?.shapeRevision }),
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

function logicalAnnotationId(shape: TLShapeRecord): string {
  const annotationId = shape.meta?.["annotationId"];
  if (typeof annotationId === "string" && annotationId.length > 0) return annotationId;
  const deliveryId = shape.meta?.["deliveryId"];
  if (typeof deliveryId === "string" && deliveryId.length > 0) return deliveryId;
  return `legacy_renderer_annotation:${shape.id}`;
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
