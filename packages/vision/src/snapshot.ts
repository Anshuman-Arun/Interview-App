import { createHash } from "node:crypto";
import { z } from "zod";
import { actualUint8ArrayByteLength } from "./byte-validation.js";
import { INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION } from "./internal-artifact-construction.js";
import { assertSupportedPngHeaderParameters } from "./png-validation.js";
import {
  DEFAULT_IMAGE_VALIDATION_LIMITS,
  HARD_IMAGE_VALIDATION_LIMITS,
  ImageSnapshot,
  ImageSnapshotInputSchema,
  ImageSnapshotMetadataSchema,
  VisionPreprocessingError,
  type ImageSnapshotInput,
  type ImageValidationLimits,
  type Sha256Digest
} from "./types.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngHeader {
  readonly width: number;
  readonly height: number;
}

const ImageValidationLimitsOverrideSchema = z.object({
  maxEncodedBytes: z.number().int().positive().max(HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes).optional(),
  maxWidth: z.number().int().positive().max(HARD_IMAGE_VALIDATION_LIMITS.maxWidth).optional(),
  maxHeight: z.number().int().positive().max(HARD_IMAGE_VALIDATION_LIMITS.maxHeight).optional(),
  maxPixels: z.number().int().positive().max(HARD_IMAGE_VALIDATION_LIMITS.maxPixels).optional()
}).strict();

function asSafePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

function normalizeLimits(limits: unknown): Readonly<ImageValidationLimits> {
  if (limits !== undefined) {
    let isArray: boolean;
    try {
      isArray = Array.isArray(limits);
    } catch {
      throw new RangeError("Image validation limits could not be inspected safely");
    }
    if (typeof limits !== "object" || limits === null || isArray) {
      throw new RangeError("Image validation limits must be an object");
    }
  }
  let parsedLimits: ReturnType<typeof ImageValidationLimitsOverrideSchema.safeParse>;
  try {
    parsedLimits = ImageValidationLimitsOverrideSchema.safeParse(limits ?? {});
  } catch {
    throw new RangeError("Image validation limits could not be read safely");
  }
  if (!parsedLimits.success) throw new RangeError("Image validation limits are invalid or contain unknown keys");
  const merged = {
    ...DEFAULT_IMAGE_VALIDATION_LIMITS,
    ...parsedLimits.data
  };
  const normalized = {
    maxEncodedBytes: asSafePositiveInteger(merged.maxEncodedBytes, "maxEncodedBytes"),
    maxWidth: asSafePositiveInteger(merged.maxWidth, "maxWidth"),
    maxHeight: asSafePositiveInteger(merged.maxHeight, "maxHeight"),
    maxPixels: asSafePositiveInteger(merged.maxPixels, "maxPixels")
  };
  if (normalized.maxEncodedBytes > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes
      || normalized.maxWidth > HARD_IMAGE_VALIDATION_LIMITS.maxWidth
      || normalized.maxHeight > HARD_IMAGE_VALIDATION_LIMITS.maxHeight
      || normalized.maxPixels > HARD_IMAGE_VALIDATION_LIMITS.maxPixels) {
    throw new RangeError("Image validation limits may not exceed package hard safety caps");
  }
  return Object.freeze(normalized);
}

function inspectPngHeader(bytes: Buffer): PngHeader {
  if (bytes.length < PNG_SIGNATURE.length
      || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new VisionPreprocessingError("MIME_MISMATCH", "Image bytes do not match the declared PNG MIME type");
  }
  if (bytes.length < 29) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "PNG header is truncated");
  }

  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.toString("ascii", 12, 16);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    throw new VisionPreprocessingError("INVALID_IMAGE", "PNG does not begin with a valid IHDR chunk");
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "PNG dimensions must be positive");
  }

  try {
    assertSupportedPngHeaderParameters(bytes);
  } catch {
    throw new VisionPreprocessingError(
      "INVALID_IMAGE",
      "PNG header uses unsupported bounded-preprocessing parameters"
    );
  }
  return { width, height };
}

function checkDimensions(header: PngHeader, limits: ImageValidationLimits): void {
  if (header.width > limits.maxWidth || header.height > limits.maxHeight) {
    throw new VisionPreprocessingError("IMAGE_DIMENSIONS_EXCEEDED", "Image dimensions exceed configured limits");
  }
  const pixels = header.width * header.height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new VisionPreprocessingError("IMAGE_PIXELS_EXCEEDED", "Image pixel count exceeds configured limits");
  }
}

export function sha256ImageBytes(bytes: Uint8Array): Sha256Digest;
export function sha256ImageBytes(bytes: unknown): Sha256Digest {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Image digest input must be a Uint8Array");
  if (actualUint8ArrayByteLength(bytes) > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
    throw new RangeError("Image digest input exceeds the package hard encoded-byte cap");
  }
  return createHash("sha256").update(bytes).digest("hex");
}

export function createValidatedImageSnapshot(
  input: ImageSnapshotInput,
  limits?: Partial<ImageValidationLimits>
): ImageSnapshot {
  let parsedInput: ReturnType<typeof ImageSnapshotInputSchema.safeParse>;
  try {
    parsedInput = ImageSnapshotInputSchema.safeParse(input);
  } catch {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Image snapshot input could not be read safely");
  }
  if (!parsedInput.success) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Image snapshot input failed strict schema validation");
  }
  const safeInput = parsedInput.data;
  if (safeInput.mimeType !== "image/png") {
    throw new VisionPreprocessingError("UNSUPPORTED_IMAGE_TYPE", "Only image/png snapshots are supported");
  }

  const safeLimits = normalizeLimits(limits);
  const encodedByteLength = actualUint8ArrayByteLength(safeInput.encodedBytes);
  if (encodedByteLength === 0) {
    throw new VisionPreprocessingError("INVALID_IMAGE", "Image input must not be empty");
  }
  if (encodedByteLength > safeLimits.maxEncodedBytes) {
    throw new VisionPreprocessingError("IMAGE_TOO_LARGE_BYTES", "Encoded image exceeds configured byte limit");
  }
  const bytes = Buffer.from(safeInput.encodedBytes);

  const header = inspectPngHeader(bytes);
  checkDimensions(header, safeLimits);

  if (safeInput.declaredWidth !== undefined && safeInput.declaredWidth !== header.width) {
    throw new VisionPreprocessingError("DIMENSION_MISMATCH", "Caller-declared width does not match encoded image width");
  }
  if (safeInput.declaredHeight !== undefined && safeInput.declaredHeight !== header.height) {
    throw new VisionPreprocessingError("DIMENSION_MISMATCH", "Caller-declared height does not match encoded image height");
  }

  const metadata = ImageSnapshotMetadataSchema.parse({
    snapshotId: safeInput.snapshotId,
    sourceType: safeInput.sourceType,
    sourceRevision: safeInput.sourceRevision,
    capturedAtMs: safeInput.capturedAtMs,
    ...(safeInput.captureSequence === undefined ? {} : { captureSequence: safeInput.captureSequence }),
    width: header.width,
    height: header.height,
    mimeType: "image/png",
    encoding: "PNG",
    byteSize: bytes.length,
    contentDigest: sha256ImageBytes(bytes)
  });

  try {
    return new ImageSnapshot(INTERNAL_IMAGE_SNAPSHOT_CONSTRUCTION, metadata, bytes);
  } catch (error) {
    if (error instanceof RangeError) {
      throw new VisionPreprocessingError("INVALID_IMAGE", "PNG decoding failed validation");
    }
    throw error;
  }
}
