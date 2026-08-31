import { createHash } from "node:crypto";
import { z } from "zod";
import { PNG } from "pngjs";
import { BoardRevisionSchema, type BoardRevision } from "../../domain/src/index.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const UNSUPPORTED_APNG_CHUNKS = new Set(["acTL", "fcTL", "fdAT"]);

const SUPPORTED_PNG_BIT_DEPTHS = new Map<number, ReadonlySet<number>>([
  [0, new Set([1, 2, 4, 8])],
  [2, new Set([8])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8])],
  [6, new Set([8])]
]);

function assertSupportedPngHeader(bytes: Buffer): void {
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const compressionMethod = bytes[26];
  const filterMethod = bytes[27];
  const interlaceMethod = bytes[28];
  if (bitDepth === undefined
      || colorType === undefined
      || compressionMethod === undefined
      || filterMethod === undefined
      || interlaceMethod === undefined) {
    throw new RangeError("PNG IHDR is truncated");
  }
  if (compressionMethod !== 0 || filterMethod !== 0) {
    throw new RangeError("PNG uses an unsupported compression or filter method");
  }
  if (interlaceMethod !== 0) {
    throw new RangeError("Interlaced PNG payloads are unsupported for bounded preprocessing");
  }
  if (SUPPORTED_PNG_BIT_DEPTHS.get(colorType)?.has(bitDepth) !== true) {
    throw new RangeError("PNG color type or bit depth is unsupported for bounded preprocessing");
  }
}



function assertStaticPngChunkStructure(bytes: Buffer): void {
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let foundEnd = false;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new RangeError("PNG contains a truncated chunk");
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + chunkLength;
    if (!Number.isSafeInteger(nextOffset) || nextOffset > bytes.length) {
      throw new RangeError("PNG chunk length exceeds encoded payload bounds");
    }
    if (chunkIndex === 0 && (chunkType !== "IHDR" || chunkLength !== 13)) {
      throw new RangeError("PNG must begin with exactly one IHDR chunk");
    }
    if (chunkIndex > 0 && chunkType === "IHDR") {
      throw new RangeError("PNG contains multiple IHDR chunks");
    }
    if (UNSUPPORTED_APNG_CHUNKS.has(chunkType)) {
      throw new RangeError("Animated PNG chunks are unsupported");
    }
    if (chunkType === "IEND") {
      if (chunkLength !== 0) throw new RangeError("PNG IEND chunk must be empty");
      if (nextOffset !== bytes.length) throw new RangeError("PNG contains trailing bytes after IEND");
      foundEnd = true;
      break;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }

  if (!foundEnd) throw new RangeError("PNG is missing its terminal IEND chunk");
}

interface PayloadIntegrityMetadata {
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly contentDigest: string;
}

function assertPayloadIntegrity(metadata: PayloadIntegrityMetadata, bytes: Buffer): void {
  if (bytes.length !== metadata.byteSize) throw new RangeError("Image payload byte size does not match metadata");
  if (bytes.length > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes
      || metadata.width > HARD_IMAGE_VALIDATION_LIMITS.maxWidth
      || metadata.height > HARD_IMAGE_VALIDATION_LIMITS.maxHeight) {
    throw new RangeError("Image payload exceeds package hard size or dimension caps");
  }
  const pixels = metadata.width * metadata.height;
  if (!Number.isSafeInteger(pixels) || pixels > HARD_IMAGE_VALIDATION_LIMITS.maxPixels) {
    throw new RangeError("Image payload exceeds the package hard pixel cap");
  }
  if (bytes.length < 29 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new RangeError("Image payload is not a PNG");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new RangeError("Image payload has an invalid PNG header");
  }
  if (bytes.readUInt32BE(16) !== metadata.width || bytes.readUInt32BE(20) !== metadata.height) {
    throw new RangeError("Image payload dimensions do not match metadata");
  }
  assertSupportedPngHeader(bytes);
  assertStaticPngChunkStructure(bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== metadata.contentDigest) throw new RangeError("Image payload digest does not match metadata");

  let decoded: ReturnType<typeof PNG.sync.read>;
  try {
    decoded = PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new RangeError("Image payload is not a valid decodable PNG");
  }
  const decodedBytes = metadata.width * metadata.height * 4;
  if (decoded.width !== metadata.width
      || decoded.height !== metadata.height
      || !Number.isSafeInteger(decodedBytes)
      || decoded.data.length !== decodedBytes) {
    throw new RangeError("Decoded PNG raster does not match image payload metadata");
  }
}

export const ImageMimeTypeSchema = z.literal("image/png");
export type ImageMimeType = z.infer<typeof ImageMimeTypeSchema>;

export const ImageEncodingSchema = z.literal("PNG");
export type ImageEncoding = z.infer<typeof ImageEncodingSchema>;

export const ImageSourceTypeSchema = z.enum([
  "WHITEBOARD_SNAPSHOT",
  "BROWSER_SCREENSHOT",
  "OTHER_CAPTURE"
]);
export type ImageSourceType = z.infer<typeof ImageSourceTypeSchema>;

export const Sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export type Sha256Digest = z.infer<typeof Sha256DigestSchema>;

export const PixelDimensionsSchema = z.object({
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type PixelDimensions = z.infer<typeof PixelDimensionsSchema>;

export const CoordinateTransformSchema = z.object({
  offsetX: z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  offsetY: z.number().finite().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  scaleX: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER),
  scaleY: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type CoordinateTransform = z.infer<typeof CoordinateTransformSchema>;

export const ImageSnapshotMetadataSchema = z.object({
  snapshotId: z.string().min(1).max(128),
  sourceType: ImageSourceTypeSchema,
  sourceRevision: BoardRevisionSchema,
  capturedAtMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  captureSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mimeType: ImageMimeTypeSchema,
  encoding: ImageEncodingSchema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema
}).strict();
export type ImageSnapshotMetadata = z.infer<typeof ImageSnapshotMetadataSchema>;

export const VisionImageArtifactKindSchema = z.enum(["CROP", "RESIZED", "TILE"]);
export type VisionImageArtifactKind = z.infer<typeof VisionImageArtifactKindSchema>;

export const VisionArtifactIdSchema = z.string().regex(/^img_[0-9a-f]{64}$/u);
export type VisionArtifactId = z.infer<typeof VisionArtifactIdSchema>;

export const ArtifactSourceBoundsSchema = z.object({
  x: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  y: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict().superRefine((bounds, context) => {
  if (!Number.isSafeInteger(bounds.x + bounds.width)) {
    context.addIssue({ code: "custom", message: "sourceBounds right edge exceeds safe integer range" });
  }
  if (!Number.isSafeInteger(bounds.y + bounds.height)) {
    context.addIssue({ code: "custom", message: "sourceBounds bottom edge exceeds safe integer range" });
  }
});
export type ArtifactSourceBounds = z.infer<typeof ArtifactSourceBoundsSchema>;

export const VisionImageArtifactMetadataSchema = z.object({
  artifactId: VisionArtifactIdSchema,
  kind: VisionImageArtifactKindSchema,
  sourceSnapshotId: z.string().min(1).max(128),
  sourceRevision: BoardRevisionSchema,
  parentArtifactId: VisionArtifactIdSchema.optional(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mimeType: ImageMimeTypeSchema,
  encoding: ImageEncodingSchema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema,
  sourceBounds: ArtifactSourceBoundsSchema,
  coordinateTransform: CoordinateTransformSchema
}).strict();
export type VisionImageArtifactMetadata = z.infer<typeof VisionImageArtifactMetadataSchema>;

export const VisionPreprocessingErrorCodeSchema = z.enum([
  "UNSUPPORTED_IMAGE_TYPE",
  "MIME_MISMATCH",
  "INVALID_IMAGE",
  "IMAGE_TOO_LARGE_BYTES",
  "IMAGE_DIMENSIONS_EXCEEDED",
  "IMAGE_PIXELS_EXCEEDED",
  "DIMENSION_MISMATCH",
  "INVALID_RECTANGLE",
  "OUT_OF_BOUNDS",
  "DIRTY_PLAN_EXCEEDS_BUDGET",
  "TILE_LIMIT_EXCEEDED",
  "OUTPUT_TOO_LARGE_BYTES",
  "REQUEST_BUDGET_EXCEEDED",
  "CANCELLED"
]);
export type VisionPreprocessingErrorCode = z.infer<typeof VisionPreprocessingErrorCodeSchema>;

export class VisionPreprocessingError extends Error {
  public readonly code: VisionPreprocessingErrorCode;

  public constructor(code: VisionPreprocessingErrorCode, message: string) {
    super(message);
    this.name = "VisionPreprocessingError";
    this.code = code;
  }
}

export interface ImageValidationLimits {
  readonly maxEncodedBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

export const DEFAULT_IMAGE_VALIDATION_LIMITS: Readonly<ImageValidationLimits> = Object.freeze({
  maxEncodedBytes: 16 * 1024 * 1024,
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 32 * 1024 * 1024
});

export const HARD_IMAGE_VALIDATION_LIMITS: Readonly<ImageValidationLimits> = Object.freeze({
  maxEncodedBytes: 64 * 1024 * 1024,
  maxWidth: 16_384,
  maxHeight: 16_384,
  maxPixels: 64 * 1024 * 1024
});

export class ImageSnapshot {
  readonly #bytes: Buffer;
  public readonly metadata: ImageSnapshotMetadata;

  public constructor(metadata: ImageSnapshotMetadata, bytes: Uint8Array) {
    const parsed = ImageSnapshotMetadataSchema.parse(metadata);
    if (!(bytes instanceof Uint8Array)) throw new RangeError("Image payload must be a Uint8Array");
    if (bytes.byteLength > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
      throw new RangeError("Image payload exceeds the package hard encoded-byte cap");
    }
    const copiedBytes = Buffer.from(bytes);
    assertPayloadIntegrity(parsed, copiedBytes);
    this.metadata = Object.freeze(parsed);
    this.#bytes = copiedBytes;
    Object.freeze(this);
  }

  public readBytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  public matchesEncodedBytes(candidate: Uint8Array): boolean {
    return candidate instanceof Uint8Array
      && candidate.byteLength === this.#bytes.length
      && this.#bytes.equals(candidate);
  }

  public toJSON(): ImageSnapshotMetadata {
    return this.metadata;
  }
}

export class VisionImageArtifact {
  readonly #bytes: Buffer;
  public readonly metadata: VisionImageArtifactMetadata;

  public constructor(metadata: VisionImageArtifactMetadata, bytes: Uint8Array) {
    const parsed = VisionImageArtifactMetadataSchema.parse(metadata);
    if (!(bytes instanceof Uint8Array)) throw new RangeError("Image payload must be a Uint8Array");
    if (bytes.byteLength > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
      throw new RangeError("Image payload exceeds the package hard encoded-byte cap");
    }
    const copiedBytes = Buffer.from(bytes);
    assertPayloadIntegrity(parsed, copiedBytes);
    this.metadata = Object.freeze({
      ...parsed,
      sourceBounds: Object.freeze({ ...parsed.sourceBounds }),
      coordinateTransform: Object.freeze({ ...parsed.coordinateTransform })
    });
    this.#bytes = copiedBytes;
    Object.freeze(this);
  }

  public readBytes(): Buffer {
    return Buffer.from(this.#bytes);
  }

  public matchesEncodedBytes(candidate: Uint8Array): boolean {
    return candidate instanceof Uint8Array
      && candidate.byteLength === this.#bytes.length
      && this.#bytes.equals(candidate);
  }

  public toJSON(): VisionImageArtifactMetadata {
    return this.metadata;
  }
}

export type VisionRasterSource = ImageSnapshot | VisionImageArtifact;

export function assertVisionRasterSource(value: unknown): asserts value is VisionRasterSource {
  if (!(value instanceof ImageSnapshot) && !(value instanceof VisionImageArtifact)) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Vision raster source must be a validated image snapshot or artifact");
  }
}

export function visionRasterIdentity(source: VisionRasterSource): string {
  if (source instanceof ImageSnapshot) {
    return `snapshot:${source.metadata.snapshotId}:${source.metadata.contentDigest}`;
  }
  return `artifact:${source.metadata.artifactId}:${source.metadata.contentDigest}`;
}

export const ImagePayloadReferenceMetadataSchema = z.object({
  imageIdentity: z.string().min(1).max(256),
  mimeType: ImageMimeTypeSchema,
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema
}).strict();
export type ImagePayloadReferenceMetadata = z.infer<typeof ImagePayloadReferenceMetadataSchema>;

export class ImagePayloadReference {
  readonly #source: VisionRasterSource;
  public readonly metadata: ImagePayloadReferenceMetadata;

  public constructor(sourceInput: VisionRasterSource) {
    assertVisionRasterSource(sourceInput);
    this.metadata = Object.freeze(ImagePayloadReferenceMetadataSchema.parse({
      imageIdentity: visionRasterIdentity(sourceInput),
      mimeType: sourceInput.metadata.mimeType,
      width: sourceInput.metadata.width,
      height: sourceInput.metadata.height,
      byteSize: sourceInput.metadata.byteSize,
      contentDigest: sourceInput.metadata.contentDigest
    }));
    this.#source = sourceInput;
    Object.freeze(this);
  }

  public readBytes(): Buffer {
    return this.#source.readBytes();
  }

  public toJSON(): ImagePayloadReferenceMetadata {
    return this.metadata;
  }
}

export const ImageSnapshotInputSchema = z.object({
  snapshotId: z.string().min(1).max(128),
  sourceType: ImageSourceTypeSchema,
  sourceRevision: BoardRevisionSchema,
  capturedAtMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  captureSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  mimeType: z.string().min(1).max(128),
  declaredWidth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  declaredHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  encodedBytes: z.instanceof(Uint8Array)
}).strict();
export type ImageSnapshotInput = z.infer<typeof ImageSnapshotInputSchema>;
