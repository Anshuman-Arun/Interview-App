import { createHash } from "node:crypto";
import { z } from "zod";
import { PNG } from "pngjs";
import { assertRectWithinImage, validateImageRect, type ImageRect } from "./geometry.js";
import { createVisionProcessingDiagnostics, type VisionProcessingDiagnostics } from "./diagnostics.js";
import { sha256ImageBytes } from "./snapshot.js";
import {
  CoordinateTransformSchema,
  ImageSnapshot,
  PixelDimensionsSchema,
  VisionImageArtifact,
  VisionImageArtifactMetadataSchema,
  VisionPreprocessingError,
  type CoordinateTransform,
  type PixelDimensions,
  type VisionImageArtifactKind,
  type VisionRasterSource
} from "./types.js";

const DEFAULT_MAX_OUTPUT_ENCODED_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_OUTPUT_ENCODED_BYTES = 64 * 1024 * 1024;
const COOPERATIVE_YIELD_ROWS = 16;

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
  maxTileCount: z.number().int().positive().max(512)
}).strict();

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
}

interface SourceDescriptor {
  readonly sourceSnapshotId: string;
  readonly sourceRevision: number;
  readonly parentArtifactId?: string;
  readonly transform: CoordinateTransform;
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function now(options: VisionProcessingOptions): number {
  const value = (options.now ?? (() => globalThis.performance.now()))();
  if (!Number.isFinite(value)) throw new RangeError("Processing clock must return a finite number");
  return value;
}

function elapsed(startedAt: number, options: VisionProcessingOptions): number {
  return Math.max(0, now(options) - startedAt);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
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

function maxOutputBytes(options: VisionProcessingOptions): number {
  return positiveSafeInteger(options.maxOutputEncodedBytes ?? DEFAULT_MAX_OUTPUT_ENCODED_BYTES, "maxOutputEncodedBytes");
}

function maxTotalOutputBytes(options: VisionProcessingOptions): number {
  return positiveSafeInteger(
    options.maxTotalOutputEncodedBytes ?? DEFAULT_MAX_TOTAL_OUTPUT_ENCODED_BYTES,
    "maxTotalOutputEncodedBytes"
  );
}

function sourceDescriptor(source: VisionRasterSource): SourceDescriptor {
  if (source instanceof ImageSnapshot) {
    return {
      sourceSnapshotId: source.metadata.snapshotId,
      sourceRevision: source.metadata.sourceRevision,
      transform: Object.freeze({ offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 })
    };
  }
  return {
    sourceSnapshotId: source.metadata.sourceSnapshotId,
    sourceRevision: source.metadata.sourceRevision,
    parentArtifactId: source.metadata.artifactId,
    transform: source.metadata.coordinateTransform
  };
}

function decodeSource(source: VisionRasterSource): DecodedRaster {
  let decoded: ReturnType<typeof PNG.sync.read>;
  try {
    decoded = PNG.sync.read(Buffer.from(source.readBytes()), { checkCRC: true });
  } catch {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Previously validated image payload could not be decoded");
  }
  if (decoded.width !== source.metadata.width || decoded.height !== source.metadata.height) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Decoded image dimensions changed after validation");
  }
  const expectedLength = decoded.width * decoded.height * 4;
  if (!Number.isSafeInteger(expectedLength) || decoded.data.length !== expectedLength) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Decoded image raster has an unexpected byte length");
  }
  return { width: decoded.width, height: decoded.height, data: Buffer.from(decoded.data) };
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

function artifactId(
  kind: VisionImageArtifactKind,
  sourceSnapshotId: string,
  sourceRevision: number,
  parentArtifactId: string | undefined,
  dimensions: PixelDimensions,
  transform: CoordinateTransform,
  digest: string
): string {
  const canonical = [
    "vision-artifact-v1",
    kind,
    sourceSnapshotId,
    String(sourceRevision),
    parentArtifactId ?? "",
    String(dimensions.width),
    String(dimensions.height),
    String(transform.offsetX),
    String(transform.offsetY),
    String(transform.scaleX),
    String(transform.scaleY),
    digest
  ].join("\u0000");
  return `img_${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function encodeArtifact(
  source: VisionRasterSource,
  kind: VisionImageArtifactKind,
  raster: DecodedRaster,
  transform: CoordinateTransform,
  options: VisionProcessingOptions
): VisionImageArtifact {
  let encoded: Buffer;
  try {
    encoded = PNG.sync.write(
      { width: raster.width, height: raster.height, data: raster.data },
      { colorType: 6, inputColorType: 6, bitDepth: 8 }
    );
  } catch {
    throw new VisionPreprocessingError("INVALID_IMAGE", "PNG encoding failed");
  }
  if (encoded.length > maxOutputBytes(options)) {
    throw new VisionPreprocessingError("OUTPUT_TOO_LARGE_BYTES", "Processed image exceeds configured output byte limit");
  }
  throwIfAborted(options.signal);

  const descriptor = sourceDescriptor(source);
  const dimensions = PixelDimensionsSchema.parse({ width: raster.width, height: raster.height });
  const digest = sha256ImageBytes(encoded);
  const metadata = VisionImageArtifactMetadataSchema.parse({
    artifactId: artifactId(
      kind,
      descriptor.sourceSnapshotId,
      descriptor.sourceRevision,
      descriptor.parentArtifactId,
      dimensions,
      transform,
      digest
    ),
    kind,
    sourceSnapshotId: descriptor.sourceSnapshotId,
    sourceRevision: descriptor.sourceRevision,
    ...(descriptor.parentArtifactId === undefined ? {} : { parentArtifactId: descriptor.parentArtifactId }),
    width: raster.width,
    height: raster.height,
    mimeType: "image/png",
    encoding: "PNG",
    byteSize: encoded.length,
    contentDigest: digest,
    coordinateTransform: transform
  });
  return new VisionImageArtifact(metadata, encoded);
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
  return { width: rect.width, height: rect.height, data: output };
}

export async function cropImage(
  source: VisionRasterSource,
  bounds: ImageRect,
  options: VisionProcessingOptions = {}
): Promise<CropResult> {
  const startedAt = now(options);
  throwIfAborted(options.signal);
  const rect = assertRectWithinImage(validateImageRect(bounds), {
    width: source.metadata.width,
    height: source.metadata.height
  });
  const decoded = decodeSource(source);
  const cropped = await cropDecodedRaster(decoded, rect, options.signal);
  const descriptor = sourceDescriptor(source);
  const transform = composeCropTransform(descriptor.transform, rect);
  const artifact = encodeArtifact(source, "CROP", cropped, transform, options);
  throwIfAborted(options.signal);

  return Object.freeze({
    artifact,
    diagnostics: createVisionProcessingDiagnostics({
      operation: "CROP",
      sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
      outputDimensions: { width: artifact.metadata.width, height: artifact.metadata.height },
      inputBytes: source.metadata.byteSize,
      outputBytes: artifact.metadata.byteSize,
      cropCount: 1,
      tileCount: 0,
      durationMs: elapsed(startedAt, options),
      outcome: "SUCCESS"
    })
  });
}

export function planDownscale(dimensions: PixelDimensions, envelope: DownscaleEnvelope): DownscalePlan {
  const source = PixelDimensionsSchema.parse(dimensions);
  const limits = DownscaleEnvelopeSchema.parse(envelope);
  const pixelScale = Math.sqrt(limits.maxPixels / (source.width * source.height));
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

  let resultWidth = Math.max(1, Math.floor(source.width * scale));
  let resultHeight = Math.max(1, Math.floor(source.height * scale));
  while (resultWidth * resultHeight > limits.maxPixels) {
    if (resultWidth >= resultHeight && resultWidth > 1) resultWidth -= 1;
    else if (resultHeight > 1) resultHeight -= 1;
    else break;
  }
  resultWidth = Math.min(resultWidth, limits.maxWidth);
  resultHeight = Math.min(resultHeight, limits.maxHeight);

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

      for (let channel = 0; channel < 4; channel += 1) {
        const p00 = source.data[(y0 * source.width + x0) * 4 + channel];
        const p10 = source.data[(y0 * source.width + x1) * 4 + channel];
        const p01 = source.data[(y1 * source.width + x0) * 4 + channel];
        const p11 = source.data[(y1 * source.width + x1) * 4 + channel];
        if (p00 === undefined || p10 === undefined || p01 === undefined || p11 === undefined) {
          throw new Error("Raster indexing exceeded decoded image bounds");
        }
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        output[outputIndex + channel] = Math.round(top + (bottom - top) * fy);
      }
    }
    await cooperativeYield(signal, y + 1);
  }
  throwIfAborted(signal);
  return { width, height, data: output };
}

export async function downscaleImage(
  source: VisionRasterSource,
  envelope: DownscaleEnvelope,
  options: VisionProcessingOptions = {}
): Promise<ResizeResult> {
  const startedAt = now(options);
  throwIfAborted(options.signal);
  const plan = planDownscale({ width: source.metadata.width, height: source.metadata.height }, envelope);

  if (!plan.resized) {
    throwIfAborted(options.signal);
    return Object.freeze({
      image: source,
      plan,
      diagnostics: createVisionProcessingDiagnostics({
        operation: "RESIZE",
        sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
        outputDimensions: { width: source.metadata.width, height: source.metadata.height },
        inputBytes: source.metadata.byteSize,
        outputBytes: source.metadata.byteSize,
        cropCount: 0,
        tileCount: 0,
        durationMs: elapsed(startedAt, options),
        outcome: "SUCCESS"
      })
    });
  }

  const decoded = decodeSource(source);
  const resized = await resizeBilinear(decoded, plan.resultWidth, plan.resultHeight, options.signal);
  const descriptor = sourceDescriptor(source);
  const transform = composeResizeTransform(
    descriptor.transform,
    { width: source.metadata.width, height: source.metadata.height },
    { width: plan.resultWidth, height: plan.resultHeight }
  );
  const artifact = encodeArtifact(source, "RESIZED", resized, transform, options);
  throwIfAborted(options.signal);

  return Object.freeze({
    image: artifact,
    plan,
    diagnostics: createVisionProcessingDiagnostics({
      operation: "RESIZE",
      sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
      outputDimensions: { width: artifact.metadata.width, height: artifact.metadata.height },
      inputBytes: source.metadata.byteSize,
      outputBytes: artifact.metadata.byteSize,
      cropCount: 0,
      tileCount: 0,
      durationMs: elapsed(startedAt, options),
      outcome: "SUCCESS"
    })
  });
}

function axisPositions(length: number, tileSize: number, overlap: number): readonly number[] {
  if (length <= tileSize) return Object.freeze([0]);
  const step = tileSize - overlap;
  if (step <= 0) throw new RangeError("Tile overlap must be smaller than both tile dimensions");

  const positions: number[] = [];
  let position = 0;
  while (true) {
    positions.push(position);
    if (position + tileSize >= length) break;
    const next = Math.min(position + step, length - tileSize);
    if (next <= position) break;
    position = next;
  }
  return Object.freeze(positions);
}

export function planImageTiles(dimensions: PixelDimensions, config: TileConfig): readonly TilePlanItem[] {
  const source = PixelDimensionsSchema.parse(dimensions);
  const safeConfig = TileConfigSchema.parse(config);
  if (safeConfig.overlap >= safeConfig.tileWidth || safeConfig.overlap >= safeConfig.tileHeight) {
    throw new RangeError("Tile overlap must be smaller than tile width and tile height");
  }

  const xPositions = axisPositions(source.width, safeConfig.tileWidth, safeConfig.overlap);
  const yPositions = axisPositions(source.height, safeConfig.tileHeight, safeConfig.overlap);
  const tileCount = xPositions.length * yPositions.length;
  if (!Number.isSafeInteger(tileCount) || tileCount > safeConfig.maxTileCount) {
    throw new VisionPreprocessingError("TILE_LIMIT_EXCEEDED", "Tiling would exceed the configured maximum tile count");
  }

  const tiles: TilePlanItem[] = [];
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
  const startedAt = now(options);
  throwIfAborted(options.signal);
  const plan = planImageTiles({ width: source.metadata.width, height: source.metadata.height }, config);
  const decoded = decodeSource(source);
  const descriptor = sourceDescriptor(source);
  const tiles: ImageTile[] = [];
  let totalOutputBytes = 0;
  const maximumTotalOutputBytes = maxTotalOutputBytes(options);

  for (const item of plan) {
    throwIfAborted(options.signal);
    const raster = await cropDecodedRaster(decoded, item.bounds, options.signal);
    const transform = composeCropTransform(descriptor.transform, item.bounds);
    const artifact = encodeArtifact(source, "TILE", raster, transform, options);
    totalOutputBytes += artifact.metadata.byteSize;
    if (!Number.isSafeInteger(totalOutputBytes) || totalOutputBytes > maximumTotalOutputBytes) {
      throw new VisionPreprocessingError(
        "OUTPUT_TOO_LARGE_BYTES",
        "Combined tile output exceeds configured processing byte limit"
      );
    }
    tiles.push(Object.freeze({ ...item, artifact }));
  }
  throwIfAborted(options.signal);

  return Object.freeze({
    tiles: Object.freeze(tiles),
    diagnostics: createVisionProcessingDiagnostics({
      operation: "TILE",
      sourceDimensions: { width: source.metadata.width, height: source.metadata.height },
      inputBytes: source.metadata.byteSize,
      outputBytes: totalOutputBytes,
      cropCount: 0,
      tileCount: tiles.length,
      durationMs: elapsed(startedAt, options),
      outcome: "SUCCESS"
    })
  });
}
