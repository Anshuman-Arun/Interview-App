import { z } from "zod";
import { PixelDimensionsSchema } from "./types.js";
import type { PixelDimensions } from "./types.js";

export const VisionProcessingOperationSchema = z.enum([
  "CROP",
  "RESIZE",
  "TILE"
]);
export type VisionProcessingOperation = z.infer<typeof VisionProcessingOperationSchema>;

export const VisionProcessingOutcomeSchema = z.enum(["SUCCESS", "CANCELLED", "FAILURE"]);
export type VisionProcessingOutcome = z.infer<typeof VisionProcessingOutcomeSchema>;

export const VisionProcessingDiagnosticsSchema = z.object({
  operation: VisionProcessingOperationSchema,
  sourceDimensions: PixelDimensionsSchema,
  outputDimensions: PixelDimensionsSchema.optional(),
  inputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cropCount: z.number().int().nonnegative().max(10_000),
  tileCount: z.number().int().nonnegative().max(10_000),
  durationMs: z.number().finite().nonnegative(),
  outcome: VisionProcessingOutcomeSchema
}).strict();
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
  const parsed = VisionProcessingDiagnosticsSchema.parse({
    operation: input.operation,
    sourceDimensions: input.sourceDimensions,
    ...(input.outputDimensions === undefined ? {} : { outputDimensions: input.outputDimensions }),
    inputBytes: input.inputBytes,
    outputBytes: input.outputBytes,
    cropCount: input.cropCount,
    tileCount: input.tileCount,
    durationMs: input.durationMs,
    outcome: input.outcome
  });
  return Object.freeze({
    ...parsed,
    sourceDimensions: Object.freeze({ ...parsed.sourceDimensions }),
    ...(parsed.outputDimensions === undefined
      ? {}
      : { outputDimensions: Object.freeze({ ...parsed.outputDimensions }) })
  });
}
