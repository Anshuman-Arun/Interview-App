import { createHash } from "node:crypto";
import { z } from "zod";
import { imageIdentity } from "./deduplication.js";
import {
  CoordinateTransformSchema,
  ImagePayloadReference,
  assertVisionRasterSource,
  ImageSnapshot,
  VisionImageArtifact,
  VisionPreprocessingError,
  type CoordinateTransform,
  type VisionRasterSource
} from "./types.js";
import type { BoardRevision } from "../../domain/src/index.js";

function assertArrayInput(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Vision batch candidates must be an array");
  }
}

export const VisionPurposeSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
export type VisionPurpose = z.infer<typeof VisionPurposeSchema>;

const RequestBudgetSchema = z.object({
  maxImages: z.number().int().nonnegative().max(256),
  maxTotalBytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
  maxTotalPixels: z.number().int().nonnegative().max(128 * 1024 * 1024),
  maxCropsOrTiles: z.number().int().nonnegative().max(256)
}).strict();

export interface VisionRequestBudget {
  readonly maxImages: number;
  readonly maxTotalBytes: number;
  readonly maxTotalPixels: number;
  readonly maxCropsOrTiles: number;
}

export const DEFAULT_VISION_REQUEST_BUDGET: Readonly<VisionRequestBudget> = Object.freeze({
  maxImages: 16,
  maxTotalBytes: 32 * 1024 * 1024,
  maxTotalPixels: 32 * 1024 * 1024,
  maxCropsOrTiles: 16
});

export const VisionBudgetStrategySchema = z.enum(["FAIL", "BOUNDED_PREFIX"]);
export type VisionBudgetStrategy = z.infer<typeof VisionBudgetStrategySchema>;

export const MAX_VISION_REQUEST_CANDIDATES = 1024;

export interface PreparedVisionImageRequest {
  readonly requestId: string;
  readonly purpose: VisionPurpose;
  readonly sourceRevision: BoardRevision;
  readonly sourceSnapshotId: string;
  readonly imageIdentity: string;
  readonly imageKind: "SNAPSHOT" | "CROP" | "RESIZED" | "TILE";
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly contentDigest: string;
  readonly coordinateTransform: CoordinateTransform;
  readonly payload: ImagePayloadReference;
}

export interface VisionRequestBudgetTotals {
  readonly images: number;
  readonly totalBytes: number;
  readonly totalPixels: number;
  readonly cropsOrTiles: number;
}

export interface PreparedVisionBatch {
  readonly requests: readonly PreparedVisionImageRequest[];
  readonly deferredImageIdentities: readonly string[];
  readonly truncated: boolean;
  readonly totals: VisionRequestBudgetTotals;
}

function sourceTransform(source: VisionRasterSource): CoordinateTransform {
  if (ImageSnapshot.isValidatedInstance(source)) {
    return Object.freeze({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 });
  }
  return source.metadata.coordinateTransform;
}

function sourceSnapshotId(source: VisionRasterSource): string {
  return ImageSnapshot.isValidatedInstance(source) ? source.metadata.snapshotId : source.metadata.sourceSnapshotId;
}

function sourceKind(source: VisionRasterSource): PreparedVisionImageRequest["imageKind"] {
  return ImageSnapshot.isValidatedInstance(source) ? "SNAPSHOT" : source.metadata.kind;
}

function deterministicRequestId(
  purpose: VisionPurpose,
  source: VisionRasterSource,
  transform: CoordinateTransform
): string {
  const canonical = JSON.stringify([
    "vision-request-v1",
    purpose,
    source.metadata.sourceRevision,
    imageIdentity(source),
    source.metadata.width,
    source.metadata.height,
    transform.offsetX,
    transform.offsetY,
    transform.scaleX,
    transform.scaleY
  ]);
  return `vision_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export function prepareVisionImageRequest(
  source: VisionRasterSource,
  purposeInput: string
): PreparedVisionImageRequest {
  assertVisionRasterSource(source);
  const purpose = VisionPurposeSchema.parse(purposeInput);
  const transform = Object.freeze({ ...CoordinateTransformSchema.parse(sourceTransform(source)) });
  const identity = imageIdentity(source);
  const payload = new ImagePayloadReference(source);

  return Object.freeze({
    requestId: deterministicRequestId(purpose, source, transform),
    purpose,
    sourceRevision: source.metadata.sourceRevision,
    sourceSnapshotId: sourceSnapshotId(source),
    imageIdentity: identity,
    imageKind: sourceKind(source),
    width: source.metadata.width,
    height: source.metadata.height,
    byteSize: source.metadata.byteSize,
    contentDigest: source.metadata.contentDigest,
    coordinateTransform: transform,
    payload
  });
}

function checkedPixels(request: PreparedVisionImageRequest): number {
  const pixels = request.width * request.height;
  if (!Number.isSafeInteger(pixels)) {
    throw new VisionPreprocessingError("REQUEST_BUDGET_EXCEEDED", "Request pixel count exceeds safe integer range");
  }
  return pixels;
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new VisionPreprocessingError("REQUEST_BUDGET_EXCEEDED", `${label} exceeds safe integer range`);
  }
  return result;
}

function wouldExceed(
  totals: VisionRequestBudgetTotals,
  source: VisionRasterSource,
  budget: VisionRequestBudget
): boolean {
  assertVisionRasterSource(source);
  const nextImages = totals.images + 1;
  const nextBytes = checkedAdd(totals.totalBytes, source.metadata.byteSize, "Request byte total");
  const sourcePixels = source.metadata.width * source.metadata.height;
  if (!Number.isSafeInteger(sourcePixels)) {
    throw new VisionPreprocessingError("REQUEST_BUDGET_EXCEEDED", "Request pixel count exceeds safe integer range");
  }
  const nextPixels = checkedAdd(totals.totalPixels, sourcePixels, "Request pixel total");
  const kind = sourceKind(source);
  const nextCropsOrTiles = totals.cropsOrTiles + (kind === "CROP" || kind === "TILE" ? 1 : 0);
  return nextImages > budget.maxImages
    || nextBytes > budget.maxTotalBytes
    || nextPixels > budget.maxTotalPixels
    || nextCropsOrTiles > budget.maxCropsOrTiles;
}

function addTotals(
  totals: VisionRequestBudgetTotals,
  request: PreparedVisionImageRequest
): VisionRequestBudgetTotals {
  return Object.freeze({
    images: totals.images + 1,
    totalBytes: checkedAdd(totals.totalBytes, request.byteSize, "Request byte total"),
    totalPixels: checkedAdd(totals.totalPixels, checkedPixels(request), "Request pixel total"),
    cropsOrTiles: totals.cropsOrTiles + (request.imageKind === "CROP" || request.imageKind === "TILE" ? 1 : 0)
  });
}

export function prepareVisionBatch(
  sources: readonly VisionRasterSource[],
  purpose: string,
  budgetInput: VisionRequestBudget = DEFAULT_VISION_REQUEST_BUDGET,
  strategyInput: VisionBudgetStrategy = "FAIL"
): PreparedVisionBatch {
  assertArrayInput(sources);
  const budget = RequestBudgetSchema.parse(budgetInput);
  const strategy = VisionBudgetStrategySchema.parse(strategyInput);
  const validatedPurpose = VisionPurposeSchema.parse(purpose);
  if (sources.length > MAX_VISION_REQUEST_CANDIDATES) {
    throw new VisionPreprocessingError(
      "REQUEST_BUDGET_EXCEEDED",
      `Vision batch accepts at most ${String(MAX_VISION_REQUEST_CANDIDATES)} candidate images`
    );
  }

  const candidates: VisionRasterSource[] = [];
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (source === undefined) {
      throw new VisionPreprocessingError("INVALID_IMAGE", "Vision batch candidates must not contain missing entries");
    }
    assertVisionRasterSource(source);
    candidates.push(source);
  }
  Object.freeze(candidates);

  const accepted: PreparedVisionImageRequest[] = [];
  const deferred: string[] = [];
  let totals: VisionRequestBudgetTotals = Object.freeze({ images: 0, totalBytes: 0, totalPixels: 0, cropsOrTiles: 0 });

  for (let index = 0; index < candidates.length; index += 1) {
    const source = candidates[index];
    if (source === undefined) {
      throw new VisionPreprocessingError("INVALID_IMAGE", "Internal vision candidate snapshot is sparse");
    }
    if (wouldExceed(totals, source, budget)) {
      if (strategy === "FAIL") {
        throw new VisionPreprocessingError(
          "REQUEST_BUDGET_EXCEEDED",
          `Vision request at index ${String(index)} exceeds the configured batch budget`
        );
      }
      for (let deferredIndex = index; deferredIndex < candidates.length; deferredIndex += 1) {
        const deferredSource = candidates[deferredIndex];
        if (deferredSource === undefined) {
          throw new VisionPreprocessingError("INVALID_IMAGE", "Vision batch candidates must not contain missing entries");
        }
        deferred.push(imageIdentity(deferredSource));
      }
      break;
    }
    const request = prepareVisionImageRequest(source, validatedPurpose);
    accepted.push(request);
    totals = addTotals(totals, request);
  }

  return Object.freeze({
    requests: Object.freeze(accepted),
    deferredImageIdentities: Object.freeze(deferred),
    truncated: deferred.length > 0,
    totals
  });
}

export function requestPayloadIsSafeReference(
  request: unknown
): request is { readonly payload: ImagePayloadReference } {
  if (typeof request !== "object" || request === null || !("payload" in request)) return false;
  return ImagePayloadReference.isValidatedInstance(request.payload);
}

export function isCropOrTileArtifact(source: unknown): source is VisionImageArtifact {
  return VisionImageArtifact.isValidatedInstance(source)
    && (source.metadata.kind === "CROP" || source.metadata.kind === "TILE");
}
