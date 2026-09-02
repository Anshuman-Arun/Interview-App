import {
  MAX_VISION_REGION_DIMENSION,
  MAX_VISION_REGION_SHAPES,
  MAX_WHITEBOARD_VISION_PNG_BYTES,
  RequestIdSchema,
  SessionIdSchema,
  VisionBoundsSchema,
  WhiteboardVisionSnapshotUploadSchema,
  type BoardRevision,
  type SessionId,
  type WhiteboardVisionSnapshotResponse
} from "../../../../packages/domain/src/index.js";
import {
  DirtyRegionCoalescer,
  computeUnionBounds,
  type BoundingBox,
  type StudentShape
} from "../../../../packages/whiteboard/src/index.js";
import type { NormalizedStudentShapeChange } from "./normalized-board.js";

const DEFAULT_DEBOUNCE_MS = 350;
const MAX_DIRTY_BOXES = 128;
const MAX_DIRTY_REGION_AREA = 4 * 1024 * 1024;
const MAX_EXPORT_DIMENSION = 4096;

export interface StudentRegionPng {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface WhiteboardVisionSchedulerOptions {
  readonly sessionId: SessionId;
  readonly getAuthoritativeRevision: () => BoardRevision | undefined;
  readonly getStudentShapes: () => readonly StudentShape[];
  readonly captureRegion: (
    shapeIds: readonly string[],
    bounds: BoundingBox
  ) => Promise<StudentRegionPng>;
  readonly submit: (
    upload: ReturnType<typeof WhiteboardVisionSnapshotUploadSchema.parse>,
    signal: AbortSignal
  ) => Promise<WhiteboardVisionSnapshotResponse>;
  readonly debounceMs?: number;
  readonly now?: () => number;
}

export class WhiteboardVisionScheduler {
  private readonly sessionId: SessionId;
  private readonly getAuthoritativeRevision: WhiteboardVisionSchedulerOptions["getAuthoritativeRevision"];
  private readonly getStudentShapes: WhiteboardVisionSchedulerOptions["getStudentShapes"];
  private readonly captureRegion: WhiteboardVisionSchedulerOptions["captureRegion"];
  private readonly submitVision: WhiteboardVisionSchedulerOptions["submit"];
  private readonly debounceMs: number;
  private readonly now: () => number;
  private dirtyBoxes: BoundingBox[] = [];
  private dueAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activeController: AbortController | undefined;
  private disposed = false;
  private flushing = false;
  private lastResponse: WhiteboardVisionSnapshotResponse | undefined;

  public constructor(options: WhiteboardVisionSchedulerOptions) {
    this.sessionId = SessionIdSchema.parse(options.sessionId);
    this.getAuthoritativeRevision = options.getAuthoritativeRevision;
    this.getStudentShapes = options.getStudentShapes;
    this.captureRegion = options.captureRegion;
    this.submitVision = options.submit;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (
      !Number.isSafeInteger(this.debounceMs)
      || this.debounceMs < 0
      || this.debounceMs > 10_000
    ) {
      throw new RangeError("Whiteboard vision debounce must be a bounded non-negative integer");
    }
    this.now = options.now ?? (() => Date.now());
  }

  public record(change: NormalizedStudentShapeChange): void {
    if (this.disposed) return;
    this.activeController?.abort();
    const boxes = dirtyBoxesFromChange(change);
    if (boxes.length === 0) return;
    this.mergeDirtyBoxes(boxes);
    this.dueAt = this.now() + this.debounceMs;
    this.reschedule();
  }

  public wake(): void {
    if (this.disposed) return;
    this.reschedule();
  }

  public pendingDirtyBoxCount(): number {
    return this.dirtyBoxes.length;
  }

  public getLastResponse(): WhiteboardVisionSnapshotResponse | undefined {
    return this.lastResponse === undefined
      ? undefined
      : { ...this.lastResponse };
  }

  public dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.activeController?.abort();
    this.activeController = undefined;
    this.dirtyBoxes = [];
  }

  private reschedule(): void {
    if (
      this.disposed
      || this.flushing
      || this.dirtyBoxes.length === 0
      || this.getAuthoritativeRevision() === undefined
    ) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const delay = Math.max(0, this.dueAt - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.flushing || this.dirtyBoxes.length === 0) return;
    const sourceBoardRevision = this.getAuthoritativeRevision();
    if (sourceBoardRevision === undefined) return;
    if (this.now() < this.dueAt) {
      this.reschedule();
      return;
    }

    this.flushing = true;
    const batchBoxes = this.dirtyBoxes;
    this.dirtyBoxes = [];
    try {
      const shapes = this.getStudentShapes();
      const coalescer = new DirtyRegionCoalescer({
        paddingRatio: 0.2,
        minDimension: 20
      });
      for (const box of batchBoxes) coalescer.recordDirtyBox(box);
      const dirty = coalescer.flushDirtyRegion(shapes);
      if (dirty === undefined || dirty.relevantShapeIds.length === 0) return;
      if (dirty.relevantShapeIds.length > MAX_VISION_REGION_SHAPES) return;
      const bounds = VisionBoundsSchema.safeParse(dirty.bounds);
      if (
        !bounds.success
        || bounds.data.width > Math.min(MAX_VISION_REGION_DIMENSION, MAX_EXPORT_DIMENSION)
        || bounds.data.height > Math.min(MAX_VISION_REGION_DIMENSION, MAX_EXPORT_DIMENSION)
        || bounds.data.width * bounds.data.height > MAX_DIRTY_REGION_AREA
      ) return;

      const relevantSet = new Set(dirty.relevantShapeIds);
      const relevantShapes = shapes
        .filter((shape) => relevantSet.has(shape.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (relevantShapes.length !== dirty.relevantShapeIds.length) {
        this.requeue(batchBoxes);
        return;
      }
      const relevantShapeIds = relevantShapes.map((shape) => shape.id);
      const relevantShapeRevisions = relevantShapes.map((shape) => ({
        shapeId: shape.id,
        expectedRevision: shape.revision
      }));

      const controller = new AbortController();
      this.activeController = controller;
      const capturedAtMs = this.now();
      const image = await this.captureRegion(relevantShapeIds, bounds.data);
      if (controller.signal.aborted) {
        this.requeue(batchBoxes);
        return;
      }
      if (
        image.bytes.byteLength === 0
        || image.bytes.byteLength > MAX_WHITEBOARD_VISION_PNG_BYTES
        || image.width <= 0
        || image.height <= 0
        || image.width > MAX_EXPORT_DIMENSION
        || image.height > MAX_EXPORT_DIMENSION
      ) return;

      if (
        this.getAuthoritativeRevision() !== sourceBoardRevision
        || !shapeRevisionsStillMatch(relevantShapeRevisions, this.getStudentShapes())
      ) {
        this.requeue(batchBoxes);
        return;
      }

      const requestId = RequestIdSchema.parse(
        `request_${globalThis.crypto.randomUUID()}`
      );
      const snapshotId = `snapshot_${globalThis.crypto.randomUUID()}`;
      const regionId = `region_${globalThis.crypto.randomUUID()}`;
      const upload = WhiteboardVisionSnapshotUploadSchema.parse({
        protocolVersion: 1,
        requestId,
        sessionId: this.sessionId,
        sourceBoardRevision,
        snapshotId,
        capturedAtMs,
        declaredWidth: image.width,
        declaredHeight: image.height,
        region: {
          regionId,
          bounds: bounds.data,
          relevantShapeIds
        },
        relevantShapeRevisions,
        requestedObservationKind: "ANY",
        pngBase64: bytesToBase64(image.bytes)
      });
      this.lastResponse = await this.submitVision(upload, controller.signal);
    } catch {
      if (this.activeController?.signal.aborted === true) {
        this.requeue(batchBoxes);
      }
    } finally {
      this.activeController = undefined;
      this.flushing = false;
      this.reschedule();
    }
  }

  private mergeDirtyBoxes(boxes: readonly BoundingBox[]): void {
    const combined = [...this.dirtyBoxes, ...boxes];
    if (combined.length <= MAX_DIRTY_BOXES) {
      this.dirtyBoxes = combined.map((box) => ({ ...box }));
      return;
    }
    const union = computeUnionBounds(combined);
    this.dirtyBoxes = union === undefined ? [] : [{ ...union }];
  }

  private requeue(boxes: readonly BoundingBox[]): void {
    if (this.disposed) return;
    this.mergeDirtyBoxes(boxes);
    this.dueAt = Math.max(this.dueAt, this.now() + this.debounceMs);
  }
}

function dirtyBoxesFromChange(
  change: NormalizedStudentShapeChange
): readonly BoundingBox[] {
  const boxes: BoundingBox[] = [];
  for (const shape of change.added) boxes.push({ ...shape.bounds });
  for (const entry of change.updated) {
    boxes.push({ ...entry.before.bounds });
    boxes.push({ ...entry.after.bounds });
  }
  for (const shape of change.deleted) boxes.push({ ...shape.bounds });
  return boxes;
}

function shapeRevisionsStillMatch(
  expected: readonly { readonly shapeId: string; readonly expectedRevision: number }[],
  shapes: readonly StudentShape[]
): boolean {
  const current = new Map(shapes.map((shape) => [shape.id, shape.revision] as const));
  return expected.every((binding) =>
    current.get(binding.shapeId) === binding.expectedRevision
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    binary += String.fromCharCode(...chunk);
  }
  return globalThis.btoa(binary);
}
