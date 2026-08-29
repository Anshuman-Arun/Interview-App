import { z } from "zod";
import { RequestIdSchema } from "../../domain/src/index.js";

export const LocalComputeProtocolVersionSchema = z.literal(1);
export const LocalComputeOperationSchema = z.enum(["HEALTH_CHECK", "ANALYZE_TRANSCRIPT"]);
export type LocalComputeOperation = z.infer<typeof LocalComputeOperationSchema>;

const WorkerRequestBaseSchema = z.object({
  protocolVersion: LocalComputeProtocolVersionSchema,
  requestId: RequestIdSchema
});

export const WorkerHealthCheckRequestSchema = WorkerRequestBaseSchema.extend({
  type: z.literal("HEALTH_CHECK")
}).strict();

export const WorkerTranscriptAnalysisRequestSchema = WorkerRequestBaseSchema.extend({
  type: z.literal("ANALYZE_TRANSCRIPT"),
  sourceRevision: z.number().int().nonnegative(),
  text: z.string().min(1).max(20_000)
}).strict();

export const LocalComputeRequestSchema = z.discriminatedUnion("type", [
  WorkerHealthCheckRequestSchema,
  WorkerTranscriptAnalysisRequestSchema
]);
export type LocalComputeRequest = z.infer<typeof LocalComputeRequestSchema>;

const WorkerResponseBaseSchema = z.object({
  protocolVersion: LocalComputeProtocolVersionSchema,
  requestId: RequestIdSchema
});

export const WorkerHealthResultSchema = WorkerResponseBaseSchema.extend({
  type: z.literal("HEALTH_RESULT"),
  workerVersion: z.string().min(1),
  capabilities: z.array(LocalComputeOperationSchema)
}).strict();

export const WorkerTranscriptAnalysisResultSchema = WorkerResponseBaseSchema.extend({
  type: z.literal("TRANSCRIPT_ANALYSIS_RESULT"),
  sourceRevision: z.number().int().nonnegative(),
  normalizedText: z.string(),
  tokenCount: z.number().int().nonnegative()
}).strict();

export const WorkerErrorResultSchema = WorkerResponseBaseSchema.extend({
  type: z.literal("WORKER_ERROR"),
  code: z.enum(["INVALID_REQUEST", "REQUEST_ID_CONFLICT", "UNSUPPORTED_OPERATION", "INTERNAL_ERROR"]),
  message: z.string().min(1).max(200)
}).strict();

export const LocalComputeResponseSchema = z.discriminatedUnion("type", [
  WorkerHealthResultSchema,
  WorkerTranscriptAnalysisResultSchema,
  WorkerErrorResultSchema
]);
export type LocalComputeResponse = z.infer<typeof LocalComputeResponseSchema>;
export type LocalComputeSuccessResponse = Exclude<LocalComputeResponse, z.infer<typeof WorkerErrorResultSchema>>;

export const LocalProcessInterruptionSchema = z.object({
  semantics: z.literal("INTERRUPT_LOCAL_PROCESS"),
  signalSent: z.boolean()
}).strict();
export type LocalProcessInterruption = z.infer<typeof LocalProcessInterruptionSchema>;
