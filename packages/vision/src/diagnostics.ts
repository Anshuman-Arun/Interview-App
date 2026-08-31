import { z } from "zod";
import { HARD_IMAGE_VALIDATION_LIMITS, PixelDimensionsSchema } from "./types.js";
import type { PixelDimensions } from "./types.js";

export const VisionProcessingOperationSchema = z.enum([
  "CROP",
  "RESIZE",
  "TILE"
]);
export type VisionProcessingOperation = z.infer<typeof VisionProcessingOperationSchema>;

export const VisionProcessingOutcomeSchema = z.enum(["SUCCESS", "CANCELLED", "FAILURE"]);
export type VisionProcessingOutcome = z.infer<typeof VisionProcessingOutcomeSchema>;

const HARD_MAX_DIAGNOSTIC_OUTPUT_BYTES = 128 * 1024 * 1024;

const VisionDiagnosticDimensionsSchema = PixelDimensionsSchema.superRefine((dimensions, context) => {
  if (dimensions.width > HARD_IMAGE_VALIDATION_LIMITS.maxWidth
      || dimensions.height > HARD_IMAGE_VALIDATION_LIMITS.maxHeight) {
    context.addIssue({ code: "custom", message: "Vision diagnostics dimensions exceed package hard dimension caps" });
  }
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > HARD_IMAGE_VALIDATION_LIMITS.maxPixels) {
    context.addIssue({ code: "custom", message: "Vision diagnostics dimensions exceed package hard pixel cap" });
  }
});

export const VisionProcessingDiagnosticsSchema = z.object({
  operation: VisionProcessingOperationSchema,
  sourceDimensions: VisionDiagnosticDimensionsSchema,
  outputDimensions: VisionDiagnosticDimensionsSchema.optional(),
  inputBytes: z.number().int().nonnegative().max(HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes),
  outputBytes: z.number().int().nonnegative().max(HARD_MAX_DIAGNOSTIC_OUTPUT_BYTES),
  cropCount: z.number().int().nonnegative().max(1),
  tileCount: z.number().int().nonnegative().max(512),
  durationMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outcome: VisionProcessingOutcomeSchema
}).strict().superRefine((diagnostics, context) => {
  if (diagnostics.outcome !== "SUCCESS") return;

  if (diagnostics.inputBytes <= 0 || diagnostics.outputBytes <= 0) {
    context.addIssue({ code: "custom", message: "Successful processing diagnostics require nonzero image bytes" });
  }
  if ((diagnostics.operation === "CROP" || diagnostics.operation === "RESIZE")
      && diagnostics.outputBytes > HARD_IMAGE_VALIDATION_LIMITS.maxEncodedBytes) {
    context.addIssue({ code: "custom", message: "Successful single-image diagnostics exceed the package output byte cap" });
  }

  if (diagnostics.operation === "CROP") {
    if (diagnostics.cropCount !== 1 || diagnostics.tileCount !== 0 || diagnostics.outputDimensions === undefined) {
      context.addIssue({ code: "custom", message: "Successful crop diagnostics require one crop, no tiles, and output dimensions" });
    } else if (diagnostics.outputDimensions.width > diagnostics.sourceDimensions.width
        || diagnostics.outputDimensions.height > diagnostics.sourceDimensions.height) {
      context.addIssue({ code: "custom", message: "Successful crop diagnostics may not exceed source dimensions" });
    }
  } else if (diagnostics.operation === "RESIZE") {
    if (diagnostics.cropCount !== 0 || diagnostics.tileCount !== 0 || diagnostics.outputDimensions === undefined) {
      context.addIssue({ code: "custom", message: "Successful resize diagnostics require no crops/tiles and output dimensions" });
    } else if (diagnostics.outputDimensions.width > diagnostics.sourceDimensions.width
        || diagnostics.outputDimensions.height > diagnostics.sourceDimensions.height) {
      context.addIssue({ code: "custom", message: "Successful resize diagnostics may not report an upscale" });
    }
  } else if (diagnostics.cropCount !== 0 || diagnostics.tileCount <= 0 || diagnostics.outputDimensions !== undefined) {
    context.addIssue({ code: "custom", message: "Successful tile diagnostics require at least one tile and no singular output dimensions" });
  }
});
export type VisionProcessingDiagnostics = z.infer<typeof VisionProcessingDiagnosticsSchema>;

export interface VisionDiagnosticsInput {
  readonly operation: VisionProcessingOperation;
  readonly sourceDimensions: PixelDimensions;
  readonly outputDimensions?: PixelDimensions;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly cropCount: number;
  readonly tileCount: number;
  readonly durationMs: number;
  readonly outcome: VisionProcessingOutcome;
}

export function createVisionProcessingDiagnostics(input: VisionDiagnosticsInput): VisionProcessingDiagnostics {
  const parsed = VisionProcessingDiagnosticsSchema.parse(input);
  return Object.freeze({
    ...parsed,
    sourceDimensions: Object.freeze({ ...parsed.sourceDimensions }),
    ...(parsed.outputDimensions === undefined
      ? {}
      : { outputDimensions: Object.freeze({ ...parsed.outputDimensions }) })
  });
}
