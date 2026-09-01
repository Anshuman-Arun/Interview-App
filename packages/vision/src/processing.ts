import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";
import { PNG } from "pngjs";
import { snapshotOwnEnumerableRecord } from "./object-validation.js";
import { computeVisionArtifactId } from "./artifact-identity.js";
import { INTERNAL_VISION_ARTIFACT_CONSTRUCTION } from "./internal-artifact-construction.js";
import { assertRectWithinImage, rectArea, validateImageRect, type ImageRect } from "./geometry.js";
import { createVisionProcessingDiagnostics, type VisionProcessingDiagnostics } from "./diagnostics.js";
import {
  CoordinateTransformSchema,
  ImageSnapshot,
  assertVisionRasterSource,
  PixelDimensionsSchema,
  VisionImageArtifact,
  VisionImageArtifactMetadataSchema,
  VisionPreprocessingError,
  visionRasterIdentity,
  type ArtifactSourceBounds,
  type CoordinateTransform,
  type PixelDimensions,
  type VisionImageArtifactKind,
  type VisionRasterIdentity,
  type VisionRasterSource
} from "./types.js";

const DEFAULT_MAX_OUTPUT_ENCODED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_OUTPUT_ENCODED_BYTES = 64 * 1024 * 1024;
const HARD_MAX_OUTPUT_ENCODED_BYTES = 64 * 1024 * 1024;
const HARD_MAX_TOTAL_OUTPUT_ENCODED_BYTES = 128 * 1024 * 1024;
export const HARD_MAX_TOTAL_TILE_PIXELS = 128 * 1024 * 1024;
const COOPERATIVE_YIELD_ROWS = 16;
const MIN_STATIC_PNG_ENCODED_BYTES = 58;
const abortSignalAbortedGetter: () => unknown = (() => {
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    "aborted"
  );
  if (typeof descriptor?.get !== "function") {
    throw new Error("AbortSignal aborted intrinsic is unavailable");
  }
  return descriptor.get;
})();

const DownscaleEnvelopeSchema = z.object({
  maxWidth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxPixels: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();

export interface DownscaleEnvelope {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

export interface DownscalePlan {
  readonly resized: boolean;
  readonly originalWidth: number;
  readonly originalHeight: number;
  readonly resultWidth: number;
  readonly resultHeight: number;
  readonly scale: number;
}

const TileConfigSchema = z.object({
  tileWidth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  tileHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  overlap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  maxTileCount: z.number().int().nonnegative().max(512)
}).strict().superRefine((config, context) => {
  if (config.overlap >= config.tileWidth || config.overlap >= config.tileHeight) {
    context.addIssue({
      code: "custom",
      message: "Tile overlap must be smaller than both tile dimensions"
    });
  }
});

export interface TileConfig {
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly overlap: number;
  readonly maxTileCount: number;
}

export interface TilePlanItem {
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly bounds: ImageRect;
}

export interface ImageTile extends TilePlanItem {
  readonly artifact: VisionImageArtifact;
}

export interface VisionProcessingOptions {
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly maxOutputEncodedBytes?: number;
  readonly maxTotalOutputEncodedBytes?: number;
}

const PROCESSING_OPTION_KEYS = new Set([
  "signal",
  "now",
  "maxOutputEncodedBytes",
  "maxTotalOutputEncodedBytes"
]);
const PLANNING_DIMENSION_FIELDS = new Set(["width", "height"]);
const DOWNSCALE_ENVELOPE_FIELDS = new Set(["maxWidth", "maxHeight", "maxPixels"]);
const TILE_CONFIG_FIELDS = new Set(["tileWidth", "tileHeight", "overlap", "maxTileCount"]);

function isProcessingClock(value: unknown): value is () => number {
  return typeof value === "function" && !isProxy(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  try {
    return value instanceof AbortSignal
      && typeof Reflect.apply(abortSignalAbortedGetter, value, []) === "boolean";
  } catch {
    return false;
  }
}

function normalizeProcessingOptions(input: unknown): Readonly<VisionProcessingOptions> {
  const options = snapshotOwnEnumerableRecord(input, "Vision processing options", PROCESSING_OPTION_KEYS);
  for (const key of Object.keys(options)) {
    if (!PROCESSING_OPTION_KEYS.has(key)) {
      throw new RangeError(`Unknown vision processing option: ${key}`);
    }
  }

  const signal = options["signal"];
  if (signal !== undefined && !isAbortSignal(signal)) {
    throw new TypeError("signal must be an AbortSignal");
  }

  const clock = options["now"];
  if (clock !== undefined && !isProcessingClock(clock)) {
    throw new TypeError("now must be a function");
  }

  const outputBytes = options["maxOutputEncodedBytes"];
  let normalizedOutputBytes: number | undefined;
  if (outputBytes !== undefined) {
    if (typeof outputBytes !== "number") throw new RangeError("maxOutputEncodedBytes must be numeric");
    normalizedOutputBytes = nonnegativeSafeInteger(outputBytes, "maxOutputEncodedBytes");
    if (normalizedOutputBytes > HARD_MAX_OUTPUT_ENCODED_BYTES) {
      throw new RangeError("maxOutputEncodedBytes exceeds the package hard cap");
    }
  }

  const totalOutputBytes = options["maxTotalOutputEncodedBytes"];
  let normalizedTotalOutputBytes: number | undefined;
  if (totalOutputBytes !== undefined) {
    if (typeof totalOutputBytes !== "number") throw new RangeError("maxTotalOutputEncodedBytes must be numeric");
    normalizedTotalOutputBytes = nonnegativeSafeInteger(totalOutputBytes, "maxTotalOutputEncodedBytes");
    if (normalizedTotalOutputBytes > HARD_MAX_TOTAL_OUTPUT_ENCODED_BYTES) {
      throw new RangeError("maxTotalOutputEncodedBytes exceeds the package hard cap");
    }
  }

  return Object.freeze({
    ...(signal === undefined ? {} : { signal }),
    ...(clock === undefined ? {} : { now: clock }),
    ...(normalizedOutputBytes === undefined ? {} : { maxOutputEncodedBytes: normalizedOutputBytes }),
    ...(normalizedTotalOutputBytes === undefined
      ? {}
      : { maxTotalOutputEncodedBytes: normalizedTotalOutputBytes })
  });
}

export interface CropResult {
  readonly artifact: VisionImageArtifact;
  readonly diagnostics: VisionProcessingDiagnostics;
}

export interface ResizeResult {
  readonly image: VisionRasterSource;
  readonly plan: DownscalePlan;
  readonly diagnostics: VisionProcessingDiagnostics;
}

export interface TileResult {
  readonly tiles: readonly ImageTile[];
  readonly diagnostics: VisionProcessingDiagnostics;
}

interface DecodedRaster {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
  readonly gamma: number;
}

interface SourceDescriptor {
  readonly sourceSnapshotId: string;
  readonly sourceRevision: number;
  readonly sourceImageIdentity: VisionRasterIdentity;
  readonly parentArtifactId?: string;
  readonly transform: CoordinateTransform;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function nonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`);
  return value;
}

function parsePlanningDimensions(input: PixelDimensions): PixelDimensions {
  let ownInput: Readonly<Record<string, unknown>>;
  try {
    ownInput = snapshotOwnEnumerableRecord(input, "Planning dimensions", PLANNING_DIMENSION_FIELDS);
  } catch {
    throw new RangeError("Planning dimensions could not be read safely");
  }
  const parsed = PixelDimensionsSchema.safeParse(ownInput);
  if (!parsed.success) throw new RangeError("Planning dimensions must be positive safe integers");
  return parsed.data;
}

function parseDownscaleEnvelope(input: DownscaleEnvelope): DownscaleEnvelope {
  let ownInput: Readonly<Record<string, unknown>>;
  try {
    ownInput = snapshotOwnEnumerableRecord(input, "Downscale envelope", DOWNSCALE_ENVELOPE_FIELDS);
  } catch {
    throw new RangeError("Downscale envelope could not be read safely");
  }
  const parsed = DownscaleEnvelopeSchema.safeParse(ownInput);
  if (!parsed.success) throw new RangeError("Downscale envelope is invalid or contains unknown keys");
  return parsed.data;
}

function parseTileConfig(input: TileConfig): TileConfig {
  let ownInput: Readonly<Record<string, unknown>>;
  try {
    ownInput = snapshotOwnEnumerableRecord(input, "Tile configuration", TILE_CONFIG_FIELDS);
  } catch {
    throw new RangeError("Tile configuration could not be read safely");
  }
  const parsed = TileConfigSchema.safeParse(ownInput);
  if (!parsed.success) throw new RangeError("Tile configuration is invalid or contains unknown keys");
  return parsed.data;
}

function now(options: VisionProcessingOptions): number {
  let value: unknown;
  try {
    value = (options.now ?? (() => globalThis.performance.now()))();
  } catch {
    throw new TypeError("Processing clock could not be evaluated safely");
  }
  if (typeof value !== "number"
      || !Number.isFinite(value)
      || value < 0
      || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Processing clock must return a nonnegative finite value within safe numeric range");
  }
  return value;
}

function elapsed(startedAt: number, options: VisionProcessingOptions): number {
  const endedAt = now(options);
  if (endedAt < startedAt) {
    throw new RangeError("Processing clock moved backward during the operation");
  }
  return endedAt - startedAt;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal === undefined) return;
  let aborted: unknown;
  try {
    aborted = Reflect.apply(abortSignalAbortedGetter, signal, []);
  } catch {
    throw new TypeError("AbortSignal could not be read safely");
  }
  if (aborted === true) {
    throw new VisionPreprocessingError("CANCELLED", "Image processing was cancelled");
  }
}

async function cooperativeYield(signal: AbortSignal | undefined, row: number): Promise<void> {
  if (signal === undefined || row % COOPERATIVE_YIELD_ROWS !== 0) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  throwIfAborted(signal);
}

async function yieldForCancellation(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  throwIfAborted(signal);
}

function maxOutputBytes(options: VisionProcessingOptions): number {
  const perImage = nonnegativeSafeInteger(
    options.maxOutputEncodedBytes ?? DEFAULT_MAX_OUTPUT_ENCODED_BYTES,
    "maxOutputEncodedBytes"
  );
  if (perImage > HARD_MAX_OUTPUT_ENCODED_BYTES) {
    throw new RangeError("maxOutputEncodedBytes exceeds the package hard cap");
  }

  const total = nonnegativeSafeInteger(
    options.maxTotalOutputEncodedBytes ?? DEFAULT_MAX_TOTAL_OUTPUT_ENCODED_BYTES,
    "maxTotalOutputEncodedBytes"
  );
  if (total > HARD_MAX_TOTAL_OUTPUT_ENCODED_BYTES) {
    throw new RangeError("maxTotalOutputEncodedBytes exceeds the package hard cap");
  }
  return Math.min(perImage, total);
}

function assertPngOutputPossible(maximumOutputBytes: number, context: string): void {
  if (maximumOutputBytes < MIN_STATIC_PNG_ENCODED_BYTES) {
    throw new VisionPreprocessingError(
      "OUTPUT_TOO_LARGE_BYTES",
      `${context} byte ceiling is too small to contain any valid PNG output`
    );
  }
}

function maxTotalOutputBytes(options: VisionProcessingOptions): number {
  const value = nonnegativeSafeInteger(
    options.maxTotalOutputEncodedBytes ?? DEFAULT_MAX_TOTAL_OUTPUT_ENCODED_BYTES,
    "maxTotalOutputEncodedBytes"
  );
  if (value > HARD_MAX_TOTAL_OUTPUT_ENCODED_BYTES) {
    throw new RangeError("maxTotalOutputEncodedBytes exceeds the package hard cap");
  }
  return value;
}

function sourceDescriptor(source: VisionRasterSource): SourceDescriptor {
  assertVisionRasterSource(source);
  if (ImageSnapshot.isValidatedInstance(source)) {
    return {
      sourceSnapshotId: source.metadata.snapshotId,
      sourceRevision: source.metadata.sourceRevision,
      sourceImageIdentity: visionRasterIdentity(source),
      transform: Object.freeze({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 })
    };
  }
  return {
    sourceSnapshotId: source.metadata.sourceSnapshotId,
    sourceRevision: source.metadata.sourceRevision,
    sourceImageIdentity: visionRasterIdentity(source),
    parentArtifactId: source.metadata.artifactId,
    transform: source.metadata.coordinateTransform
  };
}

function decodeSource(source: VisionRasterSource, signal?: AbortSignal): DecodedRaster {
  assertVisionRasterSource(source);
  throwIfAborted(signal);
  let decoded: ReturnType<typeof PNG.sync.read>;
  try {
    decoded = PNG.sync.read(source.readBytes(), { checkCRC: false });
  } catch {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Previously validated image payload could not be decoded");
  }
  throwIfAborted(signal);
  const gamma = decoded.gamma ?? 0;
  if (!Number.isFinite(gamma) || gamma < 0) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Decoded PNG gamma metadata is invalid");
  }
  if (decoded.width !== source.metadata.width || decoded.height !== source.metadata.height) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Decoded image dimensions changed after validation");
  }
  const expectedLength = decoded.width * decoded.height * 4;
  if (!Number.isSafeInteger(expectedLength) || decoded.data.length !== expectedLength) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Decoded image raster has an unexpected byte length");
  }
  return {
    width: decoded.width,
    height: decoded.height,
    data: decoded.data,
    gamma
  };
}

function composeCropTransform(parent: CoordinateTransform, rect: ImageRect): CoordinateTransform {
  return CoordinateTransformSchema.parse({
    offsetX: parent.offsetX + rect.x * parent.scaleX,
    offsetY: parent.offsetY + rect.y * parent.scaleY,
    scaleX: parent.scaleX,
    scaleY: parent.scaleY
  });
}

function composeResizeTransform(
  parent: CoordinateTransform,
  sourceDimensions: PixelDimensions,
  outputDimensions: PixelDimensions
): CoordinateTransform {
  return CoordinateTransformSchema.parse({
    offsetX: parent.offsetX,
    offsetY: parent.offsetY,
    scaleX: parent.scaleX * sourceDimensions.width / outputDimensions.width,
    scaleY: parent.scaleY * sourceDimensions.height / outputDimensions.height
  });
}

function encodeArtifact(
  source: VisionRasterSource,
  kind: VisionImageArtifactKind,
  raster: DecodedRaster,
  sourceBounds: ArtifactSourceBounds,
  transform: CoordinateTransform,
  options: VisionProcessingOptions
): VisionImageArtifact {
  throwIfAborted(options.signal);
  assertRectWithinImage(sourceBounds, {
    width: source.metadata.width,
    height: source.metadata.height
  });
  const maximumOutputBytes = maxOutputBytes(options);
  let encoded: Buffer;
  try {
    encoded = PNG.sync.write(
      {
        width: raster.width,
        height: raster.height,
        data: raster.data,
        ...(raster.gamma === 0 ? {} : { gamma: raster.gamma })
      },
      { colorType: 6, inputColorType: 6, bitDepth: 8 }
    );
  } catch {
    throw new VisionPreprocessingError("INVALID_IMAGE", "PNG encoding failed");
  }
  if (encoded.length > maximumOutputBytes) {
    throw new VisionPreprocessingError("OUTPUT_TOO_LARGE_BYTES", "Processed image exceeds configured output byte limit");
  }
  throwIfAborted(options.signal);

  const descriptor = sourceDescriptor(source);
  const dimensions = PixelDimensionsSchema.parse({ width: raster.width, height: raster.height });
  const digest = createHash("sha256").update(encoded).digest("hex");
  const metadata = VisionImageArtifactMetadataSchema.parse({
    artifactId: computeVisionArtifactId({
      kind,
      sourceSnapshotId: descriptor.sourceSnapshotId,
      sourceRevision: descriptor.sourceRevision,
      sourceImageIdentity: descriptor.sourceImageIdentity,
      parentArtifactId: descriptor.parentArtifactId,
      width: dimensions.width,
      height: dimensions.height,
      sourceBounds,
      coordinateTransform: transform,
      contentDigest: digest
    }),
    kind,
    sourceSnapshotId: descriptor.sourceSnapshotId,
    sourceRevision: descriptor.sourceRevision,
    sourceImageIdentity: descriptor.sourceImageIdentity,
    ...(descriptor.parentArtifactId === undefined ? {} : { parentArtifactId: descriptor.parentArtifactId }),
    width: raster.width,
    height: raster.height,
    mimeType: "image/png",
    encoding: "PNG",
    byteSize: encoded.length,
    contentDigest: digest,
    sourceBounds,
    coordinateTransform: transform
  });
  return new VisionImageArtifact(
    INTERNAL_VISION_ARTIFACT_CONSTRUCTION,
    source,
    metadata,
    encoded
  );
}

async function cropDecodedRaster(
  decoded: DecodedRaster,
  rect: ImageRect,
  signal: AbortSignal | undefined
): Promise<DecodedRaster> {
  const output = Buffer.allocUnsafe(rect.width * rect.height * 4);
  const rowBytes = rect.width * 4;
  for (let row = 0; row < rect.height; row += 1) {
    const sourceStart = ((rect.y + row) * decoded.width + rect.x) * 4;
    const targetStart = row * rowBytes;
    decoded.data.copy(output, targetStart, sourceStart, sourceStart + rowBytes);
    await cooperativeYield(signal, row + 1);
  }
  throwIfAborted(signal);
  return { width: rect.width, height: rect.height, data: output, gamma: decoded.gamma };
}

export async function cropImage(
  source: VisionRasterSource,
  bounds: ImageRect,
  options: VisionProcessingOptions = {}
): Promise<CropResult> {
  const safeOptions = normalizeProcessingOptions(options);
  throwIfAborted(safeOptions.signal);
  const startedAt = now(safeOptions);
  throwIfAborted(safeOptions.signal);
  assertVisionRasterSource(source);
  const maximumOutputBytes = maxOutputBytes(safeOptions);
  assertPngOutputPossible(maximumOutputBytes, "Configured output");
  const rect = assertRectWithinImage(validateImageRect(bounds), {
    width: source.metadata.width,
    height: source.metadata.height
  });
  const decoded = decodeSource(source, safeOptions.signal);
  await yieldForCancellation(safeOptions.signal);
  const cropped = await cropDecodedRaster(decoded, rect, safeOptions.signal);
  const descriptor = sourceDescriptor(source);
  const transform = composeCropTransform(descriptor.transform, rect);
  const artifact = encodeArtifact(source, "CROP", cropped, rect, transform, safeOptions);
  await yieldForCancellation(safeOptions.signal);

  const diagnostics = createVisionProcessingDiagnostics({
    operation: "CROP",
    sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
    outputDimensions: { width: artifact.metadata.width, height: artifact.metadata.height },
    inputBytes: source.metadata.byteSize,
    outputBytes: artifact.metadata.byteSize,
    cropCount: 1,
    tileCount: 0,
    durationMs: elapsed(startedAt, safeOptions),
    outcome: "SUCCESS"
  });
  throwIfAborted(safeOptions.signal);
  return Object.freeze({ artifact, diagnostics });
}

export function planDownscale(dimensions: PixelDimensions, envelope: DownscaleEnvelope): DownscalePlan {
  const source = parsePlanningDimensions(dimensions);
  const limits = parseDownscaleEnvelope(envelope);
  const sourcePixels = source.width * source.height;
  if (!Number.isSafeInteger(sourcePixels)) throw new RangeError("Source pixel count exceeds safe integer range");
  const pixelScale = Math.sqrt(limits.maxPixels / sourcePixels);
  const scale = Math.min(1, limits.maxWidth / source.width, limits.maxHeight / source.height, pixelScale);

  if (scale >= 1) {
    return Object.freeze({
      resized: false,
      originalWidth: source.width,
      originalHeight: source.height,
      resultWidth: source.width,
      resultHeight: source.height,
      scale: 1
    });
  }

  let resultWidth = Math.min(limits.maxWidth, Math.max(1, Math.round(source.width * scale)));
  let resultHeight = Math.min(limits.maxHeight, Math.max(1, Math.round(source.height * scale)));
  const plannedPixels = resultWidth * resultHeight;
  if (!Number.isSafeInteger(plannedPixels)) throw new RangeError("Planned pixel count exceeds safe integer range");
  if (plannedPixels > limits.maxPixels) {
    const candidates: Array<readonly [number, number]> = [];
    const widthForCurrentHeight = Math.floor(limits.maxPixels / resultHeight);
    if (widthForCurrentHeight >= 1) {
      candidates.push([Math.min(resultWidth, widthForCurrentHeight), resultHeight]);
    }
    const heightForCurrentWidth = Math.floor(limits.maxPixels / resultWidth);
    if (heightForCurrentWidth >= 1) {
      candidates.push([resultWidth, Math.min(resultHeight, heightForCurrentWidth)]);
    }
    candidates.push([Math.min(resultWidth, limits.maxPixels), 1]);
    candidates.push([1, Math.min(resultHeight, limits.maxPixels)]);

    const validCandidates = candidates.filter(([width, height]) =>
      width >= 1
      && height >= 1
      && width <= limits.maxWidth
      && height <= limits.maxHeight
      && Number.isSafeInteger(width * height)
      && width * height <= limits.maxPixels
    );
    if (validCandidates.length === 0) {
      throw new RangeError("Downscale plan cannot satisfy the requested pixel envelope");
    }

    validCandidates.sort((left, right) => {
      const leftError = Math.abs(left[0] / source.width - left[1] / source.height);
      const rightError = Math.abs(right[0] / source.width - right[1] / source.height);
      if (leftError !== rightError) return leftError - rightError;
      const leftPixels = left[0] * left[1];
      const rightPixels = right[0] * right[1];
      if (leftPixels !== rightPixels) return rightPixels - leftPixels;
      return right[0] - left[0] || right[1] - left[1];
    });
    const best = validCandidates[0];
    if (best === undefined) throw new RangeError("Downscale plan candidate selection failed");
    [resultWidth, resultHeight] = best;
  }

  const finalPixels = resultWidth * resultHeight;
  if (!Number.isSafeInteger(finalPixels) || finalPixels > limits.maxPixels) {
    throw new RangeError("Downscale plan exceeds the requested pixel envelope");
  }

  return Object.freeze({
    resized: true,
    originalWidth: source.width,
    originalHeight: source.height,
    resultWidth,
    resultHeight,
    scale: Math.min(resultWidth / source.width, resultHeight / source.height)
  });
}

async function resizeBilinear(
  source: DecodedRaster,
  width: number,
  height: number,
  signal: AbortSignal | undefined
): Promise<DecodedRaster> {
  const output = Buffer.allocUnsafe(width * height * 4);
  const scaleX = source.width / width;
  const scaleY = source.height / height;

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = sourceY - y0;

    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(source.width - 1, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const outputIndex = (y * width + x) * 4;
      const index00 = (y0 * source.width + x0) * 4;
      const index10 = (y0 * source.width + x1) * 4;
      const index01 = (y1 * source.width + x0) * 4;
      const index11 = (y1 * source.width + x1) * 4;
      const alpha00 = source.data[index00 + 3];
      const alpha10 = source.data[index10 + 3];
      const alpha01 = source.data[index01 + 3];
      const alpha11 = source.data[index11 + 3];
      if (alpha00 === undefined || alpha10 === undefined || alpha01 === undefined || alpha11 === undefined) {
        throw new Error("Raster indexing exceeded decoded image bounds");
      }

      const weight00 = (1 - fx) * (1 - fy);
      const weight10 = fx * (1 - fy);
      const weight01 = (1 - fx) * fy;
      const weight11 = fx * fy;
      const normalizedAlpha00 = alpha00 / 255;
      const normalizedAlpha10 = alpha10 / 255;
      const normalizedAlpha01 = alpha01 / 255;
      const normalizedAlpha11 = alpha11 / 255;
      const outputAlpha = normalizedAlpha00 * weight00
        + normalizedAlpha10 * weight10
        + normalizedAlpha01 * weight01
        + normalizedAlpha11 * weight11;

      for (let channel = 0; channel < 3; channel += 1) {
        const p00 = source.data[index00 + channel];
        const p10 = source.data[index10 + channel];
        const p01 = source.data[index01 + channel];
        const p11 = source.data[index11 + channel];
        if (p00 === undefined || p10 === undefined || p01 === undefined || p11 === undefined) {
          throw new Error("Raster indexing exceeded decoded image bounds");
        }
        const premultiplied = p00 * normalizedAlpha00 * weight00
          + p10 * normalizedAlpha10 * weight10
          + p01 * normalizedAlpha01 * weight01
          + p11 * normalizedAlpha11 * weight11;
        output[outputIndex + channel] = outputAlpha === 0
          ? 0
          : Math.round(premultiplied / outputAlpha);
      }
      output[outputIndex + 3] = Math.round(outputAlpha * 255);
    }
    await cooperativeYield(signal, y + 1);
  }
  throwIfAborted(signal);
  return { width, height, data: output, gamma: source.gamma };
}

export async function downscaleImage(
  source: VisionRasterSource,
  envelope: DownscaleEnvelope,
  options: VisionProcessingOptions = {}
): Promise<ResizeResult> {
  const safeOptions = normalizeProcessingOptions(options);
  throwIfAborted(safeOptions.signal);
  const startedAt = now(safeOptions);
  throwIfAborted(safeOptions.signal);
  assertVisionRasterSource(source);
  const maximumOutputBytes = maxOutputBytes(safeOptions);
  assertPngOutputPossible(maximumOutputBytes, "Configured output");
  const plan = planDownscale({ width: source.metadata.width, height: source.metadata.height }, envelope);

  if (!plan.resized) {
    if (source.metadata.byteSize > maximumOutputBytes) {
      throw new VisionPreprocessingError(
        "OUTPUT_TOO_LARGE_BYTES",
        "Unchanged image exceeds the configured output byte limit"
      );
    }
    await yieldForCancellation(safeOptions.signal);
    const diagnostics = createVisionProcessingDiagnostics({
      operation: "RESIZE",
      sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
      outputDimensions: { width: source.metadata.width, height: source.metadata.height },
      inputBytes: source.metadata.byteSize,
      outputBytes: source.metadata.byteSize,
      cropCount: 0,
      tileCount: 0,
      durationMs: elapsed(startedAt, safeOptions),
      outcome: "SUCCESS"
    });
    throwIfAborted(safeOptions.signal);
    return Object.freeze({ image: source, plan, diagnostics });
  }

  const decoded = decodeSource(source, safeOptions.signal);
  await yieldForCancellation(safeOptions.signal);
  const resized = await resizeBilinear(decoded, plan.resultWidth, plan.resultHeight, safeOptions.signal);
  const descriptor = sourceDescriptor(source);
  const transform = composeResizeTransform(
    descriptor.transform,
    { width: source.metadata.width, height: source.metadata.height },
    { width: plan.resultWidth, height: plan.resultHeight }
  );
  const resizeSourceBounds = Object.freeze({
    x: 0,
    y: 0,
    width: source.metadata.width,
    height: source.metadata.height
  });
  const artifact = encodeArtifact(source, "RESIZED", resized, resizeSourceBounds, transform, safeOptions);
  await yieldForCancellation(safeOptions.signal);

  const diagnostics = createVisionProcessingDiagnostics({
    operation: "RESIZE",
    sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
    outputDimensions: { width: artifact.metadata.width, height: artifact.metadata.height },
    inputBytes: source.metadata.byteSize,
    outputBytes: artifact.metadata.byteSize,
    cropCount: 0,
    tileCount: 0,
    durationMs: elapsed(startedAt, safeOptions),
    outcome: "SUCCESS"
  });
  throwIfAborted(safeOptions.signal);
  return Object.freeze({ image: artifact, plan, diagnostics });
}

function axisTileCount(length: number, tileSize: number, overlap: number): number {
  if (length <= tileSize) return 1;
  const step = tileSize - overlap;
  if (step <= 0) throw new RangeError("Tile overlap must be smaller than both tile dimensions");
  const count = 1 + Math.ceil((length - tileSize) / step);
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError("Tile axis count exceeds safe integer range");
  return count;
}

function axisPositions(length: number, tileSize: number, overlap: number, count: number): readonly number[] {
  if (count === 1) return Object.freeze([0]);
  const step = tileSize - overlap;
  const positions: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const position = index * step;
    if (!Number.isSafeInteger(position) || position >= length) {
      throw new RangeError("Tile position exceeds safe image coordinates");
    }
    positions.push(position);
  }
  return Object.freeze(positions);
}

export function planImageTiles(dimensions: PixelDimensions, config: TileConfig): readonly TilePlanItem[] {
  const source = parsePlanningDimensions(dimensions);
  const safeConfig = parseTileConfig(config);
  if (safeConfig.overlap >= safeConfig.tileWidth || safeConfig.overlap >= safeConfig.tileHeight) {
    throw new RangeError("Tile overlap must be smaller than tile width and tile height");
  }

  const xCount = axisTileCount(source.width, safeConfig.tileWidth, safeConfig.overlap);
  const yCount = axisTileCount(source.height, safeConfig.tileHeight, safeConfig.overlap);
  const tileCount = xCount * yCount;
  if (!Number.isSafeInteger(tileCount) || tileCount > safeConfig.maxTileCount) {
    throw new VisionPreprocessingError("TILE_LIMIT_EXCEEDED", "Tiling would exceed the configured maximum tile count");
  }
  const xPositions = axisPositions(source.width, safeConfig.tileWidth, safeConfig.overlap, xCount);
  const yPositions = axisPositions(source.height, safeConfig.tileHeight, safeConfig.overlap, yCount);

  const tiles: TilePlanItem[] = [];
  let totalTilePixels = 0;
  for (let row = 0; row < yPositions.length; row += 1) {
    const y = yPositions[row];
    if (y === undefined) continue;
    for (let column = 0; column < xPositions.length; column += 1) {
      const x = xPositions[column];
      if (x === undefined) continue;
      const bounds = validateImageRect({
        x,
        y,
        width: Math.min(safeConfig.tileWidth, source.width - x),
        height: Math.min(safeConfig.tileHeight, source.height - y)
      });
      let tilePixels: number;
      try {
        tilePixels = rectArea(bounds);
      } catch {
        throw new VisionPreprocessingError(
          "TILE_LIMIT_EXCEEDED",
          "Tile pixel area exceeds the planner's safe numeric range"
        );
      }
      totalTilePixels += tilePixels;
      if (!Number.isSafeInteger(totalTilePixels) || totalTilePixels > HARD_MAX_TOTAL_TILE_PIXELS) {
        throw new VisionPreprocessingError(
          "TILE_LIMIT_EXCEEDED",
          "Tiling would exceed the package hard total-tile-pixel limit"
        );
      }
      tiles.push(Object.freeze({ index: tiles.length, row, column, bounds }));
    }
  }
  return Object.freeze(tiles);
}

export async function tileImage(
  source: VisionRasterSource,
  config: TileConfig,
  options: VisionProcessingOptions = {}
): Promise<TileResult> {
  const safeOptions = normalizeProcessingOptions(options);
  throwIfAborted(safeOptions.signal);
  const startedAt = now(safeOptions);
  throwIfAborted(safeOptions.signal);
  assertVisionRasterSource(source);
  const maximumOutputBytes = maxOutputBytes(safeOptions);
  const maximumTotalOutputBytes = maxTotalOutputBytes(safeOptions);
  assertPngOutputPossible(maximumOutputBytes, "Configured tile output");
  assertPngOutputPossible(maximumTotalOutputBytes, "Configured combined tile output");
  const plan = planImageTiles({ width: source.metadata.width, height: source.metadata.height }, config);
  const minimumCombinedOutputBytes = plan.length * MIN_STATIC_PNG_ENCODED_BYTES;
  if (!Number.isSafeInteger(minimumCombinedOutputBytes)
      || minimumCombinedOutputBytes > maximumTotalOutputBytes) {
    throw new VisionPreprocessingError(
      "OUTPUT_TOO_LARGE_BYTES",
      "Combined tile byte ceiling cannot contain the planned number of PNG tiles"
    );
  }
  const decoded = decodeSource(source, safeOptions.signal);
  await yieldForCancellation(safeOptions.signal);
  const descriptor = sourceDescriptor(source);
  const tiles: ImageTile[] = [];
  let totalOutputBytes = 0;

  for (const item of plan) {
    throwIfAborted(safeOptions.signal);
    const raster = await cropDecodedRaster(decoded, item.bounds, safeOptions.signal);
    const transform = composeCropTransform(descriptor.transform, item.bounds);
    const artifact = encodeArtifact(source, "TILE", raster, item.bounds, transform, safeOptions);
    totalOutputBytes += artifact.metadata.byteSize;
    if (!Number.isSafeInteger(totalOutputBytes) || totalOutputBytes > maximumTotalOutputBytes) {
      throw new VisionPreprocessingError(
        "OUTPUT_TOO_LARGE_BYTES",
        "Combined tile output exceeds configured processing byte limit"
      );
    }
    tiles.push(Object.freeze({ ...item, artifact }));
    await cooperativeYield(safeOptions.signal, item.index + 1);
  }
  await yieldForCancellation(safeOptions.signal);

  const diagnostics = createVisionProcessingDiagnostics({
    operation: "TILE",
    sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
    inputBytes: source.metadata.byteSize,
    outputBytes: totalOutputBytes,
    cropCount: 0,
    tileCount: tiles.length,
    durationMs: elapsed(startedAt, safeOptions),
    outcome: "SUCCESS"
  });
  throwIfAborted(safeOptions.signal);
  return Object.freeze({ tiles: Object.freeze(tiles), diagnostics });
}
