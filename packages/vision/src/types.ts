import { createHash } from "node:crypto";
import { z } from "zod";
import { BoardRevisionSchema, type BoardRevision } from "../../domain/src/index.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PayloadIntegrityMetadata {
  readonly width: number;
  readonly height: number;
  readonly byteSize: number;
  readonly contentDigest: string;
}

function assertPayloadIntegrity(metadata: PayloadIntegrityMetadata, bytes: Buffer): void {
  if (bytes.length !== metadata.byteSize) throw new RangeError("Image payload byte size does not match metadata");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== metadata.contentDigest) throw new RangeError("Image payload digest does not match metadata");
  if (bytes.length < 24 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new RangeError("Image payload is not a PNG");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new RangeError("Image payload has an invalid PNG header");
  }
  if (bytes.readUInt32BE(16) !== metadata.width || bytes.readUInt32BE(20) !== metadata.height) {
    throw new RangeError("Image payload dimensions do not match metadata");
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
  offsetX: z.number().finite(),
  offsetY: z.number().finite(),
  scaleX: z.number().finite().positive(),
  scaleY: z.number().finite().positive()
}).strict();
export type CoordinateTransform = z.infer<typeof CoordinateTransformSchema>;

export const ImageSnapshotMetadataSchema = z.object({
  snapshotId: z.string().min(1).max(128),
  sourceType: ImageSourceTypeSchema,
  sourceRevision: BoardRevisionSchema,
  capturedAtMs: z.number().finite().nonnegative(),
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

export const VisionImageArtifactMetadataSchema = z.object({
  artifactId: z.string().min(1).max(96),
  kind: VisionImageArtifactKindSchema,
  sourceSnapshotId: z.string().min(1).max(128),
  sourceRevision: BoardRevisionSchema,
  parentArtifactId: z.string().min(1).max(96).optional(),
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  mimeType: ImageMimeTypeSchema,
  encoding: ImageEncodingSchema,
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema,
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

export class ImageSnapshot {
  readonly #bytes: Buffer;
  public readonly metadata: ImageSnapshotMetadata;

  public constructor(metadata: ImageSnapshotMetadata, bytes: Uint8Array) {
    const parsed = ImageSnapshotMetadataSchema.parse(metadata);
    const copiedBytes = Buffer.from(bytes);
    assertPayloadIntegrity(parsed, copiedBytes);
    this.metadata = Object.freeze(parsed);
    this.#bytes = copiedBytes;
  }

  public readBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
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
    const copiedBytes = Buffer.from(bytes);
    assertPayloadIntegrity(parsed, copiedBytes);
    this.metadata = Object.freeze({
      ...parsed,
      coordinateTransform: Object.freeze({ ...parsed.coordinateTransform })
    });
    this.#bytes = copiedBytes;
  }

  public readBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }

  public toJSON(): VisionImageArtifactMetadata {
    return this.metadata;
  }
}

export type VisionRasterSource = ImageSnapshot | VisionImageArtifact;

export const ImagePayloadReferenceMetadataSchema = z.object({
  imageIdentity: z.string().min(1).max(160),
  mimeType: ImageMimeTypeSchema,
  width: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  height: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  byteSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  contentDigest: Sha256DigestSchema
}).strict();
export type ImagePayloadReferenceMetadata = z.infer<typeof ImagePayloadReferenceMetadataSchema>;

export class ImagePayloadReference {
  readonly #bytes: Buffer;
  public readonly metadata: ImagePayloadReferenceMetadata;

  public constructor(metadata: ImagePayloadReferenceMetadata, bytes: Uint8Array) {
    const parsed = ImagePayloadReferenceMetadataSchema.parse(metadata);
    const copiedBytes = Buffer.from(bytes);
    assertPayloadIntegrity(parsed, copiedBytes);
    this.metadata = Object.freeze(parsed);
    this.#bytes = copiedBytes;
  }

  public readBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }

  public toJSON(): ImagePayloadReferenceMetadata {
    return this.metadata;
  }
}

export interface ImageSnapshotInput {
  readonly snapshotId: string;
  readonly sourceType: ImageSourceType;
  readonly sourceRevision: BoardRevision;
  readonly capturedAtMs: number;
  readonly captureSequence?: number;
  readonly mimeType: string;
  readonly declaredWidth?: number;
  readonly declaredHeight?: number;
  readonly encodedBytes: Uint8Array;
}
