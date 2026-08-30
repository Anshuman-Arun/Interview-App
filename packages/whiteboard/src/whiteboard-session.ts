import {
  type BoardAction,
  type WhiteboardAdapter,
  BoardActionSchema
} from "../../domain/src/index.js";
import {
  type AiAnnotation,
  type StudentShape,
  type WhiteboardSnapshot,
  AiAnnotationSchema,
  StudentShapeSchema,
  WhiteboardSnapshotSchema
} from "./shape-model.js";
import { DirtyRegionCoalescer } from "./dirty-region-coalescer.js";

export type AiActionApplyResult =
  | { readonly applied: true; readonly annotationId: string }
  | { readonly applied: false; readonly reason: "STALE_SHAPE_REVISION" | "SHAPE_NOT_FOUND" | "VALIDATION_FAILED" };

export class WhiteboardSessionAdapter implements WhiteboardAdapter {
  private currentBoardRevision = 0;
  private readonly studentShapes = new Map<string, StudentShape>();
  private readonly aiAnnotations = new Map<string, AiAnnotation>();
  private readonly coalescer = new DirtyRegionCoalescer();

  public get boardRevision(): number {
    return this.currentBoardRevision;
  }

  // --- Student Layer Operations ---

  public upsertStudentShape(shapeInput: Omit<StudentShape, "revision" | "lastModifiedAt">): StudentShape {
    const existing = this.studentShapes.get(shapeInput.id);
    const newRevision = (existing?.revision ?? 0) + 1;
    const now = Date.now();

    const shape: StudentShape = StudentShapeSchema.parse({
      ...shapeInput,
      revision: newRevision,
      lastModifiedAt: now
    });

    this.studentShapes.set(shape.id, shape);
    this.currentBoardRevision += 1;
    this.coalescer.recordDirtyBox(shape.bounds);

    return shape;
  }

  public deleteStudentShape(shapeId: string): boolean {
    const existing = this.studentShapes.get(shapeId);
    if (existing === undefined) return false;

    this.studentShapes.delete(shapeId);
    this.currentBoardRevision += 1;
    this.coalescer.recordDirtyBox(existing.bounds);

    return true;
  }

  public getStudentShape(shapeId: string): StudentShape | undefined {
    return this.studentShapes.get(shapeId);
  }

  public getAllStudentShapes(): readonly StudentShape[] {
    return Array.from(this.studentShapes.values());
  }

  // --- Dirty Region & Vision Context ---

  public flushDirtyVisionRegion(): { readonly bounds: { x: number; y: number; width: number; height: number }; readonly relevantShapeIds: readonly string[]; readonly sourceBoardRevision: number } | undefined {
    const result = this.coalescer.flushDirtyRegion(this.getAllStudentShapes());
    if (result === undefined) return undefined;

    return {
      bounds: result.bounds,
      relevantShapeIds: result.relevantShapeIds,
      sourceBoardRevision: this.currentBoardRevision
    };
  }

  // --- AI Annotation Layer Operations (Non-Destructive) ---

  public async applyAiOverlayAction(action: BoardAction): Promise<void> {
    this.applyAiOverlayActionWithResult(action);
  }

  public applyAiOverlayActionWithResult(actionInput: BoardAction): AiActionApplyResult {
    let action: BoardAction;
    try {
      action = BoardActionSchema.parse(actionInput);
    } catch {
      return { applied: false, reason: "VALIDATION_FAILED" };
    }

    // 1. Check shape freshness if action targets a specific student shape
    if (action.targetShapeId !== undefined) {
      const targetShape = this.studentShapes.get(action.targetShapeId);
      if (targetShape === undefined) {
        return { applied: false, reason: "SHAPE_NOT_FOUND" };
      }

      if (action.expectedShapeRevision !== undefined && targetShape.revision !== action.expectedShapeRevision) {
        return { applied: false, reason: "STALE_SHAPE_REVISION" };
      }
    }

    // 2. Erase AI annotation operation
    if (action.operation === "erase_ai_annotation") {
      if (action.targetShapeId !== undefined) {
        this.aiAnnotations.delete(action.targetShapeId);
      } else {
        // Erase all AI annotations matching annotation purpose
        for (const [id, ann] of this.aiAnnotations.entries()) {
          if (ann.action.annotationPurpose === action.annotationPurpose) {
            this.aiAnnotations.delete(id);
          }
        }
      }
      return { applied: true, annotationId: action.targetShapeId ?? "batch_erased" };
    }

    // 3. Add AI annotation to AI layer ONLY (never mutates studentShapes map)
    const annotationId = `ai_ann_${globalThis.crypto.randomUUID()}`;
    const annotation: AiAnnotation = AiAnnotationSchema.parse({
      id: annotationId,
      action,
      appliedAtBoardRevision: this.currentBoardRevision,
      createdAt: Date.now()
    });

    this.aiAnnotations.set(annotationId, annotation);
    return { applied: true, annotationId };
  }

  public async clearAiOverlay(): Promise<void> {
    this.aiAnnotations.clear();
  }

  public getAllAiAnnotations(): readonly AiAnnotation[] {
    return Array.from(this.aiAnnotations.values());
  }

  // --- Snapshot & Serialization ---

  public getSnapshot(): WhiteboardSnapshot {
    return WhiteboardSnapshotSchema.parse({
      boardRevision: this.currentBoardRevision,
      studentShapes: this.getAllStudentShapes(),
      aiAnnotations: this.getAllAiAnnotations(),
      timestamp: Date.now()
    });
  }
}
