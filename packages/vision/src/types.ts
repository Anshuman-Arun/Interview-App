import { createHash } from "node:crypto";
import { z } from "zod";
import { PNG } from "pngjs";
import { computeVisionArtifactId } from "./artifact-identity.js";
import { actualUint8ArrayByteLength } from "./byte-validation.js";
import {
  assertStaticPngChunkStructure,
  assertSupportedPngHeaderParameters
} from "./png-validation.js";
import { BoardRevisionSchema } from "../../domain/src/index.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SafeBoardRevisionSchema = BoardRevisionSchema.refine(
  (revision) => Number.isSafeInteger(revision),
  "Board revision must remain within JavaScript safe integer range"
);

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
  assertSupportedPngHeaderParameters(bytes);
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
  sourceRevision: SafeBoardRevisionSchema,
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

export const VisionRasterIdentitySchema = z.string().regex(/^raster_[0-9a-f]{64}$/u);
export type VisionRasterIdentity = z.infer<typeof VisionRasterIdentitySchema>;

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
  sourceRevision: SafeBoardRevisionSchema,
  sourceImageIdentity: VisionRasterIdentitySchema,
  parentArtifactId: VisionArtifactIdSchema.optional(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mimeType: ImageMimeTypeSchema,
  encoding: ImageEncodingSchema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema,
  sourceBounds: ArtifactSourceBoundsSchema,
  coordinateTransform: CoordinateTransformSchema
}).strict().superRefine((metadata, context) => {
  if (metadata.parentArtifactId === metadata.artifactId) {
    context.addIssue({ code: "custom", message: "Artifact parent ID must differ from artifact ID" });
  }
  if (metadata.kind === "CROP" || metadata.kind === "TILE") {
    if (metadata.width !== metadata.sourceBounds.width || metadata.height !== metadata.sourceBounds.height) {
      context.addIssue({ code: "custom", message: "Crop/tile output dimensions must match source bounds" });
    }
  }
  if (metadata.kind === "RESIZED") {
    if (metadata.sourceBounds.x !== 0 || metadata.sourceBounds.y !== 0) {
      context.addIssue({ code: "custom", message: "Resize source bounds must start at the source origin" });
    }
    if (metadata.width > metadata.sourceBounds.width || metadata.height > metadata.sourceBounds.height) {
      context.addIssue({ code: "custom", message: "Resize artifacts may not upscale dimensions" });
    }
    if (metadata.width === metadata.sourceBounds.width && metadata.height === metadata.sourceBounds.height) {
      context.addIssue({ code: "custom", message: "Resize artifacts must change at least one dimension" });
    }
  }
});
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

  public static isValidatedInstance(value: unknown): value is ImageSnapshot {
    return typeof value === "object"
      && value !== null
      && #bytes in value
      && Object.getPrototypeOf(value) === ImageSnapshot.prototype;
  }

  public constructor(metadata: ImageSnapshotMetadata, bytes: Uint8Array);
  public constructor(metadata: ImageSnapshotMetadata, bytes: unknown) {
    const parsed = ImageSnapshotMetadataSchema.parse(metadata);
    if (!(bytes instanceof Uint8Array)) throw new RangeError("Image payload must be a Uint8Array");
    if (actualUint8ArrayByteLength(bytes) > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
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

  public matchesEncodedBytes(candidate: unknown): boolean {
    return candidate instanceof Uint8Array
      && actualUint8ArrayByteLength(candidate) === this.#bytes.length
      && this.#bytes.equals(candidate);
  }

  public toJSON(): ImageSnapshotMetadata {
    return this.metadata;
  }
}

Object.freeze(ImageSnapshot.prototype);
Object.freeze(ImageSnapshot);

export class VisionImageArtifact {
  readonly #bytes: Buffer;
  public readonly metadata: VisionImageArtifactMetadata;

  public static isValidatedInstance(value: unknown): value is VisionImageArtifact {
    return typeof value === "object"
      && value !== null
      && #bytes in value
      && Object.getPrototypeOf(value) === VisionImageArtifact.prototype;
  }

  public constructor(metadata: VisionImageArtifactMetadata, bytes: Uint8Array);
  public constructor(metadata: VisionImageArtifactMetadata, bytes: unknown) {
    const parsed = VisionImageArtifactMetadataSchema.parse(metadata);
    const expectedArtifactId = computeVisionArtifactId({
      kind: parsed.kind,
      sourceSnapshotId: parsed.sourceSnapshotId,
      sourceRevision: parsed.sourceRevision,
      sourceImageIdentity: parsed.sourceImageIdentity,
      parentArtifactId: parsed.parentArtifactId,
      width: parsed.width,
      height: parsed.height,
      sourceBounds: parsed.sourceBounds,
      coordinateTransform: parsed.coordinateTransform,
      contentDigest: parsed.contentDigest
    });
    if (parsed.artifactId !== expectedArtifactId) {
      throw new RangeError("Vision artifact ID does not match deterministic metadata identity");
    }
    if (!(bytes instanceof Uint8Array)) throw new RangeError("Image payload must be a Uint8Array");
    if (actualUint8ArrayByteLength(bytes) > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
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

  public matchesEncodedBytes(candidate: unknown): boolean {
    return candidate instanceof Uint8Array
      && actualUint8ArrayByteLength(candidate) === this.#bytes.length
      && this.#bytes.equals(candidate);
  }

  public toJSON(): VisionImageArtifactMetadata {
    return this.metadata;
  }
}

Object.freeze(VisionImageArtifact.prototype);
Object.freeze(VisionImageArtifact);

export type VisionRasterSource = ImageSnapshot | VisionImageArtifact;

export function assertVisionRasterSource(value: unknown): asserts value is VisionRasterSource {
  if (!ImageSnapshot.isValidatedInstance(value) && !VisionImageArtifact.isValidatedInstance(value)) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Vision raster source must be a validated image snapshot or artifact");
  }
}

export function visionRasterIdentity(source: VisionRasterSource): string {
  assertVisionRasterSource(source);
  const canonical = ImageSnapshot.isValidatedInstance(source)
    ? JSON.stringify([
        "vision-raster-v1",
        "SNAPSHOT",
        source.metadata.snapshotId,
        source.metadata.sourceRevision,
        source.metadata.contentDigest
      ])
    : JSON.stringify([
        "vision-raster-v1",
        "ARTIFACT",
        source.metadata.artifactId,
        source.metadata.contentDigest
      ]);
  return VisionRasterIdentitySchema.parse(
    `raster_${createHash("sha256").update(canonical, "utf8").digest("hex")}`
  );
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

  public static isValidatedInstance(value: unknown): value is ImagePayloadReference {
    return typeof value === "object"
      && value !== null
      && #source in value
      && Object.getPrototypeOf(value) === ImagePayloadReference.prototype;
  }

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

Object.freeze(ImagePayloadReference.prototype);
Object.freeze(ImagePayloadReference);

export const ImageSnapshotInputSchema = z.object({
  snapshotId: z.string().min(1).max(128),
  sourceType: ImageSourceTypeSchema,
  sourceRevision: SafeBoardRevisionSchema,
  capturedAtMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  captureSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  mimeType: z.string().min(1).max(128),
  declaredWidth: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  declaredHeight: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  encodedBytes: z.instanceof(Uint8Array)
}).strict();
export type ImageSnapshotInput = z.infer<typeof ImageSnapshotInputSchema>;
